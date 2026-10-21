const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R6 - transaction mix: roll-up / drill-down on Transaction type (type > operation > purpose),
// slice by year, region and type.
// GET /api/r6-transaction-mix?year=1997&region=Prague&txn_type=Debit

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R6 in OLAP/OLAP_queries.py (no optimized version yet).

const SQL = `
WITH transaction_summary AS (
    SELECT
        f.txn_type_key,
        COUNT(*) AS txn_count,
        COUNT(f.amount) AS amount_count,
        SUM(f.amount) AS total_amount
    FROM fact_transaction f
    JOIN dim_date d
        ON d.date_key = f.date_key
    WHERE (:year IS NULL OR d.year_num = :year)
      AND (
          :region IS NULL
          OR EXISTS (
              SELECT 1
              FROM dim_account_location a
              WHERE a.account_key = f.account_key
                AND a.region = :region
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
WHERE (:txn_type IS NULL OR t.txn_type = :txn_type)
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
    t.k_symbol`;


const COLUMNS = ['txn_type', 'operation', 'purpose', 'row_level', 'txn_count', 'total_amount', 'avg_amount'];

module.exports = report({
  name: 'R6',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    year: p.year('year'),
    region: p.text('region'),
    txn_type: p.oneOf('txn_type', ['Credit', 'Debit']),
  }),
  demo: demo.r6,
});
