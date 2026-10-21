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
      // DB_SSL_CA: the host's CA certificate (PEM) when it is not publicly trusted, e.g. Aiven
      ssl: process.env.DB_SSL === '1'
        ? { rejectUnauthorized: true, ca: process.env.DB_SSL_CA ? process.env.DB_SSL_CA.replace(/\\n/g, '\n') : undefined }
        : undefined,
      // Match the warehouse's column collation (MySQL 8 default). mysql2 otherwise connects with
      // utf8mb4_unicode_ci, and a CASE that mixes a column with CAST(... AS CHAR) (R1, R4) then falls
      // back to utf8mb4_bin, which sorts 'Prague' before 'central Bohemia'.
      charset: process.env.DB_CHARSET || 'utf8mb4_0900_ai_ci',
      // serverless: keep small; locally the dashboard fires several reports at once
      connectionLimit: Number(process.env.DB_POOL_SIZE) || (process.env.VERCEL ? 2 : 5),
      waitForConnections: true,
      namedPlaceholders: true, // :name placeholders; plain ? with an array still works
    });
  }
  return pool;
}

// Always pass user input through placeholders (? or :name), never string concatenation.
// pool.query substitutes values on the client, so MySQL plans the final SQL with literal values
// (server-side prepared statements via execute() can stop it from using the tuned indexes).
async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    const err = new Error('Database is not configured');
    err.code = 'NO_DB_CONFIG';
    throw err;
  }
  const [rows] = await p.query(sql, params);
  return rows;
}

module.exports = { query, configured };
