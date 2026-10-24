// Fills the Vercel CDN cache with the dashboard's default views, so the first visitor after a deploy
// does not wait for the database. Run after each deploy: npm run warm
// BASE_URL=https://other-deployment.vercel.app npm run warm   warms another deployment.
//
// The CDN caches by exact URL, so these requests must match what public/app.js asks for: the same
// parameters in the same order, with empty values left out (see api() and the load* functions there).
const BASE_URL = (process.env.BASE_URL || 'https://stadvdb-mco-1-psi.vercel.app').replace(/\/$/, '');
const CONCURRENCY = 3; // the free database has one CPU; more parallel requests only queue up there
const YEARS = { year_from: 1993, year_to: 1998 };
const DATES = { date_from: '1993-01-01', date_to: '1998-12-31' };

function url(endpoint, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  return `${BASE_URL}/api/${endpoint}?${qs}`;
}

function defaultViews(regions) {
  return [
    // Transactions tab: KPI tiles, R2, R1 (default level and the KPI sparklines), R3, R5, R6
    url('r2-regional', YEARS),
    url('r1-cash-flow', { level: 'quarter', ...DATES }),
    url('r1-cash-flow', { level: 'month', ...DATES }),
    url('r1-cash-flow', { level: 'year', ...DATES }),
    url('r3-operation-pivot', { measure: 'amount' }),
    url('r3-operation-pivot', { measure: 'count' }),
    url('r5-top-accounts', { region: 'Prague', top_n: 5 }),
    url('r6-transaction-mix'),
    // Loans tab: KPI tiles (group_by=year) and every group_by toggle
    ...['year', 'region', 'status', 'duration'].map((g) => url('r4-loan-portfolio', { group_by: g, ...YEARS })),
    // Cross-fact tab
    url('r7-region-profile', YEARS),
    // R2 drill-down into each region, and the R5 list that follows it
    ...regions.map((region) => url('r2-regional', { ...YEARS, region })),
    ...regions.map((region) => url('r5-top-accounts', { region, top_n: 5 })),
  ];
}

async function warm(target) {
  const started = Date.now();
  try {
    const res = await fetch(target);
    await res.arrayBuffer();
    return { target, status: res.status, cache: res.headers.get('x-vercel-cache') || '-', ms: Date.now() - started };
  } catch (e) {
    return { target, status: 'ERR', cache: e.message, ms: Date.now() - started };
  }
}

async function main() {
  console.log(`Warming ${BASE_URL}`);
  const regionsRes = await warm(url('regions'));
  if (regionsRes.status !== 200) throw new Error(`Could not read the region list (${regionsRes.status} ${regionsRes.cache})`);
  const regions = (await (await fetch(url('regions'))).json()).rows.map((r) => r.region);
  const queue = [...new Set(defaultViews(regions))];
  const results = [];
  const worker = async () => {
    while (queue.length) {
      const r = await warm(queue.shift());
      results.push(r);
      console.log(`${String(r.status).padEnd(4)} ${r.cache.padEnd(6)} ${String(r.ms).padStart(6)} ms  ${r.target.slice(BASE_URL.length)}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const failed = results.filter((r) => r.status !== 200);
  console.log(`${results.length - failed.length} of ${results.length} views cached` + (failed.length ? `, ${failed.length} failed` : '') + '.');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message.includes('fetch failed') ? `Cannot reach ${BASE_URL}.` : e.message);
  process.exit(1);
});
