import sys

sys.dont_write_bytecode = True

import argparse
import csv
import datetime
import json
import logging
import os
import time
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from etl_config import load_env_file

load_env_file()


def _env(name, default):
    return os.environ.get(name, default)

def _connection_settings(database):
    return dict(
        host=_env("DB_HOST", "127.0.0.1"),
        port=int(_env("DB_PORT", "3306")),
        user=_env("DB_USER", "etl_user"), password=_env("DB_PASSWORD", ""),
        database=database,
        charset="utf8mb4",
    )

DWH_DB = _env("DWH_DB", "stadvdb_dw")
OUT_DIR = _env("OLAP_OUT", "olap_results")
DEFAULT_SCREEN_ROWS = 15

ALL_PARAMS = ["level", "date_from", "date_to", "region", "year_from", "year_to", "txn_type", "measure",
              "group_by", "phase", "health", "duration", "year", "top_n"]
INT_PARAMS = {"year_from", "year_to", "duration", "year", "top_n"}
DATE_PARAMS = {"date_from", "date_to"}

EXPECTED_COLUMNS = {
    "dim_date": ["date_key", "full_date", "year_num", "quarter_num", "month_num",
                 "month_name", "year_month_label", "week_of_year", "day_of_month",
                 "day_of_week", "is_weekend"],
    "dim_loan_status": ["loan_status_key", "status_code", "status_desc",
                        "contract_phase", "payment_health"],
    "dim_transaction_type": ["txn_type_key", "txn_type", "operation", "k_symbol"],
    "dim_account_location": ["account_key", "account_id", "frequency", "opening_date",
                             "district_name", "region", "average_salary"],
    "fact_transaction": ["transaction_id", "date_key", "account_key", "txn_type_key",
                         "amount", "signed_amount", "balance_after"],
    "fact_loan": ["loan_id", "grant_date_key", "account_key", "loan_status_key",
                  "duration_months", "loan_amount", "monthly_payment"],
}

log = logging.getLogger("olap")

# R1 - roll-up and drill-down on Date (year, quarter, month, day); slice by region; dice by date range.
# Params: level ('year' | 'quarter' | 'month' | 'day'), date_from, date_to (NULL = whole 1993-1998 range),
#         region (NULL = all regions).
# Shows whether the bank's customers put in more money than they take out, and how that changes from
# period to period. Change level to roll up or drill down.
SQL_R1 = """
WITH period_totals AS (
    SELECT
        CASE %(level)s
            WHEN 'year'    THEN CAST(d.year_num AS CHAR)
            WHEN 'quarter' THEN CONCAT(d.year_num, '-Q', d.quarter_num)
            WHEN 'month'   THEN d.year_month_label
            WHEN 'day'     THEN CAST(d.full_date AS CHAR)
        END AS period,
        MIN(d.full_date) AS period_start,
        COUNT(*) AS txn_count,
        SUM(CASE WHEN t.txn_type = 'Credit' THEN f.amount ELSE 0 END) AS total_credit,
        SUM(CASE WHEN t.txn_type = 'Debit'  THEN f.amount ELSE 0 END) AS total_debit,
        SUM(f.signed_amount) AS net_cash_flow
    FROM fact_transaction f
    JOIN dim_date d ON d.date_key = f.date_key
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    JOIN dim_account_location a ON a.account_key = f.account_key
    WHERE %(level)s IN ('year', 'quarter', 'month', 'day')
      AND d.full_date BETWEEN COALESCE(%(date_from)s, '1993-01-01') AND COALESCE(%(date_to)s, '1998-12-31')
      AND (%(region)s IS NULL OR a.region = %(region)s)
    GROUP BY period
)
SELECT
    period,
    txn_count,
    total_credit,
    total_debit,
    net_cash_flow,
    SUM(net_cash_flow) OVER (ORDER BY period_start) AS cumulative_net,
    ROUND(100 * (net_cash_flow - LAG(net_cash_flow) OVER (ORDER BY period_start))
          / NULLIF(ABS(LAG(net_cash_flow) OVER (ORDER BY period_start)), 0), 2) AS net_change_pct
FROM period_totals
ORDER BY period_start
"""

