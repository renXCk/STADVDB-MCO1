const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R2 - regional roll-up: roll-up / drill-down on Location (region > district), slice by transaction type,
// dice by year range and region.
// GET /api/r2-regional?year_from=1996&year_to=1998&txn_type=Credit&region=Prague

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R2_OPT in OLAP/OLAP_queries_optimized.py.
const SQL = `
WITH acct AS (
    SELECT f.account_key,
           COUNT(*)             AS acct_txn_count,
           SUM(f.amount)        AS acct_amount,
           SUM(f.signed_amount) AS acct_net
    FROM fact_transaction f
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    WHERE f.date_key BETWEEN COALESCE(:year_from, 1993) * 10000 + 101
                         AND COALESCE(:year_to, 1998) * 10000 + 1231
      AND (:txn_type IS NULL OR t.txn_type = :txn_type)
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
WHERE (:region IS NULL OR a.region = :region)
GROUP BY a.region, a.district_name WITH ROLLUP
ORDER BY GROUPING(a.region), a.region, GROUPING(a.district_name), total_amount DESC`;

const COLUMNS = ['region', 'district', 'row_level', 'active_accounts', 'txn_count', 'total_amount',
  'net_cash_flow', 'amount_per_account', 'district_average_salary'];

module.exports = report({
  name: 'R2',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    year_from: p.year('year_from'),
    year_to: p.year('year_to'),
    txn_type: p.oneOf('txn_type', ['Credit', 'Debit']),
    region: p.text('region'),
  }),
  demo: demo.r2,
});
