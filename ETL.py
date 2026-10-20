import argparse
import collections
import datetime
import logging
import os
import sys
import time
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

def _env(name, default):
    return os.environ.get(name, default)

def _connection_settings(database):
    return dict(
        host=_env("DB_HOST", "127.0.0.1"),
        port=int(_env("DB_PORT", "3306")),
        user=_env("DB_USER", "etl_user"),
        password=_env("DB_PASSWORD", ""),
        database=database,
        charset="utf8mb4",
    )


SRC_DB = _env("SRC_DB", "financedata")
DWH_DB = _env("DWH_DB", "stadvdb_dw")

DATE_START = datetime.date(1993, 1, 1)   
DATE_END = datetime.date(1998, 12, 31)
DEFAULT_BATCH_SIZE = 10000
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]

LOAD_ORDER = ["dim_date", "dim_loan_status", "dim_transaction_type",
              "dim_account_location", "fact_transaction", "fact_loan"]

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

SQL_INSERT = {
    "dim_date": (
        "INSERT INTO dim_date (date_key, full_date, year_num, quarter_num, month_num, "
        "month_name, year_month_label, week_of_year, day_of_month, day_of_week, is_weekend) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"),
    "dim_loan_status": (
        "INSERT INTO dim_loan_status (status_code, status_desc, contract_phase, payment_health) "
        "VALUES (%s, %s, %s, %s)"),
    "dim_transaction_type": (
        "INSERT INTO dim_transaction_type (txn_type, operation, k_symbol) VALUES (%s, %s, %s)"),
    "dim_account_location": (
        "INSERT INTO dim_account_location (account_id, frequency, opening_date, district_name, "
        "region, average_salary) VALUES (%s, %s, %s, %s, %s, %s)"),
    "fact_transaction": (
        "INSERT INTO fact_transaction (transaction_id, date_key, account_key, txn_type_key, "
        "amount, signed_amount, balance_after) VALUES (%s, %s, %s, %s, %s, %s, %s)"),
    "fact_loan": (
        "INSERT INTO fact_loan (loan_id, grant_date_key, account_key, loan_status_key, "
        "duration_months, loan_amount, monthly_payment) VALUES (%s, %s, %s, %s, %s, %s, %s)"),
}

log = logging.getLogger("etl")
reject_log = logging.getLogger("etl.rejects")


def setup_logging():
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    log.setLevel(logging.INFO)
    for handler in (logging.StreamHandler(sys.stdout),
                    logging.FileHandler("etl_run.log", mode="w", encoding="utf-8")):
        handler.setFormatter(fmt)
        log.addHandler(handler)
    rejects = logging.FileHandler("etl_rejects.log", mode="w", encoding="utf-8")
    rejects.setFormatter(logging.Formatter("%(message)s"))
    reject_log.setLevel(logging.INFO)
    reject_log.addHandler(rejects)
    reject_log.propagate = False


class Rejects:
    """Counts rejected rows per table and writes each one to etl_rejects.log (TR-12)."""

    def __init__(self):
        self.count = collections.Counter()

    def add(self, table, key, reason):
        self.count[table] += 1
        reject_log.info("%s\t%s\t%s", table, key, reason)

    def total(self):
        return sum(self.count.values())

TYPE_MAP = {                      
    "Credit": "Credit",
    "Debit (Withdrawal)": "Debit",
    "VYBER": "Debit",             
}
CONTRACT_PHASE = {"A": "Finished", "B": "Finished", "C": "Running", "D": "Running"}   
PAYMENT_HEALTH = {"A": "Good", "B": "Bad", "C": "Good", "D": "Bad"}                   
CENT = Decimal("0.01")
ZERO = Decimal("0.00")

def clean_text(value):
    """None -> '' and surrounding spaces removed."""
    return "" if value is None else str(value).strip()

def clean_type(value):
    """TR-01: 'Debit (Withdrawal)' and 'VYBER' become 'Debit'. An unknown value stops the
    run, because a wrong type would give the wrong sign in signed_amount."""
    key = clean_text(value)
    if key not in TYPE_MAP:
        raise ValueError("unmapped trans.type value %r" % (value,))
    return TYPE_MAP[key]

def blank_to_na(value):
    """TR-02 / TR-03: empty or NULL becomes 'N/A'."""
    text = clean_text(value)
    return text if text else "N/A"