# R2 - roll-up and drill-down on Location (region > district); slice by transaction type; dice by year
# range and region.
# Params: year_from, year_to (NULL = 1993-1998), txn_type ('Credit' | 'Debit' | NULL),
#         region (NULL = every region; a region name shows only its districts).
# Compares regions, then districts inside a region, and shows each region subtotal and the grand total.
SQL_R2 = """
SELECT
    CASE WHEN GROUPING(a.region) = 1 THEN 'ALL REGIONS' ELSE a.region END AS region,
    CASE WHEN GROUPING(a.region) = 1 THEN NULL
         WHEN GROUPING(a.district_name) = 1 THEN 'ALL DISTRICTS'
         ELSE a.district_name END AS district,
    CASE WHEN GROUPING(a.region) = 1 THEN 'grand total'
         WHEN GROUPING(a.district_name) = 1 THEN 'region subtotal'
         ELSE 'district' END AS row_level,
    COUNT(DISTINCT a.account_key) AS active_accounts,
    COUNT(*) AS txn_count,
    SUM(f.amount) AS total_amount,
    SUM(f.signed_amount) AS net_cash_flow,
    ROUND(SUM(f.amount) / COUNT(DISTINCT a.account_key), 2) AS amount_per_account,
    CASE WHEN GROUPING(a.district_name) = 0 THEN MAX(a.average_salary) END AS district_average_salary
FROM fact_transaction f
JOIN dim_date d ON d.date_key = f.date_key
JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
JOIN dim_account_location a ON a.account_key = f.account_key
WHERE d.year_num BETWEEN COALESCE(%(year_from)s, 1993) AND COALESCE(%(year_to)s, 1998)
  AND (%(txn_type)s IS NULL OR t.txn_type = %(txn_type)s)
  AND (%(region)s IS NULL OR a.region = %(region)s)
GROUP BY a.region, a.district_name WITH ROLLUP
ORDER BY GROUPING(a.region), a.region, GROUPING(a.district_name), total_amount DESC
"""

# R3 - pivot (operations as rows, years as columns) with a roll-up total row; slice by transaction type;
# dice by region.
# Params: measure ('amount' | 'count'), txn_type ('Credit' | 'Debit' | NULL), region (NULL = all).
# Shows which banking operations grow or shrink year over year.
SQL_R3 = """
WITH base AS (
    SELECT
        t.operation,
        d.year_num,
        CASE WHEN %(measure)s = 'count' THEN 1 ELSE f.amount END AS measure_value
    FROM fact_transaction f
    JOIN dim_date d ON d.date_key = f.date_key
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    JOIN dim_account_location a ON a.account_key = f.account_key
    WHERE %(measure)s IN ('amount', 'count')
      AND (%(txn_type)s IS NULL OR t.txn_type = %(txn_type)s)
      AND (%(region)s IS NULL OR a.region = %(region)s)
)
SELECT
    CASE WHEN GROUPING(operation) = 1 THEN 'ALL OPERATIONS' ELSE operation END AS operation,
    SUM(CASE WHEN year_num = 1993 THEN measure_value ELSE 0 END) AS y1993,
    SUM(CASE WHEN year_num = 1994 THEN measure_value ELSE 0 END) AS y1994,
    SUM(CASE WHEN year_num = 1995 THEN measure_value ELSE 0 END) AS y1995,
    SUM(CASE WHEN year_num = 1996 THEN measure_value ELSE 0 END) AS y1996,
    SUM(CASE WHEN year_num = 1997 THEN measure_value ELSE 0 END) AS y1997,
    SUM(CASE WHEN year_num = 1998 THEN measure_value ELSE 0 END) AS y1998,
    SUM(measure_value) AS total
FROM base
GROUP BY operation WITH ROLLUP
ORDER BY GROUPING(operation), operation
"""

