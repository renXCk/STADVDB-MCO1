const { query } = require('../lib/db');

// GET /api/net-flow?year_from=1993&year_to=1998&region=north%20Moravia&level=quarter
// Net flow (sum of signed_amount) per period. Every value is bound as a parameter.
const LEVELS = {
  year: 'd.year_num',
  quarter: "CONCAT(d.year_num, ' Q', d.quarter_num)",
  month: 'd.year_month_label',
};

module.exports = async (req, res) => {
  const q = req.query || {};
  const yearFrom = Number(q.year_from || 1993);
  const yearTo = Number(q.year_to || 1998);
  const region = q.region || null;
  const periodExpr = LEVELS[q.level] || LEVELS.quarter; // whitelist: never interpolate raw input

  if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom > yearTo) {
    return res.status(400).json({ error: 'year_from and year_to must be whole years, from <= to' });
  }

  const sql = `
    SELECT ${periodExpr} AS period,
           COUNT(*)               AS transactions,
           SUM(f.signed_amount)   AS net_flow
    FROM fact_transaction f
    JOIN dim_date d              ON d.date_key = f.date_key
    JOIN dim_account_location a  ON a.account_key = f.account_key
    WHERE d.year_num BETWEEN ? AND ?
      AND (? IS NULL OR a.region = ?)
    GROUP BY period
    ORDER BY MIN(d.date_key)`;

  const started = Date.now();
  try {
    const rows = await query(sql, [yearFrom, yearTo, region, region]);
    res.status(200).json({ rows, ms: Date.now() - started });
  } catch (e) {
    if (e.code === 'NO_DB_CONFIG') return res.status(503).json({ error: 'Database is not connected yet', code: e.code });
    if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Warehouse tables are not created yet', code: e.code });
    res.status(500).json({ error: 'Query failed', code: e.code || 'error' });
  }
};
