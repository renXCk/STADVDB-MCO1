const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R4 - loan portfolio by a chosen dimension: slice (phase, health, region, duration), dice (grant-year range),
// roll-up / drill-down by switching group_by.
// GET /api/r4-loan-portfolio?group_by=region&phase=Running&health=Bad&region=Prague&year_from=1995&year_to=1998&duration=24

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R4_OPT in OLAP/OLAP_queries_optimized.py.
const SQL = `
SELECT
    CASE :group_by
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
      AND (:group_by = 'region' OR :region IS NOT NULL)
WHERE :group_by IN ('region', 'status', 'duration', 'year')
  AND l.grant_date_key BETWEEN COALESCE(:year_from, 1993) * 10000 + 101
                           AND COALESCE(:year_to, 1998) * 10000 + 1231
  AND (:phase IS NULL OR s.contract_phase = :phase)
  AND (:health IS NULL OR s.payment_health = :health)
  AND (:region IS NULL OR a.region = :region)
  AND (:duration IS NULL OR l.duration_months = :duration)
GROUP BY grp
ORDER BY grp`;

const COLUMNS = ['grp', 'loan_count', 'total_loan_amount', 'avg_loan_amount', 'total_monthly_payment',
  'loans_with_problems', 'problem_rate_pct', 'share_of_amount_pct'];

module.exports = report({
  name: 'R4',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    group_by: p.oneOf('group_by', ['region', 'status', 'duration', 'year'], 'region'),
    phase: p.oneOf('phase', ['Finished', 'Running']),
    health: p.oneOf('health', ['Good', 'Bad']),
    region: p.text('region'),
    year_from: p.year('year_from'),
    year_to: p.year('year_to'),
    duration: p.int('duration', { allowed: [12, 24, 36, 48, 60] }),
  }),
  demo: demo.r4,
});