# R4 - slice (phase, health, region, duration), dice (grant-year range with other filters); the grouping
# dimension is itself a parameter, so the user can roll up or drill down between views.
# Params: group_by ('region' | 'status' | 'duration' | 'year'), phase ('Finished' | 'Running' | NULL),
#         health ('Good' | 'Bad' | NULL), region (NULL = all), year_from, year_to (grant years,
#         NULL = 1993-1998), duration (12 | 24 | 36 | 48 | 60 | NULL).
# Shows where loan money is concentrated and where repayment problems are.
SQL_R4 = """
SELECT
    CASE %(group_by)s
        WHEN 'region'   THEN a.region
        WHEN 'status'   THEN CONCAT(s.status_code, ' - ', s.status_desc)
        WHEN 'duration' THEN CONCAT(l.duration_months, ' months')
        WHEN 'year'     THEN CAST(d.year_num AS CHAR)
    END AS grp,
    COUNT(*) AS loan_count,
    SUM(l.loan_amount) AS total_loan_amount,
    ROUND(AVG(l.loan_amount), 2) AS avg_loan_amount,
    SUM(l.monthly_payment) AS total_monthly_payment,
    SUM(CASE WHEN s.payment_health = 'Bad' THEN 1 ELSE 0 END) AS loans_with_problems,
    ROUND(100 * SUM(CASE WHEN s.payment_health = 'Bad' THEN 1 ELSE 0 END) / COUNT(*), 2) AS problem_rate_pct,
    ROUND(100 * SUM(l.loan_amount) / SUM(SUM(l.loan_amount)) OVER (), 2) AS share_of_amount_pct
FROM fact_loan l
JOIN dim_loan_status s ON s.loan_status_key = l.loan_status_key
JOIN dim_account_location a ON a.account_key = l.account_key
JOIN dim_date d ON d.date_key = l.grant_date_key
WHERE %(group_by)s IN ('region', 'status', 'duration', 'year')
  AND (%(phase)s IS NULL OR s.contract_phase = %(phase)s)
  AND (%(health)s IS NULL OR s.payment_health = %(health)s)
  AND (%(region)s IS NULL OR a.region = %(region)s)
  AND d.year_num BETWEEN COALESCE(%(year_from)s, 1993) AND COALESCE(%(year_to)s, 1998)
  AND (%(duration)s IS NULL OR l.duration_months = %(duration)s)
GROUP BY grp
ORDER BY grp
"""

# R5 - drill-down to the Account level of Location; slice by year; dice by region and top-N.
# Params: region (NULL = every region), year (NULL = all years), top_n (NULL = 5).
# Finds the accounts with the most money inflow in each region (ties share a rank, so a region can
# return more than N rows).
SQL_R5 = """
WITH account_totals AS (
    SELECT
        a.region,
        a.district_name,
        a.account_id,
        a.frequency,
        COUNT(*) AS txn_count,
        SUM(CASE WHEN t.txn_type = 'Credit'
            THEN f.amount ELSE 0 END) AS total_credit,
        SUM(CASE WHEN t.txn_type = 'Debit'
            THEN f.amount ELSE 0 END) AS total_debit,
        SUM(f.signed_amount) AS net_cash_flow
    FROM dim_account_location a
    STRAIGHT_JOIN fact_transaction f
        ON f.account_key = a.account_key
    STRAIGHT_JOIN dim_date d
        ON d.date_key = f.date_key
    STRAIGHT_JOIN dim_transaction_type t
        ON t.txn_type_key = f.txn_type_key
    WHERE (%(year)s IS NULL OR d.year_num = %(year)s)
      AND (%(region)s IS NULL OR a.region = %(region)s)
    GROUP BY
        a.region,
        a.district_name,
        a.account_id,
        a.frequency
), ranked AS (
    SELECT
        account_totals.*,
        RANK() OVER (
            PARTITION BY region
            ORDER BY net_cash_flow DESC
        ) AS rank_in_region
    FROM account_totals
)
SELECT
    region,
    rank_in_region,
    account_id,
    district_name,
    frequency,
    txn_count,
    total_credit,
    total_debit,
    net_cash_flow
FROM ranked
WHERE rank_in_region <= COALESCE(%(top_n)s, 5)
ORDER BY
    region,
    rank_in_region,
    account_id
"""

