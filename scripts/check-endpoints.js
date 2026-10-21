// Checks every /api/r* endpoint against the CSV files written by OLAP/OLAP_queries.py, plus the
// warehouse control totals. Start the server first (npm start), then run: npm run check
// BASE_URL=https://your-app.vercel.app npm run check   checks a deployed copy instead.
const fs = require('fs');
const path = require('path');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CSV_DIR = path.join(__dirname, '..', 'olap_results');
const TOLERANCE = 0.005;

// Example parameters: the "example" entries of REPORTS in OLAP/OLAP_queries.py (the CSVs were made with these).
const REPORTS = [
  ['R1', 'r1-cash-flow', 'R1_cash_flow_trend', { level: 'month', date_from: '1997-01-01', date_to: '1997-12-31' }],
  ['R2', 'r2-regional', 'R2_regional_rollup', { year_from: 1996, year_to: 1998, txn_type: 'Credit' }],
  ['R3', 'r3-operation-pivot', 'R3_operation_by_year_pivot', { measure: 'amount', txn_type: 'Debit' }],
  ['R4', 'r4-loan-portfolio', 'R4_loan_portfolio', { group_by: 'region' }],
  ['R5', 'r5-top-accounts', 'R5_top_accounts_by_region', { region: 'Prague', year: 1998, top_n: 5 }],
  ['R6', 'r6-transaction-mix', 'R6_transaction_mix', { year: 1997 }],
  ['R7', 'r7-region-profile', 'R7_region_profile_drill_across', { year_from: 1996, year_to: 1998 }],
];

// Warehouse control totals (same values as OLAP/test_OLAP.py and the ETL reconciliation).
const CONTROL = { transactions: 1056320, netCashFlow: 197151288.70, loans: 682, loanAmount: 103261740.00 };

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

async function get(endpoint, params) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${BASE_URL}/api/${endpoint}?${qs}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error || 'no message'}${body.code ? ' (' + body.code + ')' : ''}`);
  return body;
}

function sameCell(expected, actual) {
  if (expected === '') return actual === null;
  if (actual === null || actual === undefined) return false;
  const n = Number(expected);
  if (expected.trim() !== '' && !Number.isNaN(n) && typeof actual === 'number') return Math.abs(n - actual) <= TOLERANCE;
  return expected === String(actual);
}

function compare(csvRows, body) {
  const [header, ...expected] = csvRows;
  if (header.join(',') !== body.columns.join(',')) {
    return `columns differ: expected [${header.join(', ')}], got [${body.columns.join(', ')}]`;
  }
  const keys = body.rows.length ? Object.keys(body.rows[0]).join(',') : header.join(',');
  if (keys !== header.join(',')) return `row keys differ from the columns: ${keys}`;
  if (expected.length !== body.rows.length) return `expected ${expected.length} rows, got ${body.rows.length}`;
  for (let r = 0; r < expected.length; r++) {
    for (let c = 0; c < header.length; c++) {
      const actual = body.rows[r][header[c]];
      if (!sameCell(expected[r][c], actual)) {
        return `row ${r + 1}, ${header[c]}: expected ${expected[r][c] || 'NULL'}, got ${actual === null ? 'NULL' : actual}`;
      }
    }
  }
  return null;
}

function close(a, b) {
  return Math.abs(a - b) <= TOLERANCE;
}

async function main() {
  console.log(`Checking ${BASE_URL}`);
  let failed = 0;
  let demo = false;
  const line = (status, label, detail = '') => console.log(`${status.padEnd(5)} ${label}${detail ? '  ' + detail : ''}`);

  for (const [label, endpoint, csvName, params] of REPORTS) {
    try {
      const body = await get(endpoint, params);
      if (body.source !== 'db') {
        demo = true;
        line('SKIP', label, '(demo data, database not connected)');
        continue;
      }
      const csv = parseCsv(fs.readFileSync(path.join(CSV_DIR, csvName + '.csv'), 'utf8'));
      const problem = compare(csv, body);
      if (problem) { failed++; line('FAIL', label, problem); }
      else line('PASS', label, `${body.rows.length} rows, ${body.ms} ms, source=${body.source}`);
    } catch (e) {
      failed++;
      line('FAIL', label, e.message);
    }
  }

  try {
    const r2 = await get('r2-regional', {});
    const r4 = await get('r4-loan-portfolio', { group_by: 'region' });
    if (r2.source !== 'db' || r4.source !== 'db') {
      demo = true;
      line('SKIP', 'Control totals', '(demo data, database not connected)');
    } else {
      const grand = r2.rows.find((r) => r.row_level === 'grand total') || {};
      const loans = r4.rows.reduce((s, r) => s + r.loan_count, 0);
      const loanAmount = r4.rows.reduce((s, r) => s + r.total_loan_amount, 0);
      const checks = [
        ['transactions', grand.txn_count, CONTROL.transactions],
        ['net cash flow', grand.net_cash_flow, CONTROL.netCashFlow],
        ['loans', loans, CONTROL.loans],
        ['total loan amount', loanAmount, CONTROL.loanAmount],
      ];
      for (const [name, actual, expected] of checks) {
        if (close(actual, expected)) line('PASS', `Control: ${name}`, String(expected));
        else { failed++; line('FAIL', `Control: ${name}`, `expected ${expected}, got ${actual}`); }
      }
    }
  } catch (e) {
    failed++;
    line('FAIL', 'Control totals', e.message);
  }

  if (demo) console.log('Note: the server has no database settings (.env.local), so database checks were skipped.');
  console.log(failed ? `${failed} check(s) failed.` : 'All checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message.includes('fetch failed') ? `Cannot reach ${BASE_URL}. Start the server with npm start.` : e);
  process.exit(1);
});
