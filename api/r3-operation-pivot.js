const { report } = require('../lib/report');
const demo = require('../lib/demo-data');

// R3 - pivot of operations (rows) by year (columns) with a roll-up total row; slice by transaction type,
// dice by region.
// GET /api/r3-operation-pivot?measure=amount&txn_type=Debit&region=Prague

// SQL: replace here after optimization. Keep the :name placeholders and the output column names/order
// from OLAP/OLAP_queries.py. Source: SQL_R3_OPT in OLAP/OLAP_queries_optimized.py.
const SQL = `
WITH daily AS (
    SELECT f.txn_type_key, f.date_key,
           COUNT(*)      AS n_txn,
           SUM(f.amount) AS amount_sum
    FROM fact_transaction f
    JOIN dim_transaction_type t ON t.txn_type_key = f.txn_type_key
    WHERE :measure IN ('amount', 'count')
      AND (:txn_type IS NULL OR t.txn_type = :txn_type)
      AND (:region IS NULL
           OR f.account_key IN (SELECT a.account_key FROM dim_account_location a
                                WHERE a.region = :region))
    GROUP BY f.txn_type_key, f.date_key
), base AS (
    SELECT t.operation,
           d.year_num,
           CASE WHEN :measure = 'count' THEN x.n_txn ELSE x.amount_sum END AS measure_value
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
ORDER BY GROUPING(operation), operation`;

const COLUMNS = ['operation', 'y1993', 'y1994', 'y1995', 'y1996', 'y1997', 'y1998', 'total'];

module.exports = report({
  name: 'R3',
  sql: SQL,
  columns: COLUMNS,
  params: (p) => ({
    measure: p.oneOf('measure', ['amount', 'count'], 'amount'),
    txn_type: p.oneOf('txn_type', ['Credit', 'Debit']),
    region: p.text('region'),
  }),
  demo: demo.r3,
});