# R6 - roll-up and drill-down on Transaction type (type > operation > purpose); slice by year and region.
# Params: year (NULL = all years), region (NULL = all), txn_type ('Credit' | 'Debit' | NULL).
# Shows what the money moves are made of, and how big each group is at every level of detail.
SQL_R6 = """
WITH transaction_summary AS (
    SELECT
        f.txn_type_key,
        COUNT(*) AS txn_count,
        COUNT(f.amount) AS amount_count,
        SUM(f.amount) AS total_amount
    FROM fact_transaction f
    JOIN dim_date d
        ON d.date_key = f.date_key
    WHERE (%(year)s IS NULL OR d.year_num = %(year)s)
      AND (
          %(region)s IS NULL
          OR EXISTS (
              SELECT 1
              FROM dim_account_location a
              WHERE a.account_key = f.account_key
                AND a.region = %(region)s
          )
      )
    GROUP BY f.txn_type_key
)
SELECT
    CASE
        WHEN GROUPING(t.txn_type) = 1 THEN 'ALL TYPES'
        ELSE t.txn_type
    END AS txn_type,
    CASE
        WHEN GROUPING(t.txn_type) = 1 THEN NULL
        WHEN GROUPING(t.operation) = 1 THEN 'ALL OPERATIONS'
        ELSE t.operation
    END AS operation,
    CASE
        WHEN GROUPING(t.operation) = 1 THEN NULL
        WHEN GROUPING(t.k_symbol) = 1 THEN 'ALL PURPOSES'
        ELSE t.k_symbol
    END AS purpose,
    CASE
        WHEN GROUPING(t.txn_type) = 1 THEN 'grand total'
        WHEN GROUPING(t.operation) = 1 THEN 'type subtotal'
        WHEN GROUPING(t.k_symbol) = 1 THEN 'operation subtotal'
        ELSE 'detail'
    END AS row_level,
    SUM(s.txn_count) AS txn_count,
    SUM(s.total_amount) AS total_amount,
    ROUND(
        SUM(s.total_amount) / NULLIF(SUM(s.amount_count), 0),
        2
    ) AS avg_amount
FROM transaction_summary s
JOIN dim_transaction_type t
    ON t.txn_type_key = s.txn_type_key
WHERE (%(txn_type)s IS NULL OR t.txn_type = %(txn_type)s)
GROUP BY
    t.txn_type,
    t.operation,
    t.k_symbol WITH ROLLUP
ORDER BY
    GROUPING(t.txn_type),
    t.txn_type,
    GROUPING(t.operation),
    t.operation,
    GROUPING(t.k_symbol),
    t.k_symbol
"""

# R7 - drill-across (two fact tables joined through the shared region dimension); slice by region; dice by
# year range.
# Params: year_from, year_to (NULL = 1993-1998; applied to transaction years and loan grant years),
#         region (NULL = all regions).
# Three CTEs are aggregated separately before joining, so the two fact tables do not multiply each
# other's rows. Compares how active each region's accounts are with how much it borrows, and how many
# loans have problems.
SQL_R7 = """
WITH accts AS (
    SELECT
        a.region,
        COUNT(*) AS account_count
    FROM dim_account_location a
    WHERE (%(region)s IS NULL OR a.region = %(region)s)
    GROUP BY a.region
),
txn_by_account AS (
    SELECT
        f.account_key,
        COUNT(*) AS txn_count,
        SUM(f.signed_amount) AS net_cash_flow
    FROM fact_transaction f
    JOIN dim_date d
        ON d.date_key = f.date_key
    WHERE d.year_num BETWEEN
          COALESCE(%(year_from)s, 1993)
          AND COALESCE(%(year_to)s, 1998)
    GROUP BY f.account_key
),
txn AS (
    SELECT
        a.region,
        SUM(t.txn_count) AS txn_count,
        SUM(t.net_cash_flow) AS net_cash_flow
    FROM txn_by_account t
    JOIN dim_account_location a
        ON a.account_key = t.account_key
    WHERE (%(region)s IS NULL OR a.region = %(region)s)
    GROUP BY a.region
),
loans AS (
    SELECT
        a.region,
        COUNT(*) AS loan_count,
        SUM(l.loan_amount) AS loan_amount,
        SUM(
            CASE
                WHEN s.payment_health = 'Bad' THEN 1
                ELSE 0
            END
        ) AS problem_loans
    FROM fact_loan l
    JOIN dim_date d
        ON d.date_key = l.grant_date_key
    JOIN dim_account_location a
        ON a.account_key = l.account_key
    JOIN dim_loan_status s
        ON s.loan_status_key = l.loan_status_key
    WHERE d.year_num BETWEEN
          COALESCE(%(year_from)s, 1993)
          AND COALESCE(%(year_to)s, 1998)
      AND (%(region)s IS NULL OR a.region = %(region)s)
    GROUP BY a.region
)
SELECT
    c.region,
    c.account_count,
    COALESCE(t.txn_count, 0) AS txn_count,
    COALESCE(t.net_cash_flow, 0) AS net_cash_flow,
    ROUND(
        COALESCE(t.net_cash_flow, 0) / c.account_count,
        2
    ) AS net_cash_flow_per_account,
    COALESCE(l.loan_count, 0) AS loans_granted,
    COALESCE(l.loan_amount, 0) AS loan_amount,
    COALESCE(l.problem_loans, 0) AS problem_loans,
    ROUND(
        100.0 * COALESCE(l.loan_count, 0)
        / c.account_count,
        2
    ) AS loans_per_100_accounts

FROM accts c
LEFT JOIN txn t ON t.region = c.region
LEFT JOIN loans l ON l.region = c.region
ORDER BY c.region
"""