def txn_type_natural_key(type_, operation, k_symbol):
    """TR-04: the cleaned (type, operation, k_symbol) combination that identifies a
    dim_transaction_type row."""
    return (clean_type(type_), blank_to_na(operation), blank_to_na(k_symbol))

def to_date_key(day):
    """TR-05: date -> integer YYYYMMDD."""
    return day.year * 10000 + day.month * 100 + day.day

def to_money(value):
    """TR-07: DOUBLE -> DECIMAL(18,2). Raises InvalidOperation / TypeError on bad input."""
    return Decimal(str(value)).quantize(CENT, rounding=ROUND_HALF_UP)

def build_dim_date_rows(start=DATE_START, end=DATE_END):
    """TR-06: one row per calendar day. Attribute definitions follow the Mapping Matrix
    (week_of_year = ISO week, which is MySQL WEEK(date, 3) and runs 1 to 53)."""
    rows = []
    day = start
    while day <= end:
        weekday = day.weekday()                       
        rows.append((
            to_date_key(day),                         
            day,                                      
            day.year,                                
            (day.month - 1) // 3 + 1,                 
            day.month,                               
            MONTH_NAMES[day.month - 1],               
            "%04d-%02d" % (day.year, day.month),      
            day.isocalendar()[1],                     
            day.day,                                  
            weekday + 1,                              
            1 if weekday >= 5 else 0,                
        ))
        day += datetime.timedelta(days=1)
    return rows

def build_loan_status_row(status, description):
    """TR-10: copy the lookup row and add the two derived columns. Returns None when the
    status code is not A, B, C or D."""
    code = clean_text(status)
    if code not in CONTRACT_PHASE:
        return None
    return (code, clean_text(description), CONTRACT_PHASE[code], PAYMENT_HEALTH[code])

def transform_trans_row(row, date_keys, account_keys, txn_type_keys):
    """TR-01 to TR-05, TR-07, TR-08, TR-11, TR-12 for one trans row.
    row = (trans_id, account_id, newdate, type, operation, amount, balance, k_symbol)
    Returns (fact_row, None) or (None, reason)."""
    trans_id, account_id, newdate, type_, operation, amount, balance, k_symbol = row
    try:
        natural_key = txn_type_natural_key(type_, operation, k_symbol)
        date_key = to_date_key(newdate)
        amount_dec = to_money(amount)
        balance_dec = to_money(balance)
    except (ValueError, TypeError, AttributeError, InvalidOperation) as exc:
        return None, "bad value: %s" % exc
    if date_key not in date_keys:
        return None, "date_key %s is not in dim_date" % date_key
    account_key = account_keys.get(account_id)
    if account_key is None:
        return None, "account_id %s is not in dim_account_location" % account_id
    txn_type_key = txn_type_keys.get(natural_key)
    if txn_type_key is None:
        return None, "no dim_transaction_type row for %s" % (natural_key,)
    if amount_dec < 0:
        return None, "negative amount %s" % amount_dec
    signed = amount_dec if natural_key[0] == "Credit" else ZERO - amount_dec     
    return (trans_id, date_key, account_key, txn_type_key, amount_dec, signed, balance_dec), None

def transform_loan_row(row, date_keys, account_keys, loan_status_keys):
    """TR-05, TR-07, TR-11, TR-12 for one loan row.
    row = (loan_id, account_id, newdate, status, duration, amount, payments)"""
    loan_id, account_id, newdate, status, duration, amount, payments = row
    try:
        date_key = to_date_key(newdate)
        amount_dec = to_money(amount)
        payments_dec = to_money(payments)
    except (ValueError, TypeError, AttributeError, InvalidOperation) as exc:
        return None, "bad value: %s" % exc
    if date_key not in date_keys:
        return None, "date_key %s is not in dim_date" % date_key
    account_key = account_keys.get(account_id)
    if account_key is None:
        return None, "account_id %s is not in dim_account_location" % account_id
    status_key = loan_status_keys.get(clean_text(status))
    if status_key is None:
        return None, "status %r is not in dim_loan_status" % (status,)
    return (loan_id, date_key, account_key, status_key, duration, amount_dec, payments_dec), None

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

def insert_rows(conn, table, rows):
    if not rows:
        return
    cur = conn.cursor()
    cur.executemany(SQL_INSERT[table], rows)
    cur.close()

