#!/usr/bin/env python3
import argparse
import csv
import datetime
import importlib.util
import json
import os
import sys
import time
from decimal import Decimal, ROUND_HALF_UP

sys.dont_write_bytecode = True

def _env(name, default):
    return os.environ.get(name, default)


def _settings(database):
    return dict(host=_env("DB_HOST", "localhost"), port=int(_env("DB_PORT", "3306")),
                user=_env("DB_USER", "etl_user"), password=_env("DB_PASSWORD", ""),
                database=database, charset="utf8mb4")


SRC_DB = _env("SRC_DB", "financedata")
DWH_DB = _env("DWH_DB", "stadvdb_dw")
OLAP_FILE = _env("OLAP_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                           "OLAP_queries.py"))
LOG_FILE = "functional_test_log.csv"

ALL_PARAMS = ["level", "date_from", "date_to", "region", "year_from", "year_to", "txn_type", "measure",
              "group_by", "phase", "health", "duration", "year", "top_n"]
YEARS = [1993, 1994, 1995, 1996, 1997, 1998]
CENT = Decimal("0.01")
TOLERANCE = Decimal("0.011")

CONTROL = {"transactions": 1056320, "net_cash_flow": Decimal("197151288.70"), "loans": 682,
           "loan_amount": Decimal("103261740.00"), "accounts": 4500}


def d2(value):
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def money(cents):
    return d2(Decimal(cents) / 100)


def ci(text):
    return (text or "").lower()

def load_reports(path):

    sys.dont_write_bytecode = True
    if not os.path.isfile(path):
        raise SystemExit("OLAP file not found: %s\nPut STADVDB-MCO1-GroupN-OLAP.py next to this script or "
                         "set OLAP_FILE to its path." % path)
    spec = importlib.util.spec_from_file_location("OLAP_queries", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    reports = getattr(module, "REPORT_SQL", None)
    if not isinstance(reports, dict) or not reports:
        raise SystemExit("%s does not define REPORT_SQL, so it is not the new OLAP script (it may be an older "
                         "copy or the .sql file renamed).\nReplace it with the latest "
                         "STADVDB-MCO1-GroupN-OLAP.py, or point OLAP_FILE at that file." % path)
    return dict(reports)

class Oracle:
    def __init__(self, trans_rows, account_rows, loan_rows, status_rows):
        self.facts = []
        for account_id, newdate, type_, operation, amount, k_symbol in trans_rows:
            typ = "Credit" if type_ == "Credit" else "Debit"
            op = operation.strip() or "N/A"
            ks = k_symbol.strip() or "N/A"
            cents = int(round(float(amount) * 100))
            self.facts.append((account_id, _iso(newdate), typ, op, ks, cents,
                               cents if typ == "Credit" else -cents))
        self.acct = {r[0]: (r[1], r[2], r[3], r[4]) for r in account_rows}
        self.status = {}
        for code, description in status_rows:
            phase = "Finished" if code in "AB" else "Running"
            health = "Good" if code in "AC" else "Bad"
            self.status[code] = (description, phase, health)
        self.loans = [(r[0], _iso(r[1]), r[2], int(r[3]), int(round(float(r[4]) * 100)),
                       int(round(float(r[5]) * 100))) for r in loan_rows]

    def r1(self, level, date_from, date_to, region):
        if level not in ("year", "quarter", "month", "day"):
            return []
        low, high = date_from or "1993-01-01", date_to or "1998-12-31"
        groups = {}
        for acct, day, typ, _op, _ks, cents, signed in self.facts:
            if day < low or day > high:
                continue
            if region is not None and self.acct[acct][0] != region:
                continue
            year, month = int(day[:4]), int(day[5:7])
            label = {"year": str(year), "quarter": "%d-Q%d" % (year, (month - 1) // 3 + 1),
                     "month": day[:7], "day": day}[level]
            rec = groups.setdefault(label, [day, 0, 0, 0, 0])
            rec[0] = min(rec[0], day)
            rec[1] += 1
            if typ == "Credit":
                rec[2] += cents
            else:
                rec[3] += cents
            rec[4] += signed
        rows, cumulative, previous = [], 0, None
        for label, (start, count, credit, debit, net) in sorted(groups.items(), key=lambda kv: kv[1][0]):
            cumulative += net
            change = None
            if previous not in (None, 0):
                change = d2(Decimal(100) * (Decimal(net - previous) / Decimal(abs(previous))))
            rows.append((label, count, money(credit), money(debit), money(net), money(cumulative), change))
            previous = net
        return rows

    def r2(self, year_from, year_to, txn_type, region):
        low, high = year_from or 1993, year_to or 1998
        cells = {}
        for acct, day, typ, _op, _ks, cents, signed in self.facts:
            if not (low <= int(day[:4]) <= high):
                continue
            if txn_type is not None and typ != txn_type:
                continue
            reg, district, _freq, salary = self.acct[acct]
            if region is not None and reg != region:
                continue
            rec = cells.setdefault((reg, district), [set(), 0, 0, 0, salary])
            rec[0].add(acct)
            rec[1] += 1
            rec[2] += cents
            rec[3] += signed
        rows, grand = [], [set(), 0, 0, 0]
        for reg in sorted({k[0] for k in cells}, key=ci):
            sub = [set(), 0, 0, 0]
            districts = sorted((k for k in cells if k[0] == reg), key=lambda k: (-cells[k][2], ci(k[1])))
            for key in districts:
                accounts, count, amount, net, salary = cells[key]
                rows.append((reg, key[1], "district", len(accounts), count, money(amount), money(net),
                             self._per(amount, len(accounts)), Decimal(salary)))
                for i, part in enumerate((accounts, count, amount, net)):
                    sub[i] = sub[i] | part if i == 0 else sub[i] + part
            rows.append((reg, "ALL DISTRICTS", "region subtotal", len(sub[0]), sub[1], money(sub[2]),
                         money(sub[3]), self._per(sub[2], len(sub[0])), None))
            for i in range(4):
                grand[i] = grand[i] | sub[i] if i == 0 else grand[i] + sub[i]
        if rows:
            rows.append(("ALL REGIONS", None, "grand total", len(grand[0]), grand[1], money(grand[2]),
                         money(grand[3]), self._per(grand[2], len(grand[0])), None))
        return rows

    @staticmethod
    def _per(cents, accounts):
        return d2(Decimal(cents) / 100 / Decimal(accounts))

    def r3(self, measure, txn_type, region):
        if measure not in ("amount", "count"):
            return []
        cells = {}
        for acct, day, typ, op, _ks, cents, _signed in self.facts:
            if txn_type is not None and typ != txn_type:
                continue
            if region is not None and self.acct[acct][0] != region:
                continue
            row = cells.setdefault(op, {y: 0 for y in YEARS})
            row[int(day[:4])] += cents if measure == "amount" else 1
        rows = []
        totals = {y: 0 for y in YEARS}
        for op in sorted(cells, key=ci):
            values = [cells[op][y] for y in YEARS]
            rows.append((op,) + tuple(self._cell(v, measure) for v in values) + (self._cell(sum(values), measure),))
            for y in YEARS:
                totals[y] += cells[op][y]
        if rows:
            values = [totals[y] for y in YEARS]
            rows.append(("ALL OPERATIONS",) + tuple(self._cell(v, measure) for v in values)
                        + (self._cell(sum(values), measure),))
        return rows

    @staticmethod
    def _cell(value, measure):
        return money(value) if measure == "amount" else Decimal(value)

    def r4(self, group_by, phase, health, region, year_from, year_to, duration):
        if group_by not in ("region", "status", "duration", "year"):
            return []
        low, high = year_from or 1993, year_to or 1998
        groups = {}
        for acct, day, status, months, amount, payment in self.loans:
            desc, ph, hl = self.status[status]
            reg = self.acct[acct][0]
            if phase is not None and ph != phase:
                continue
            if health is not None and hl != health:
                continue
            if region is not None and reg != region:
                continue
            if not (low <= int(day[:4]) <= high):
                continue
            if duration is not None and months != duration:
                continue
            label = {"region": reg, "status": "%s - %s" % (status, desc), "duration": "%d months" % months,
                     "year": day[:4]}[group_by]
            rec = groups.setdefault(label, [0, 0, 0, 0])
            rec[0] += 1
            rec[1] += amount
            rec[2] += payment
            rec[3] += 1 if hl == "Bad" else 0
        grand = sum(rec[1] for rec in groups.values())
        rows = []
        for label in sorted(groups, key=ci):
            count, amount, payment, bad = groups[label]
            rows.append((label, count, money(amount), d2(Decimal(amount) / 100 / count), money(payment), bad,
                         d2(Decimal(100) * bad / count), d2(Decimal(100) * amount / grand)))
        return rows

    def r5(self, region, year, top_n):
        totals = {}
        for acct, day, typ, _op, _ks, cents, signed in self.facts:
            if year is not None and int(day[:4]) != year:
                continue
            reg, district, freq, _sal = self.acct[acct]
            if region is not None and reg != region:
                continue
            rec = totals.setdefault(acct, [reg, district, freq, 0, 0, 0, 0])
            rec[3] += 1
            if typ == "Credit":
                rec[4] += cents
            else:
                rec[5] += cents
            rec[6] += signed
        limit = top_n if top_n is not None else 5
        rows = []
        for reg in sorted({v[0] for v in totals.values()}, key=ci):
            members = sorted(((a, v) for a, v in totals.items() if v[0] == reg), key=lambda av: (-av[1][6], av[0]))
            rank, previous_net = 0, None
            for position, (acct, v) in enumerate(members, start=1):
                if v[6] != previous_net:
                    rank, previous_net = position, v[6]
                if rank <= limit:
                    rows.append((reg, rank, acct, v[1], v[2], v[3], money(v[4]), money(v[5]), money(v[6])))
        return rows

    def r6(self, year, region, txn_type):
        cells = {}
        for acct, day, typ, op, ks, cents, _signed in self.facts:
            if year is not None and int(day[:4]) != year:
                continue
            if region is not None and self.acct[acct][0] != region:
                continue
            if txn_type is not None and typ != txn_type:
                continue
            rec = cells.setdefault((typ, op, ks), [0, 0])
            rec[0] += 1
            rec[1] += cents
        rows, grand = [], [0, 0]
        for typ in sorted({k[0] for k in cells}, key=ci):
            type_sum = [0, 0]
            for op in sorted({k[1] for k in cells if k[0] == typ}, key=ci):
                op_sum = [0, 0]
                for ks in sorted({k[2] for k in cells if k[0] == typ and k[1] == op}, key=ci):
                    count, amount = cells[(typ, op, ks)]
                    rows.append((typ, op, ks, "detail", count, money(amount), self._avg(amount, count)))
                    op_sum = [op_sum[0] + count, op_sum[1] + amount]
                rows.append((typ, op, "ALL PURPOSES", "operation subtotal", op_sum[0], money(op_sum[1]),
                             self._avg(op_sum[1], op_sum[0])))
                type_sum = [type_sum[0] + op_sum[0], type_sum[1] + op_sum[1]]
            rows.append((typ, "ALL OPERATIONS", None, "type subtotal", type_sum[0], money(type_sum[1]),
                         self._avg(type_sum[1], type_sum[0])))
            grand = [grand[0] + type_sum[0], grand[1] + type_sum[1]]
        if rows:
            rows.append(("ALL TYPES", None, None, "grand total", grand[0], money(grand[1]),
                         self._avg(grand[1], grand[0])))
        return rows

    @staticmethod
    def _avg(cents, count):
        return d2(Decimal(cents) / 100 / count)

    def r7(self, year_from, year_to, region):
        low, high = year_from or 1993, year_to or 1998
        accounts, txn, loans = {}, {}, {}
        for acct, (reg, _d, _f, _s) in self.acct.items():
            if region is None or reg == region:
                accounts[reg] = accounts.get(reg, 0) + 1
        for acct, day, _typ, _op, _ks, _cents, signed in self.facts:
            reg = self.acct[acct][0]
            if (region is not None and reg != region) or not (low <= int(day[:4]) <= high):
                continue
            rec = txn.setdefault(reg, [0, 0])
            rec[0] += 1
            rec[1] += signed
        for acct, day, status, _m, amount, _p in self.loans:
            reg = self.acct[acct][0]
            if (region is not None and reg != region) or not (low <= int(day[:4]) <= high):
                continue
            rec = loans.setdefault(reg, [0, 0, 0])
            rec[0] += 1
            rec[1] += amount
            rec[2] += 1 if self.status[status][2] == "Bad" else 0
        rows = []
        for reg in sorted(accounts, key=ci):
            n = accounts[reg]
            count, net = txn.get(reg, [0, 0])
            loan_count, loan_amount, bad = loans.get(reg, [0, 0, 0])
            rows.append((reg, n, count, money(net), d2(Decimal(net) / 100 / n), loan_count, money(loan_amount),
                         bad, d2(Decimal(100) * loan_count / n)))
        return rows

def _iso(value):
    return value if isinstance(value, str) else value.isoformat()

TOLERANT = {"R1": {6}, "R2": {7}, "R4": {3, 6, 7}, "R6": {6}, "R7": {4, 8}}


def build_oracle(src):
    cur = src.cursor()
    cur.execute("SELECT account_id, newdate, `type`, operation, amount, k_symbol FROM trans")
    trans = []
    while True:
        chunk = cur.fetchmany(50000)
        if not chunk:
            break
        trans.extend(chunk)
    cur.close()
    accounts = _query(src, "SELECT a.account_id, d.region, d.district_name, a.frequency, d.average_salary "
                           "FROM account a JOIN district d ON d.district_id = a.district_id")
    loans = _query(src, "SELECT account_id, newdate, status, duration, amount, payments FROM loan")
    statuses = _query(src, "SELECT status, description FROM ref_loanstatus")
    return Oracle(trans, accounts, loans, statuses)


def _query(conn, sql):
    cur = conn.cursor()
    cur.execute(sql)
    rows = cur.fetchall()
    cur.close()
    return rows

def normalise(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float, Decimal)):
        return d2(Decimal(str(value)))
    return str(value)


def compare(report_key, expected, actual):
    if len(expected) != len(actual):
        return "expected %d rows but the report returned %d" % (len(expected), len(actual))
    tolerant = TOLERANT.get(report_key, set())
    for i, (want_row, got_row) in enumerate(zip(expected, actual), start=1):
        if len(want_row) != len(got_row):
            return "row %d has %d columns, expected %d" % (i, len(got_row), len(want_row))
        for j, (want, got) in enumerate(zip(want_row, got_row)):
            w, g = normalise(want), normalise(got)
            if isinstance(w, Decimal) and isinstance(g, Decimal) and j in tolerant:
                if abs(w - g) <= TOLERANCE:
                    continue
            elif w == g:
                continue
            return "row %d, column %d: expected %s, got %s" % (i, j + 1, w, g)
    return ""

def run_report(conn, sql, params):
    cur = conn.cursor()
    cur.execute(sql, {name: params.get(name) for name in ALL_PARAMS})
    rows = cur.fetchall()
    cur.close()
    return rows

CASES = [
    # R1
    ("T01", "R1", "R1_cash_flow_trend", "roll-up", {"level": "year"}, "yearly totals, whole range (top of the date hierarchy)"),
    ("T02", "R1", "R1_cash_flow_trend", "drill-down + dice", {"level": "quarter", "date_from": "1997-01-01", "date_to": "1997-12-31"}, "quarters of 1997"),
    ("T03", "R1", "R1_cash_flow_trend", "drill-down + slice", {"level": "month", "date_from": "1996-01-01", "date_to": "1996-12-31", "region": "Prague"}, "months of 1996 for one region"),
    ("T04", "R1", "R1_cash_flow_trend", "drill-down", {"level": "day", "date_from": "1998-12-01", "date_to": "1998-12-31"}, "days of December 1998 (lowest level)"),
    ("T05", "R1", "R1_cash_flow_trend", "boundary", {"level": "month", "date_from": "1993-01-01", "date_to": "1993-01-31"}, "first month of the data (no previous period)"),
    ("T06", "R1", "R1_cash_flow_trend", "invalid input", {"level": "week"}, "unknown level returns no rows"),
    ("T07", "R1", "R1_cash_flow_trend", "empty range", {"level": "year", "date_from": "1999-01-01", "date_to": "1999-12-31"}, "dates after the data return no rows"),
    # R2
    ("T08", "R2", "R2_regional_rollup", "roll-up + drill-down", {}, "all regions with district rows, subtotals and grand total"),
    ("T09", "R2", "R2_regional_rollup", "dice + slice", {"year_from": 1996, "year_to": 1998, "txn_type": "Credit"}, "credits 1996-1998"),
    ("T10", "R2", "R2_regional_rollup", "drill-down + slice", {"region": "south Moravia", "txn_type": "Debit"}, "districts of one region, debits only"),
    # R3
    ("T11", "R3", "R3_operation_by_year_pivot", "pivot", {"measure": "amount"}, "amount by operation and year"),
    ("T12", "R3", "R3_operation_by_year_pivot", "pivot + slice", {"measure": "count", "txn_type": "Credit"}, "credit counts by operation and year"),
    ("T13", "R3", "R3_operation_by_year_pivot", "pivot + dice", {"measure": "amount", "txn_type": "Debit", "region": "Prague"}, "Prague debits"),
    # R4
    ("T14", "R4", "R4_loan_portfolio", "roll-up (by region)", {"group_by": "region"}, "loans by region"),
    ("T15", "R4", "R4_loan_portfolio", "drill-down (by status)", {"group_by": "status"}, "loans by status A-D"),
    ("T16", "R4", "R4_loan_portfolio", "roll-up (by duration)", {"group_by": "duration"}, "loans by term"),
    ("T17", "R4", "R4_loan_portfolio", "roll-up (by year)", {"group_by": "year"}, "loans by grant year"),
    ("T18", "R4", "R4_loan_portfolio", "dice", {"group_by": "region", "phase": "Running", "year_from": 1996, "year_to": 1997}, "running loans granted 1996-1997"),
    ("T19", "R4", "R4_loan_portfolio", "slice", {"group_by": "status", "health": "Bad"}, "only loans with problems"),
    ("T20", "R4", "R4_loan_portfolio", "dice", {"group_by": "year", "duration": 24, "region": "north Moravia"}, "24-month loans in one region"),
    ("T21", "R4", "R4_loan_portfolio", "invalid input", {"group_by": "colour"}, "unknown grouping returns no rows"),
    # R5
    ("T22", "R5", "R5_top_accounts_by_region", "drill-down + slice + dice", {"region": "Prague", "year": 1998, "top_n": 5}, "top 5 accounts in Prague, 1998"),
    ("T23", "R5", "R5_top_accounts_by_region", "drill-down", {"top_n": 3}, "top 3 accounts in every region, all years"),
    ("T24", "R5", "R5_top_accounts_by_region", "slice + boundary", {"region": "west Bohemia", "year": 1993}, "default top 5, the first (smallest) year"),
    # R6
    ("T25", "R6", "R6_transaction_mix", "roll-up + drill-down", {}, "all three levels with subtotals"),
    ("T26", "R6", "R6_transaction_mix", "slice + dice", {"year": 1997, "txn_type": "Debit"}, "debits of 1997"),
    ("T27", "R6", "R6_transaction_mix", "dice", {"year": 1995, "region": "east Bohemia", "txn_type": "Credit"}, "credits, one region, one year"),
    # R7
    ("T28", "R7", "R7_region_profile_drill_across", "drill-across", {}, "all regions, all years"),
    ("T29", "R7", "R7_region_profile_drill_across", "drill-across + dice", {"year_from": 1996, "year_to": 1998}, "1996-1998"),
    ("T30", "R7", "R7_region_profile_drill_across", "drill-across + slice", {"region": "Prague"}, "one region"),
]


def expected_for(oracle, key, p):
    if key == "R1":
        return oracle.r1(p.get("level"), p.get("date_from"), p.get("date_to"), p.get("region"))
    if key == "R2":
        return oracle.r2(p.get("year_from"), p.get("year_to"), p.get("txn_type"), p.get("region"))
    if key == "R3":
        return oracle.r3(p.get("measure"), p.get("txn_type"), p.get("region"))
    if key == "R4":
        return oracle.r4(p.get("group_by"), p.get("phase"), p.get("health"), p.get("region"),
                         p.get("year_from"), p.get("year_to"), p.get("duration"))
    if key == "R5":
        return oracle.r5(p.get("region"), p.get("year"), p.get("top_n"))
    if key == "R6":
        return oracle.r6(p.get("year"), p.get("region"), p.get("txn_type"))
    if key == "R7":
        return oracle.r7(p.get("year_from"), p.get("year_to"), p.get("region"))
    raise KeyError(key)

def consistency_tests(conn, reports):
    def run(name, **params):
        return run_report(conn, reports[name], params)

    def verdict(ok, reason_if_fail):
        return ("PASS", "") if ok else ("FAIL", reason_if_fail)

    year_rows = run("R1_cash_flow_trend", level="year")
    month_rows = run("R1_cash_flow_trend", level="month")
    quarter_rows = run("R1_cash_flow_trend", level="quarter")
    total_count = sum(r[1] for r in year_rows)
    total_net = sum(Decimal(str(r[4])) for r in year_rows)
    ok = total_count == CONTROL["transactions"] and total_net == CONTROL["net_cash_flow"]
    yield ("C01", "R1 yearly totals equal the control totals (1,056,320 transactions, net 197,151,288.70)",
           "control totals", *verdict(ok, "transactions %s, net %s" % (total_count, total_net)))

    ok = (sum(Decimal(str(r[4])) for r in month_rows) == total_net
          and sum(Decimal(str(r[4])) for r in quarter_rows) == total_net
          and sum(r[1] for r in month_rows) == total_count)
    yield ("C02", "Roll-up consistency: month and quarter levels add up to the year level", "roll-up",
           *verdict(ok, "month/quarter totals differ from the yearly total"))

    r2 = run("R2_regional_rollup")
    details = [r for r in r2 if r[2] == "district"]
    subtotals = [r for r in r2 if r[2] == "region subtotal"]
    grand = [r for r in r2 if r[2] == "grand total"]
    ok = bool(grand) and len(grand) == 1 and sum(Decimal(str(r[6])) for r in details) == Decimal(str(grand[0][6])) \
        and sum(Decimal(str(r[6])) for r in subtotals) == Decimal(str(grand[0][6])) \
        and Decimal(str(grand[0][6])) == total_net and sum(r[4] for r in details) == grand[0][4]
    yield ("C03", "R2: district rows add up to the region subtotals, the subtotals to the grand total, and the grand "
           "total equals R1's net", "roll-up", *verdict(ok, "R2 detail, subtotal and grand rows do not reconcile"))

    r3 = run("R3_operation_by_year_pivot", measure="amount", txn_type="Debit")
    r6 = run("R6_transaction_mix", txn_type="Debit")
    r3_total = [r for r in r3 if r[0] == "ALL OPERATIONS"]
    r6_total = [r for r in r6 if r[3] == "grand total"]
    ok = bool(r3_total) and bool(r6_total) and Decimal(str(r3_total[0][7])) == Decimal(str(r6_total[0][5])) \
        and sum(Decimal(str(r3_total[0][i])) for i in range(1, 7)) == Decimal(str(r3_total[0][7]))
    yield ("C04", "Pivot total (R3, debits) equals the R6 grand total, and the six year columns add up to the total",
           "pivot", *verdict(ok, "R3 and R6 totals differ"))

    bad = []
    for group_by in ("region", "status", "duration", "year"):
        rows = run("R4_loan_portfolio", group_by=group_by)
        count, amount = sum(r[1] for r in rows), sum(Decimal(str(r[2])) for r in rows)
        share = sum(Decimal(str(r[7])) for r in rows)
        if count != CONTROL["loans"] or amount != CONTROL["loan_amount"] or abs(share - 100) > Decimal("0.05"):
            bad.append("%s: %s loans, amount %s, share %s" % (group_by, count, amount, share))
    yield ("C05", "R4: every grouping adds up to 682 loans and 103,261,740.00, and the shares add up to 100%",
           "roll-up", *verdict(not bad, "; ".join(bad)))

    r7 = run("R7_region_profile_drill_across")
    ok = (sum(r[1] for r in r7) == CONTROL["accounts"] and sum(r[2] for r in r7) == CONTROL["transactions"]
          and sum(Decimal(str(r[3])) for r in r7) == CONTROL["net_cash_flow"]
          and sum(r[5] for r in r7) == CONTROL["loans"] and sum(Decimal(str(r[6])) for r in r7) == CONTROL["loan_amount"])
    yield ("C06", "R7 (drill-across) adds up to 4,500 accounts, 1,056,320 transactions and 682 loans",
           "drill-across", *verdict(ok, "R7 totals differ from the control totals"))

    prague = run("R1_cash_flow_trend", level="year", region="Prague")
    prague_r7 = [r for r in r7 if r[0] == "Prague"]
    ok = bool(prague_r7) and sum(r[1] for r in prague) == prague_r7[0][2] \
        and sum(Decimal(str(r[4])) for r in prague) == Decimal(str(prague_r7[0][3]))
    yield ("C07", "Slice consistency: R1 for one region equals that region's row in R7", "slice",
           *verdict(ok, "R1 (region slice) and R7 disagree for Prague"))

def main(argv=None):
    parser = argparse.ArgumentParser(description="STADVDB MCO1 OLAP functional tests")
    parser.add_argument("--only", nargs="*", help="run only these test ids (for example T07 C02)")
    parser.add_argument("--list", action="store_true", help="list the test cases and stop")
    args = parser.parse_args(argv)

    if args.list:
        for tid, key, _name, operation, params, description in CASES:
            print("%s  %s  %-26s %s  %s" % (tid, key, operation, json.dumps(params), description))
        print("C01-C07  consistency tests between reports")
        return 0

    import mysql.connector
    reports = load_reports(OLAP_FILE)
    wanted = {t.upper() for t in args.only} if args.only else None
    started = time.time()
    src = mysql.connector.connect(**_settings(SRC_DB))
    dwh = mysql.connector.connect(**_settings(DWH_DB))
    print("Building the expected results from the source database...")
    oracle = build_oracle(src)
    src.close()
    print("Source loaded in %.1f s. Running tests.\n" % (time.time() - started))

    log = []

    def record(tid, key, operation, params, description, expected_n, actual_n, result, reason):
        log.append([tid, key, operation, json.dumps(params), description, expected_n, actual_n, result, reason])
        print("%-4s %-4s %-5s %s%s" % (tid, key, result, description, ("  -> " + reason) if reason else ""))

    for tid, key, name, operation, params, description in CASES:
        if wanted and tid not in wanted:
            continue
        try:
            expected = expected_for(oracle, key, params)
            actual = run_report(dwh, reports[name], params)
            reason = compare(key, expected, actual)
            record(tid, key, operation, params, description, len(expected), len(actual),
                   "FAIL" if reason else "PASS", reason)
        except Exception as exc:                                     # a crash is a FAIL with the reason
            record(tid, key, operation, params, description, "", "", "FAIL", "error: %s" % exc)

    if not wanted or any(t.startswith("C") for t in wanted):
        try:
            for tid, description, operation, result, reason in consistency_tests(dwh, reports):
                if wanted and tid not in wanted:
                    continue
                record(tid, "ALL", operation, {}, description, "", "", result, reason)
        except Exception as exc:
            record("C--", "ALL", "consistency", {}, "consistency tests", "", "", "FAIL", "error: %s" % exc)
    dwh.close()

    with open(LOG_FILE, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["test_id", "report", "olap_operation", "parameters", "description",
                         "expected_rows", "actual_rows", "result", "reason"])
        writer.writerows(log)
    passed = sum(1 for row in log if row[7] == "PASS")
    print("\n%d of %d tests passed. Log written to %s (%.1f s)." % (passed, len(log), LOG_FILE, time.time() - started))
    return 0 if passed == len(log) else 1

if __name__ == "__main__":
    sys.exit(main())