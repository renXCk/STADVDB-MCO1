const { query, configured } = require('../lib/db');

module.exports = async (req, res) => {
  if (!configured()) {
    return res.status(200).json({ app: 'ok', database: 'not configured' });
  }
  try {
    await query('SELECT 1 AS ok');
    res.status(200).json({ app: 'ok', database: 'connected' });
  } catch (e) {
    res.status(200).json({ app: 'ok', database: 'unreachable', reason: e.code || 'error' });
  }
};