def verify_target_schema(tgt):
    problems = []
    for table, columns in EXPECTED_COLUMNS.items():
        rows = fetch_all(tgt, "SELECT LOWER(column_name) FROM information_schema.columns "
                              "WHERE table_schema = %s AND table_name = %s", (DWH_DB, table))
        present = {_as_text(r[0]) for r in rows}
        if not present:
            problems.append("table %s was not found in database %s" % (table, DWH_DB))
            continue
        missing = [c for c in columns if c not in present]
        if missing:
            problems.append("table %s is missing column(s): %s" % (table, ", ".join(missing)))
    if problems:
        raise RuntimeError("The warehouse schema does not match the Mapping Matrix:\n  - "
                           + "\n  - ".join(problems))
    log.info("Warehouse schema check passed (%d tables).", len(EXPECTED_COLUMNS))

def prepare_targets(tgt, reset):
    cur = tgt.cursor()
    if reset:
        log.info("--reset given: emptying the target tables.")
        cur.execute("SET FOREIGN_KEY_CHECKS = 0")
        for table in reversed(LOAD_ORDER):
            cur.execute("TRUNCATE TABLE %s" % table)
        cur.execute("SET FOREIGN_KEY_CHECKS = 1")
        tgt.commit()
    else:
        for table in LOAD_ORDER:
            cur.execute("SELECT COUNT(*) FROM %s" % table)
            if cur.fetchone()[0] > 0:
                cur.close()
                raise RuntimeError("Target table %s already has rows. Run with --reset to reload."
                                   % table)
    cur.close()

def check_source_dates(src):
    """Every source date must fall inside the generated dim_date range."""
    for table in ("trans", "loan", "account"):
        low, high = fetch_all(src, "SELECT MIN(newdate), MAX(newdate) FROM %s" % table)[0]
        if low is None:
            continue
        if low < DATE_START or high > DATE_END:
            raise RuntimeError("%s.newdate runs %s to %s, outside dim_date (%s to %s)"
                               % (table, low, high, DATE_START, DATE_END))
    log.info("Source dates are inside the dim_date range.")

def load_dim_date(tgt):
    rows = build_dim_date_rows()
    insert_rows(tgt, "dim_date", rows)
    tgt.commit()
    log.info("dim_date: %d rows loaded.", len(rows))
    return {r[0] for r in rows}, {"extracted": len(rows), "loaded": len(rows), "rejected": 0}

def load_dim_loan_status(src, tgt, rejects):
    source_rows = fetch_all(src, "SELECT status, description FROM ref_loanstatus ORDER BY status")
    good = []
    for status, description in source_rows:
        row = build_loan_status_row(status, description)
        if row is None:
            rejects.add("dim_loan_status", status, "status code is not A, B, C or D")
        else:
            good.append(row)
    insert_rows(tgt, "dim_loan_status", good)
    tgt.commit()
    keys = {_as_text(code): key for code, key in
            fetch_all(tgt, "SELECT status_code, loan_status_key FROM dim_loan_status")}
    log.info("dim_loan_status: %d of %d rows loaded.", len(good), len(source_rows))
    return keys, {"extracted": len(source_rows), "loaded": len(good),
                  "rejected": len(source_rows) - len(good)}

def load_dim_transaction_type(src, tgt):
    source_rows = fetch_all(src, "SELECT DISTINCT `type`, operation, k_symbol FROM trans")
    natural_keys = sorted({txn_type_natural_key(t, o, k) for t, o, k in source_rows})   # TR-04
    insert_rows(tgt, "dim_transaction_type", natural_keys)
    tgt.commit()
    keys = {}
    for txn_type, operation, k_symbol, key in fetch_all(
            tgt, "SELECT txn_type, operation, k_symbol, txn_type_key FROM dim_transaction_type"):
        keys[(_as_text(txn_type), _as_text(operation), _as_text(k_symbol))] = key
    log.info("dim_transaction_type: %d distinct cleaned combinations (from %d raw combinations).",
             len(natural_keys), len(source_rows))
    return keys, {"extracted": len(source_rows), "loaded": len(natural_keys), "rejected": 0}

