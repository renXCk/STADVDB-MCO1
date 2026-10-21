const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R5 - top accounts by net cash flow inside each region: drill-down to the Account level, slice by year,
// dice by region and top-N.
// GET /api/r5-top-accounts?region=Prague&year=1998&top_n=5

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R5 in OLAP/OLAP_queries.py (no optimized version yet).
const SQL = `
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
    WHERE (:year IS NULL OR d.year_num = :year)
      AND (:region IS NULL OR a.region = :region)
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
WHERE rank_in_region <= COALESCE(:top_n, 5)
ORDER BY
    region,
    rank_in_region,
    account_id`;

const COLUMNS = ['region', 'rank_in_region', 'account_id', 'district_name', 'frequency',
  'txn_count', 'total_credit', 'total_debit', 'net_cash_flow'];

module.exports = report({
  name: 'R5',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    region: p.text('region'),
    year: p.year('year'),
    top_n: p.int('top_n', { min: 1, max: 50 }),
  }),
  demo: demo.r5,
});