# name -> title, OLAP operations, example parameters, SQL
REPORTS = {
    "R1_cash_flow_trend": {
        "title": "Cash flow trend by period",
        "olap": "roll-up and drill-down on Date; slice by region; dice by date range",
        "example": {"level": "month", "date_from": "1997-01-01", "date_to": "1997-12-31", "region": None},
        "sql": SQL_R1},
    "R2_regional_rollup": {
        "title": "Regional activity with district drill-down and subtotals",
        "olap": "roll-up and drill-down on Location; slice by transaction type; dice by year range and region",
        "example": {"year_from": 1996, "year_to": 1998, "txn_type": "Credit", "region": None},
        "sql": SQL_R2},
    "R3_operation_by_year_pivot": {
        "title": "Pivot of transaction operations by year",
        "olap": "pivot with a roll-up total row; slice by transaction type; dice by region",
        "example": {"measure": "amount", "txn_type": "Debit", "region": None},
        "sql": SQL_R3},
    "R4_loan_portfolio": {
        "title": "Loan portfolio by a chosen dimension",
        "olap": "slice (phase, health, region, duration); dice (grant-year range); roll-up/drill-down via group_by",
        "example": {"group_by": "region", "phase": None, "health": None, "region": None,
                    "year_from": None, "year_to": None, "duration": None},
        "sql": SQL_R4},
    "R5_top_accounts_by_region": {
        "title": "Top accounts by net cash flow inside each region",
        "olap": "drill-down to the Account level; slice by year; dice by region and top-N",
        "example": {"region": "Prague", "year": 1998, "top_n": 5},
        "sql": SQL_R5},
    "R6_transaction_mix": {
        "title": "Transaction mix: type, operation and purpose with subtotals",
        "olap": "roll-up and drill-down on Transaction type; slice by year and region",
        "example": {"year": 1997, "region": None, "txn_type": None},
        "sql": SQL_R6},
    "R7_region_profile_drill_across": {
        "title": "Region profile: accounts, cash flow and loans side by side",
        "olap": "drill-across (two fact tables through the region dimension); slice by region; dice by year range",
        "example": {"year_from": 1996, "year_to": 1998, "region": None},
        "sql": SQL_R7},
}

REPORT_SQL = {name: report["sql"].strip() for name, report in REPORTS.items()}

def setup_logging():
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    log.setLevel(logging.INFO)
    for handler in (logging.StreamHandler(sys.stdout),
                    logging.FileHandler("olap_run.log", mode="w", encoding="utf-8")):
        handler.setFormatter(fmt)
        log.addHandler(handler)

def connect(settings):
    import mysql.connector
    return mysql.connector.connect(autocommit=False, **settings)

def _as_text(value):
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8")
    return value

def fetch_all(conn, sql, params=()):
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()
    return rows

def verify_warehouse_schema(conn):
    problems = []
    for table, columns in EXPECTED_COLUMNS.items():
        rows = fetch_all(conn, "SELECT LOWER(column_name) FROM information_schema.columns "
                               "WHERE table_schema = %s AND table_name = %s", (DWH_DB, table))
        present = {_as_text(r[0]) for r in rows}
        if not present:
            problems.append("table %s was not found in database %s" % (table, DWH_DB))
            continue
        missing = [c for c in columns if c not in present]
        if missing:
            problems.append("table %s is missing column(s): %s" % (table, ", ".join(missing)))
    if problems:
        raise RuntimeError("The warehouse schema does not match the Mapping Matrix:\n - "
                           + "\n - ".join(problems))
    log.info("Warehouse schema check passed (%d tables).", len(EXPECTED_COLUMNS))

def run_report(conn, sql, params):
    bound = {name: params.get(name) for name in ALL_PARAMS}
    cur = conn.cursor()
    cur.execute(sql, bound)
    columns = [_as_text(c[0]) for c in cur.description]
    rows = cur.fetchall()
    cur.close()
    return columns, rows

def parse_overrides(pairs):

    overrides = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise ValueError("--param needs name=value, got %r" % pair)
        name, value = pair.split("=", 1)
        name, value = name.strip().lower(), value.strip()
        if name not in ALL_PARAMS:
            raise ValueError("unknown parameter %r (known: %s)" % (name, ", ".join(ALL_PARAMS)))
        if value.upper() in ("NULL", "NONE", ""):
            overrides[name] = None
        elif name in INT_PARAMS:
            try:
                overrides[name] = int(value)
            except ValueError:
                raise ValueError("parameter %s must be a whole number, got %r" % (name, value))
        elif name in DATE_PARAMS:
            try:
                datetime.date.fromisoformat(value)
            except ValueError:
                raise ValueError("parameter %s must be a date like 1997-01-31, got %r" % (name, value))
            overrides[name] = value
        else:
            overrides[name] = value
    return overrides

