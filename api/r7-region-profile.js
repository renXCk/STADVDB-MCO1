const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R7 - region profile: drill-across (transactions and loans joined through the shared region dimension),
// slice by region, dice by year range.
// GET /api/r7-region-profile?year_from=1996&year_to=1998&region=Prague

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R7 in OLAP/OLAP_queries.py (no optimized version yet).
const SQL = `
WITH accts AS (
    SELECT a.region, COUNT(*) AS account_count
    FROM dim_account_location a
    WHERE (:region IS NULL OR a.region = :region)
    GROUP BY a.region
), txn AS (
    SELECT a.region, COUNT(*) AS txn_count, SUM(f.signed_amount) AS net_cash_flow
    FROM fact_transaction f
    JOIN dim_date d ON d.date_key = f.date_key
    JOIN dim_account_location a ON a.account_key = f.account_key
    WHERE d.year_num BETWEEN COALESCE(:year_from, 1993) AND COALESCE(:year_to, 1998)
      AND (:region IS NULL OR a.region = :region)
    GROUP BY a.region
), loans AS (
    SELECT a.region, COUNT(*) AS loan_count, SUM(l.loan_amount) AS loan_amount,
           SUM(CASE WHEN s.payment_health = 'Bad' THEN 1 ELSE 0 END) AS problem_loans
    FROM fact_loan l
    JOIN dim_date d ON d.date_key = l.grant_date_key
    JOIN dim_account_location a ON a.account_key = l.account_key
    JOIN dim_loan_status s ON s.loan_status_key = l.loan_status_key
    WHERE d.year_num BETWEEN COALESCE(:year_from, 1993) AND COALESCE(:year_to, 1998)
      AND (:region IS NULL OR a.region = :region)
    GROUP BY a.region
)
SELECT
    c.region,
    c.account_count,
    COALESCE(t.txn_count, 0) AS txn_count,
    COALESCE(t.net_cash_flow, 0) AS net_cash_flow,
    ROUND(COALESCE(t.net_cash_flow, 0) / c.account_count, 2) AS net_cash_flow_per_account,
    COALESCE(l.loan_count, 0) AS loans_granted,
    COALESCE(l.loan_amount, 0) AS loan_amount,
    COALESCE(l.problem_loans, 0) AS problem_loans,
    ROUND(100.0 * COALESCE(l.loan_count, 0) / c.account_count, 2) AS loans_per_100_accounts
FROM accts c
LEFT JOIN txn t ON t.region = c.region
LEFT JOIN loans l ON l.region = c.region
ORDER BY c.region`;

const COLUMNS = ['region', 'account_count', 'txn_count', 'net_cash_flow', 'net_cash_flow_per_account',
  'loans_granted', 'loan_amount', 'problem_loans', 'loans_per_100_accounts'];

module.exports = report({
  name: 'R7',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    year_from: p.year('year_from'),
    year_to: p.year('year_to'),
    region: p.text('region'),
  }),
  demo: demo.r7,
});
