const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R1 - cash flow trend: roll-up / drill-down on Date, slice by region, dice by date range.
// GET /api/r1-cash-flow?level=month&date_from=1997-01-01&date_to=1997-12-31&region=Prague

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R1_OPT in OLAP/OLAP_queries_optimized.py.
const SQL = `
WITH daily AS (
    SELECT f.date_key, f.txn_type_key,
           COUNT(*)             AS n_txn,
           SUM(f.amount)        AS amount_sum,
           SUM(f.signed_amount) AS net_sum
    FROM fact_transaction f
    WHERE f.date_key BETWEEN
              (SELECT MIN(date_key) FROM dim_date
               WHERE full_date >= COALESCE(:date_from, '1993-01-01'))
          AND (SELECT MAX(date_key) FROM dim_date
               WHERE full_date <= COALESCE(:date_to, '1998-12-31'))
      AND (:region IS NULL
           OR f.account_key IN (SELECT a.account_key FROM dim_account_location a
                                WHERE a.region = :region))
    GROUP BY f.date_key, f.txn_type_key
), period_totals AS (
    SELECT
        CASE :level
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
    WHERE :level IN ('year', 'quarter', 'month', 'day')
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
ORDER BY period_start`;

const COLUMNS = ['period', 'txn_count', 'total_credit', 'total_debit', 'net_cash_flow', 'cumulative_net', 'net_change_pct'];

module.exports = report({
  name: 'R1',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    level: p.oneOf('level', ['year', 'quarter', 'month', 'day'], 'month'),
    date_from: p.date('date_from'),
    date_to: p.date('date_to'),
    region: p.text('region'),
  }),
  demo: demo.r1,
});
