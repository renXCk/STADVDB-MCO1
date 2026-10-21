"""
OLAP_queries_optimized.py - optimized versions of R1-R4.

Put this file in the same folder as OLAP_queries.py. It loads the original file, replaces the SQL of
R1-R4 with restructured versions, and keeps
everything else (connection code, parameters, R5-R7) exactly as it was. The original file is not
modified, so the baseline stays available.

Run it exactly like the original:
    python OLAP\\OLAP_queries_optimized.py
Test it with your functional tests (the same 37 tests must pass):
    set OLAP_FILE=OLAP\\OLAP_queries_optimized.py
    python OLAP\\test_OLAP.py
Time it with the performance script (from inside the OLAP folder):
    python perf_baseline.py --module OLAP_queries_optimized --label optimized
"""
import sys

sys.dont_write_bytecode = True

import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "OLAP_queries_original", os.path.join(_here, "OLAP_queries.py"))
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)
globals().update({k: v for k, v in vars(_base).items() if not k.startswith("__")})

# ---------------------------------------------------------------------------------------------
# R1 - optimized.
# Baseline problem: 284,409 fact rows were each joined one by one to dim_date's type table AND to
# dim_account_location (which is only needed when a region is given), then grouped.
# Changes:
#  (1) Aggregate the fact table FIRST, by (date_key, txn_type_key), straight from the covering index
#      idx_ft_date_cover. That gives a few thousand rows instead of 284k.
#  (2) Join dim_date and dim_transaction_type to those few rows only.
#  (3) The date range is applied on date_key (the fact table's own index) instead of through a join.
#  (4) dim_account_location is used only when a region is given (an IN subquery that MySQL drops
#      when the region is NULL).
# ---------------------------------------------------------------------------------------------
SQL_R1_OPT = """
WITH daily AS (
    SELECT f.date_key, f.txn_type_key,
           COUNT(*)             AS n_txn,
           SUM(f.amount)        AS amount_sum,
           SUM(f.signed_amount) AS net_sum
    FROM fact_transaction f
    WHERE f.date_key BETWEEN
              (SELECT MIN(date_key) FROM dim_date
               WHERE full_date >= COALESCE(%(date_from)s, '1993-01-01'))
          AND (SELECT MAX(date_key) FROM dim_date
               WHERE full_date <= COALESCE(%(date_to)s, '1998-12-31'))
      AND (%(region)s IS NULL
           OR f.account_key IN (SELECT a.account_key FROM dim_account_location a
                                WHERE a.region = %(region)s))
    GROUP BY f.date_key, f.txn_type_key
), period_totals AS (
    SELECT
        CASE %(level)s
            WHEN 'year'    THEN CAST(d.year_num AS CHAR)
            WHEN 'quarter' THEN CONCAT(d.year_num, '-Q', d.quarter_num)
            WHEN 'month'   THEN d.year_month_label
            WHEN 'day'     THEN CAST(d.full_date AS CHAR)
        END AS period,
        MIN(d.full_date) AS period_start,
        CAST(SUM(x.n_txn) AS SIGNED) AS txn_count,
        SUM(CASE WHEN t.txn_type = 'Credit' THEN x.amount_sum ELSE 0 END) AS total_credit,
        SUM(CASE WHEN t.txn_type = 'Debit'  THEN x.amount_sum ELSE 0 END) AS total_debit,
        SUM(x.net_sum) AS net_cash_flow
    FROM daily x
    JOIN dim_date d ON d.date_key = x.date_key
    JOIN dim_transaction_type t ON t.txn_type_key = x.txn_type_key
    WHERE %(level)s IN ('year', 'quarter', 'month', 'day')
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

# ---------------------------------------------------------------------------------------------
# R2 - optimized.
# Baseline problem: 803,465 fact rows were read, then joined to the type table (where the Credit
# filter threw 500k of them away), then to dim_account_location, then 303,495 rows were sorted and
# COUNT(DISTINCT) was computed over them.
# Changes:
#  (1) Aggregate the fact table FIRST, per account (at most 4,500 rows), applying the year range on
#      date_key and the Credit/Debit filter before any grouping.
#  (2) Join dim_account_location to those ~4,500 rows only, then do the region/district rollup.
#  (3) COUNT(DISTINCT account) becomes COUNT(*), because there is one row per account already.
# date_key is YYYYMMDD (see the schema comment), so a year range is
# year_from*10000+101 .. year_to*10000+1231.
# ---------------------------------------------------------------------------------------------
SQL_R2_OPT = """
WITH acct AS (
    SELECT f.account_key,
           COUNT(*)             AS acct_txn_count,
           SUM(f.amount)        AS acct_amount,
           SUM(f.signed_amount) AS acct_net
    FROM fact_transaction f
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    WHERE f.date_key BETWEEN COALESCE(%(year_from)s, 1993) * 10000 + 101
                         AND COALESCE(%(year_to)s, 1998) * 10000 + 1231
      AND (%(txn_type)s IS NULL OR t.txn_type = %(txn_type)s)
    GROUP BY f.account_key
)
SELECT
    CASE WHEN GROUPING(a.region) = 1 THEN 'ALL REGIONS' ELSE a.region END AS region,
    CASE WHEN GROUPING(a.region) = 1 THEN NULL
         WHEN GROUPING(a.district_name) = 1 THEN 'ALL DISTRICTS'
         ELSE a.district_name END AS district,
    CASE WHEN GROUPING(a.region) = 1 THEN 'grand total'
         WHEN GROUPING(a.district_name) = 1 THEN 'region subtotal'
         ELSE 'district' END AS row_level,
    COUNT(*) AS active_accounts,
    CAST(SUM(x.acct_txn_count) AS SIGNED) AS txn_count,
    SUM(x.acct_amount) AS total_amount,
    SUM(x.acct_net) AS net_cash_flow,
    ROUND(SUM(x.acct_amount) / COUNT(*), 2) AS amount_per_account,
    CASE WHEN GROUPING(a.district_name) = 0 THEN MAX(a.average_salary) END AS district_average_salary