def load_dim_account_location(src, tgt, rejects):
    sql = ("SELECT a.account_id, a.frequency, a.newdate, d.district_name, d.region, d.average_salary "
           "FROM account a LEFT JOIN district d ON d.district_id = a.district_id "
           "ORDER BY a.account_id")
    source_rows = fetch_all(src, sql)
    good = []
    for account_id, frequency, opening_date, district_name, region, average_salary in source_rows:
        if district_name is None:
            rejects.add("dim_account_location", account_id, "account has no matching district")
            continue
        good.append((account_id, clean_text(frequency), opening_date, clean_text(district_name),
                     clean_text(region), average_salary))
    insert_rows(tgt, "dim_account_location", good)
    tgt.commit()
    keys = {account_id: key for account_id, key in
            fetch_all(tgt, "SELECT account_id, account_key FROM dim_account_location")}
    log.info("dim_account_location: %d of %d rows loaded.", len(good), len(source_rows))
    return keys, {"extracted": len(source_rows), "loaded": len(good),
                  "rejected": len(source_rows) - len(good)}

def load_fact_transaction(src, tgt, date_keys, account_keys, txn_type_keys, rejects, batch_size):
    cur = src.cursor()                       # not buffered, so the rows are streamed in batches
    cur.execute("SELECT trans_id, account_id, newdate, `type`, operation, amount, balance, k_symbol "
                "FROM trans ORDER BY trans_id")
    extracted = loaded = 0
    next_report = 100000
    while True:
        chunk = cur.fetchmany(batch_size)
        if not chunk:
            break
        extracted += len(chunk)
        good = []
        for row in chunk:
            fact_row, reason = transform_trans_row(row, date_keys, account_keys, txn_type_keys)
            if fact_row is None:
                rejects.add("fact_transaction", row[0], reason)
                continue
            good.append(fact_row)
        try:
            insert_rows(tgt, "fact_transaction", good)
            tgt.commit()
        except Exception:
            tgt.rollback()
            log.error("Batch insert failed after %d rows were loaded. Run again with --reset.", loaded)
            raise
        loaded += len(good)
        if extracted >= next_report:
            log.info("fact_transaction: %d rows read, %d loaded...", extracted, loaded)
            next_report += 100000
    cur.close()
    log.info("fact_transaction: %d of %d rows loaded.", loaded, extracted)
    return {"extracted": extracted, "loaded": loaded, "rejected": extracted - loaded}

def load_fact_loan(src, tgt, date_keys, account_keys, loan_status_keys, rejects, batch_size):
    cur = src.cursor()
    cur.execute("SELECT loan_id, account_id, newdate, status, duration, amount, payments "
                "FROM loan ORDER BY loan_id")
    extracted = loaded = 0
    while True:
        chunk = cur.fetchmany(batch_size)
        if not chunk:
            break
        extracted += len(chunk)
        good = []
        for row in chunk:
            fact_row, reason = transform_loan_row(row, date_keys, account_keys, loan_status_keys)
            if fact_row is None:
                rejects.add("fact_loan", row[0], reason)
                continue
            good.append(fact_row)
        insert_rows(tgt, "fact_loan", good)
        tgt.commit()
        loaded += len(good)
    cur.close()
    log.info("fact_loan: %d of %d rows loaded.", loaded, extracted)
    return {"extracted": extracted, "loaded": loaded, "rejected": extracted - loaded}

