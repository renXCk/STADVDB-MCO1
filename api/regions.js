const { query, configured } = require('../lib/db');
const { sendError } = require('../lib/report');
const demo = require('../lib/demo-data');

// GET /api/regions - region names for the filter dropdown, read from the warehouse.
const SQL = 'SELECT DISTINCT region FROM dim_account_location ORDER BY region';

module.exports = async (req, res) => {
  try {
    const source = configured() ? 'db' : 'demo';
    const rows = source === 'db' ? await query(SQL) : demo.regions();
    res.setHeader('Cache-Control', source === 'db' ? 's-maxage=3600' : 'no-store');
    res.status(200).json({ rows: rows.map((r) => ({ region: String(r.region) })), source });
  } catch (e) {
    sendError(res, 'regions', e);
  }
};