FROM acct x
JOIN dim_account_location a ON a.account_key = x.account_key
WHERE (%(region)s IS NULL OR a.region = %(region)s)
GROUP BY a.region, a.district_name WITH ROLLUP
ORDER BY GROUPING(a.region), a.region, GROUPING(a.district_name), total_amount DESC
"""

# ---------------------------------------------------------------------------------------------
# R3 - optimized.
# Baseline problem: all 651,237 Debit rows were each joined one by one to dim_date (to get the year)
# and dim_account_location (needed only for the region filter), and seven SUM(CASE...) columns were
# evaluated on every one of them.
# Changes:
#  (1) Aggregate the fact table FIRST, by (txn_type_key, date_key), from idx_ft_type_cover (index only).
#  (2) Join dim_date for the year on those aggregated rows, instead of on 651k rows.
#  (3) The region filter is an IN subquery used only when a region is given.
# ---------------------------------------------------------------------------------------------
SQL_R3_OPT = """
WITH daily AS (
    SELECT f.txn_type_key, f.date_key,
           COUNT(*)      AS n_txn,
           SUM(f.amount) AS amount_sum
    FROM fact_transaction f
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    WHERE %(measure)s IN ('amount', 'count')
      AND (%(txn_type)s IS NULL OR t.txn_type = %(txn_type)s)
      AND (%(region)s IS NULL
           OR f.account_key IN (SELECT a.account_key FROM dim_account_location a
                                WHERE a.region = %(region)s))
    GROUP BY f.txn_type_key, f.date_key
), base AS (
    SELECT t.operation,
           d.year_num,
           CASE WHEN %(measure)s = 'count' THEN x.n_txn ELSE x.amount_sum END AS measure_value
    FROM daily x
    JOIN dim_date d ON d.date_key = x.date_key
    JOIN dim_transaction_type t ON t.txn_type_key = x.txn_type_key
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

# ---------------------------------------------------------------------------------------------
# R4 - optimized (for a much larger fact_loan).
# Baseline joined every loan to three dimensions. That is free at 682 rows but grows linearly.
# Changes:
#  (1) dim_date is no longer joined. date_key is YYYYMMDD, so the grant year is grant_date_key DIV 10000
#      and the year filter becomes a range on grant_date_key (can use the covering index).
#  (2) dim_account_location is joined only when it is needed (grouping by region or filtering a region).
#      Otherwise the join condition is constant-false and no account lookups happen.
#  (3) All other columns come from the covering index idx_fl_cover, so fact_loan itself is never touched.
#  (4) dim_loan_status (4 rows) stays joined; the optimizer reads it once.
# ---------------------------------------------------------------------------------------------
SQL_R4_OPT = """
SELECT
    CASE %(group_by)s
        WHEN 'region'   THEN a.region
        WHEN 'status'   THEN CONCAT(s.status_code, ' - ', s.status_desc)
        WHEN 'duration' THEN CONCAT(l.duration_months, ' months')
        WHEN 'year'     THEN CAST(l.grant_date_key DIV 10000 AS CHAR)
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
LEFT JOIN dim_account_location a
       ON a.account_key = l.account_key
      AND (%(group_by)s = 'region' OR %(region)s IS NOT NULL)
WHERE %(group_by)s IN ('region', 'status', 'duration', 'year')
  AND l.grant_date_key BETWEEN COALESCE(%(year_from)s, 1993) * 10000 + 101
                           AND COALESCE(%(year_to)s, 1998) * 10000 + 1231
  AND (%(phase)s IS NULL OR s.contract_phase = %(phase)s)
  AND (%(health)s IS NULL OR s.payment_health = %(health)s)
  AND (%(region)s IS NULL OR a.region = %(region)s)
  AND (%(duration)s IS NULL OR l.duration_months = %(duration)s)
GROUP BY grp
ORDER BY grp
"""

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

REPORTS = {name: dict(report) for name, report in _base.REPORTS.items()}
REPORTS["R1_cash_flow_trend"]["sql"] = SQL_R1_OPT
REPORTS["R2_regional_rollup"]["sql"] = SQL_R2_OPT
REPORTS["R3_operation_by_year_pivot"]["sql"] = SQL_R3_OPT
REPORTS["R4_loan_portfolio"]["sql"] = SQL_R4_OPT
REPORTS["R5_top_accounts_by_region"]["sql"] = SQL_R5
REPORTS["R6_transaction_mix"]["sql"] = SQL_R6
REPORTS["R7_region_profile_drill_across"]["sql"] = SQL_R7
REPORT_SQL = {name: report["sql"].strip() for name, report in REPORTS.items()}

# the original main() reads these names from its own module, so point them at the optimized ones
_base.REPORTS = REPORTS
_base.REPORT_SQL = REPORT_SQL

if __name__ == "__main__":
    sys.exit(_base.main())