def reconcile(src, tgt, stats):
    ok = True

    def check(name, expected, actual):
        nonlocal ok
        passed = expected == actual
        ok = ok and passed
        log.info("%-46s expected %-18s actual %-18s %s", name, expected, actual,
                 "PASS" if passed else "FAIL")

    log.info("---- Reconciliation: row counts ----")
    expected_counts = {
        "dim_date": len(build_dim_date_rows()),
        "dim_loan_status": fetch_all(src, "SELECT COUNT(*) FROM ref_loanstatus")[0][0],
        "dim_transaction_type": stats["dim_transaction_type"]["loaded"],
        "dim_account_location": fetch_all(src, "SELECT COUNT(*) FROM account")[0][0],
        "fact_transaction": fetch_all(src, "SELECT COUNT(*) FROM trans")[0][0],
        "fact_loan": fetch_all(src, "SELECT COUNT(*) FROM loan")[0][0],
    }
    for table in LOAD_ORDER:
        actual = fetch_all(tgt, "SELECT COUNT(*) FROM %s" % table)[0][0]
        check(table + " row count", expected_counts[table], actual)

    log.info("---- Reconciliation: control totals ----")
    src_credit, src_debit = fetch_all(
        src, "SELECT COALESCE(SUM(CASE WHEN `type` = 'Credit' THEN CAST(amount AS DECIMAL(18,2)) END), 0), "
             "COALESCE(SUM(CASE WHEN `type` IN ('Debit (Withdrawal)', 'VYBER') "
             "THEN CAST(amount AS DECIMAL(18,2)) END), 0) FROM trans")[0]
    wh_credit, wh_debit, wh_signed = fetch_all(
        tgt, "SELECT COALESCE(SUM(CASE WHEN d.txn_type = 'Credit' THEN f.amount END), 0), "
             "COALESCE(SUM(CASE WHEN d.txn_type = 'Debit' THEN f.amount END), 0), "
             "COALESCE(SUM(f.signed_amount), 0) FROM fact_transaction f "
             "JOIN dim_transaction_type d ON d.txn_type_key = f.txn_type_key")[0]
    check("fact_transaction credit total", Decimal(src_credit), Decimal(wh_credit))
    check("fact_transaction debit total (incl. VYBER)", Decimal(src_debit), Decimal(wh_debit))
    check("fact_transaction net (signed_amount) total", Decimal(src_credit) - Decimal(src_debit),
          Decimal(wh_signed))
    src_loan = fetch_all(src, "SELECT COALESCE(SUM(CAST(amount AS DECIMAL(18,2))), 0), "
                              "COALESCE(SUM(CAST(payments AS DECIMAL(18,2))), 0) FROM loan")[0]
    wh_loan = fetch_all(tgt, "SELECT COALESCE(SUM(loan_amount), 0), COALESCE(SUM(monthly_payment), 0) "
                             "FROM fact_loan")[0]
    check("fact_loan loan_amount total", Decimal(src_loan[0]), Decimal(wh_loan[0]))
    check("fact_loan monthly_payment total", Decimal(src_loan[1]), Decimal(wh_loan[1]))
    return ok

def parse_args(argv):
    parser = argparse.ArgumentParser(description="STADVDB MCO1 ETL: financedata -> data warehouse")
    parser.add_argument("--reset", action="store_true",
                        help="empty the six target tables before loading")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE,
                        help="rows per batch for the fact tables (default %d)" % DEFAULT_BATCH_SIZE)
    return parser.parse_args(argv)

def main(argv=None):
    args = parse_args(argv)
    setup_logging()
    started = time.time()
    rejects = Rejects()
    stats = {}
    src = tgt = None
    try:
        log.info("ETL started. Source database: %s. Warehouse database: %s.", SRC_DB, DWH_DB)
        src = connect(_connection_settings(SRC_DB))
        tgt = connect(_connection_settings(DWH_DB))
        verify_target_schema(tgt)
        prepare_targets(tgt, args.reset)
        check_source_dates(src)

        date_keys, stats["dim_date"] = load_dim_date(tgt)
        loan_status_keys, stats["dim_loan_status"] = load_dim_loan_status(src, tgt, rejects)
        txn_type_keys, stats["dim_transaction_type"] = load_dim_transaction_type(src, tgt)
        account_keys, stats["dim_account_location"] = load_dim_account_location(src, tgt, rejects)
        stats["fact_transaction"] = load_fact_transaction(
            src, tgt, date_keys, account_keys, txn_type_keys, rejects, args.batch_size)
        stats["fact_loan"] = load_fact_loan(
            src, tgt, date_keys, account_keys, loan_status_keys, rejects, args.batch_size)

        log.info("---- Load summary ----")
        for table in LOAD_ORDER:
            s = stats[table]
            log.info("%-24s extracted %-9d loaded %-9d rejected %d",
                     table, s["extracted"], s["loaded"], s["rejected"])
        reconciled = reconcile(src, tgt, stats)
    except Exception as exc:
        log.exception("ETL stopped: %s", exc)
        if tgt is not None:
            try:
                tgt.rollback()
            except Exception:
                pass
        return 1
    finally:
        for conn in (src, tgt):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

    log.info("Rejected rows: %d. Elapsed: %.1f seconds.", rejects.total(), time.time() - started)
    if rejects.total() == 0 and reconciled:
        log.info("ETL finished: all reconciliation checks passed.")
        return 0
    log.error("ETL finished with problems. See etl_rejects.log and the FAIL lines above.")
    return 1

if __name__ == "__main__":
    sys.exit(main())
