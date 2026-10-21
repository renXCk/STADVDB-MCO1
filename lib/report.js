const { query, configured } = require('./db');

// Shared plumbing for the api/r*.js report endpoints.
// Each endpoint gives: its SQL, its output columns (names and order as in OLAP/OLAP_queries.py),
// a function that reads and validates the query-string parameters, and a demo-data function.
// The response is always { report, params, columns, rows, ms, source } with every row rebuilt in
// COLUMNS order, so the JSON does not depend on how the SQL is written.

// Output columns that hold text. Every other column is numeric (mysql2 returns DECIMAL as a string).
const TEXT_COLUMNS = new Set([
  'period', 'region', 'district', 'row_level', 'operation', 'grp',
  'district_name', 'frequency', 'txn_type', 'purpose',
]);

class BadParam extends Error {}

// Reads one query-string value at a time. Empty, missing or "NULL" means NULL (the report's default).
function reader(q) {
  const raw = (name) => {
    const v = q[name];
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s === '' || s.toUpperCase() === 'NULL' ? null : s;
  };
  return {
    oneOf(name, allowed, fallback = null) {
      const v = raw(name);
      if (v === null) return fallback;
      if (!allowed.includes(v)) throw new BadParam(`${name} must be one of: ${allowed.join(', ')}`);
      return v;
    },
    int(name, { min, max, allowed } = {}) {
      const v = raw(name);
      if (v === null) return null;
      const n = Number(v);
      if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) throw new BadParam(`${name} must be a whole number`);
      if (allowed && !allowed.includes(n)) throw new BadParam(`${name} must be one of: ${allowed.join(', ')}`);
      if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
        throw new BadParam(`${name} must be between ${min} and ${max}`);
      }
      return n;
    },
    year(name) {
      return this.int(name, { min: 1993, max: 1998 });
    },
    date(name) {
      const v = raw(name);
      if (v === null) return null;
      const d = new Date(v + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
        throw new BadParam(`${name} must be a date like 1997-01-31`);
      }
      return v;
    },
    text(name, maxLength = 60) {
      const v = raw(name);
      if (v !== null && v.length > maxLength) throw new BadParam(`${name} is too long`);
      return v;
    },
  };
}

function shape(name, rows, columns) {
  return rows.map((row) => {
    const out = {};
    for (const c of columns) {
      if (!(c in row)) {
        const err = new Error(`${name}: the SQL did not return the column "${c}"`);
        err.code = 'BAD_SHAPE';
        throw err;
      }
      const v = row[c];
      if (v === null || v === undefined) out[c] = null;
      else if (TEXT_COLUMNS.has(c)) out[c] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      else out[c] = Number(v);
    }
    return out;
  });
}

const UNREACHABLE = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST',
  'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR',
]);

function sendError(res, name, e) {
  if (e.code === 'ER_NO_SUCH_TABLE') return res.status(503).json({ error: 'Warehouse tables are not created yet', code: e.code });
  if (UNREACHABLE.has(e.code)) return res.status(503).json({ error: 'Database is unreachable', code: e.code });
  console.error(name, e);
  if (e.code === 'BAD_SHAPE') return res.status(500).json({ error: e.message, code: e.code });
  res.status(500).json({ error: 'Query failed', code: e.code || 'error' });
}

// Builds the request handler for one report.
function report({ name, sql, columns, params, demo }) {
  return async (req, res) => {
    let bound;
    try {
      bound = params(reader(req.query || {}));
    } catch (e) {
      if (e instanceof BadParam) return res.status(400).json({ error: e.message, code: 'BAD_PARAM' });
      throw e;
    }
    const started = Date.now();
    try {
      const source = configured() ? 'db' : 'demo';
      const raw = source === 'db' ? await query(sql, bound) : demo(bound);
      const rows = shape(name, raw, columns);
      // the warehouse only changes when the ETL reloads it, so the CDN may keep a result for a day
      // (and serve it stale while it refreshes for a week)
      res.setHeader('Cache-Control', source === 'db' ? 's-maxage=86400, stale-while-revalidate=604800' : 'no-store');
      res.status(200).json({ report: name, params: bound, columns, rows, ms: Date.now() - started, source });
    } catch (e) {
      sendError(res, name, e);
    }
  };
}

module.exports = { report, reader, BadParam, sendError };