def select_reports(wanted):
    if not wanted:
        return list(REPORTS)
    chosen = []
    for item in wanted:
        matches = [n for n in REPORTS if n == item or n.split("_", 1)[0].lower() == item.lower()]
        if not matches:
            raise ValueError("unknown report %r (known: %s)" % (item, ", ".join(REPORTS)))
        for name in matches:
            if name not in chosen:
                chosen.append(name)
    return chosen

def _cell(value):
    if value is None:
        return ""
    if isinstance(value, (datetime.date, datetime.datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)

def write_csv(path, columns, rows):
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for row in rows:
            writer.writerow([_cell(v) for v in row])

def render_table(columns, rows, limit):
    shown = [[_cell(v) for v in row] for row in rows[:limit]]
    widths = [max([len(c)] + [len(r[i]) for r in shown]) for i, c in enumerate(columns)]
    lines = ["  ".join(c.ljust(w) for c, w in zip(columns, widths)),
             "  ".join("-" * w for w in widths)]
    lines += ["  ".join(v.ljust(w) for v, w in zip(r, widths)) for r in shown]
    if len(rows) > limit:
        lines.append("... %d more row(s) in the CSV file" % (len(rows) - limit))
    return "\n".join(lines)

def list_reports():
    for name, report in REPORTS.items():
        print("%s\n    %s\n    olap: %s\n    example: %s\n"
              % (name, report["title"], report["olap"], json.dumps(report["example"])))

def parse_args(argv):
    parser = argparse.ArgumentParser(description="STADVDB MCO1 OLAP reports: data warehouse -> CSV files")
    parser.add_argument("--report", nargs="*", help="reports to run (for example R2 R5); default is all seven")
    parser.add_argument("--param", nargs="*", metavar="NAME=VALUE",
                        help="report parameters, applied on top of the example parameters; NULL switches one off")
    parser.add_argument("--rows", type=int, default=DEFAULT_SCREEN_ROWS,
                        help="rows shown on screen per report (default %d); the CSV always has all rows"
                             % DEFAULT_SCREEN_ROWS)
    parser.add_argument("--list", action="store_true", help="list the reports and stop")
    return parser.parse_args(argv)

def main(argv=None):
    args = parse_args(argv)
    if args.list:
        list_reports()
        return 0
    setup_logging()
    started = time.time()
    conn = None
    failed = []
    summary = []
    try:
        overrides = parse_overrides(args.param)
        selected = select_reports(args.report)
        log.info("OLAP run started. Warehouse database: %s. Reports: %s.", DWH_DB, ", ".join(selected))
        conn = connect(_connection_settings(DWH_DB))
        verify_warehouse_schema(conn)
        os.makedirs(OUT_DIR, exist_ok=True)
        for name in selected:
            params = dict(REPORTS[name]["example"])
            params.update(overrides)
            log.info("---- %s: %s", name, REPORTS[name]["title"])
            log.info("parameters: %s", json.dumps({k: v for k, v in params.items() if v is not None}))
            tick = time.time()
            try:
                columns, rows = run_report(conn, REPORTS[name]["sql"], params)
            except Exception as exc:
                log.exception("%s failed: %s", name, exc)
                failed.append(name)
                continue
            path = os.path.join(OUT_DIR, name + ".csv")
            write_csv(path, columns, rows)
            print(render_table(columns, rows, args.rows))
            log.info("%s: %d rows written to %s (%.1f seconds).", name, len(rows), path, time.time() - tick)
            summary.append((name, len(rows)))
        log.info("---- Run summary ----")
        for name, count in summary:
            log.info("%-34s rows %d", name, count)
    except Exception as exc:
        log.exception("OLAP run stopped: %s", exc)
        return 1
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    log.info("Elapsed: %.1f seconds.", time.time() - started)
    if failed:
        log.error("OLAP run finished with problems. Failed reports: %s. See the messages above.", ", ".join(failed))
        return 1
    log.info("OLAP run finished: %d report(s) written to %s.", len(summary), OUT_DIR)
    return 0

if __name__ == "__main__":
    sys.exit(main())