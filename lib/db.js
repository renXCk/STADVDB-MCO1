const mysql = require('mysql2/promise');

let pool;

function configured() {
  return Boolean(process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME);
}

function getPool() {
  if (!configured()) return null;
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      ssl: process.env.DB_SSL === '1' ? { rejectUnauthorized: true } : undefined,
      connectionLimit: 2, // serverless: keep small
      waitForConnections: true,
    });
  }
  return pool;
}

// Always pass user input through the ? placeholders, never string concatenation.
async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    const err = new Error('Database is not configured');
    err.code = 'NO_DB_CONFIG';
    throw err;
  }
  const [rows] = await p.execute(sql, params);
  return rows;
}

module.exports = { query, configured };
