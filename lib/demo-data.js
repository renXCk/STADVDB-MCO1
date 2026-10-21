// Demo data for the report endpoints. Used only when lib/db.js has no database settings, so the whole
// dashboard works without MySQL. Everything is generated from a fixed seed (same numbers every run),
// with the warehouse's shape (8 regions, 76 districts, 4,500 accounts, 682 loans, 1993-1998) and
// magnitudes close to the real report outputs in olap_results/. Each function takes the same parameters
// as the matching SQL and returns rows with the same columns.

// region, transaction weight, accounts, loans, problem loans, total loan amount, districts
const REGIONS = [
  ['central Bohemia', 102994, 574, 90, 10, 13985304, ['Benesov', 'Beroun', 'Kladno', 'Kolin', 'Kutna Hora', 'Melnik',
    'Mlada Boleslav', 'Nymburk', 'Praha - vychod', 'Praha - zapad', 'Pribram', 'Rakovnik']],
  ['east Bohemia', 93249, 544, 84, 9, 13943724, ['Havlickuv Brod', 'Hradec Kralove', 'Chrudim', 'Jicin', 'Nachod',
    'Pardubice', 'Rychnov nad Kneznou', 'Semily', 'Svitavy', 'Trutnov', 'Usti nad Orlici']],
  ['north Bohemia', 82389, 457, 61, 1, 7486620, ['Ceska Lipa', 'Decin', 'Chomutov', 'Jablonec n. Nisou', 'Liberec',
    'Litomerice', 'Louny', 'Most', 'Teplice', 'Usti nad Labem']],
  ['north Moravia', 143435, 793, 117, 18, 18081312, ['Bruntal', 'Frydek - Mistek', 'Karvina', 'Novy Jicin', 'Olomouc',
    'Opava', 'Ostrava - mesto', 'Prerov', 'Sumperk', 'Vsetin']],
  ['Prague', 99886, 554, 84, 7, 12932412, ['Hl.m. Praha']],
  ['south Bohemia', 65702, 370, 60, 9, 9374136, ['Ceske Budejovice', 'Cesky Krumlov', 'Jindrichuv Hradec', 'Pelhrimov',
    'Pisek', 'Prachatice', 'Strakonice', 'Tabor']],
  ['south Moravia', 138938, 778, 129, 13, 19678848, ['Blansko', 'Brno - mesto', 'Brno - venkov', 'Breclav', 'Hodonin',
    'Jihlava', 'Kromeriz', 'Prostejov', 'Trebic', 'Uherske Hradiste', 'Vyskov', 'Zlin', 'Znojmo', 'Zdar nad Sazavou']],
  ['west Bohemia', 76872, 430, 57, 9, 7779384, ['Domazlice', 'Cheb', 'Karlovy Vary', 'Klatovy', 'Plzen - jih',
    'Plzen - mesto', 'Plzen - sever', 'Rokycany', 'Sokolov', 'Tachov']],
].map(([name, weight, accounts, loans, problems, loanAmount, districts]) =>
  ({ name, weight, accounts, loans, problems, loanAmount, districts }));

// txn_type, operation, purpose (k_symbol), yearly count, average amount, first year
const DETAILS = [
  ['Credit', 'Collection from Another Bank', 'Old-age Pension Payment', 7956, 5521, 1993],
  ['Credit', 'Collection from Another Bank', 'Regular Transaction', 9306, 17560, 1993],
  ['Credit', 'Credit in Cash', 'Regular Transaction', 41628, 15614, 1993],
  ['Credit', 'N/A', 'Interest Credited', 48788, 151, 1993],
  ['Debit', 'Credit Card Withdrawal', 'Regular Transaction', 2166, 2276, 1994],
  ['Debit', 'Remittance to Another Bank', 'Household Payment', 31289, 4135, 1993],
  ['Debit', 'Remittance to Another Bank', 'Insurance Payment', 4931, 1292, 1993],
  ['Debit', 'Remittance to Another Bank', 'Loan Payment', 3615, 4109, 1993],
  ['Debit', 'Remittance to Another Bank', 'Regular Transaction', 16435, 1937, 1993],
  ['Debit', 'Withdrawal in Cash', 'Household Payment', 720, 8274, 1993],
  ['Debit', 'Withdrawal in Cash', 'Insurance Payment', 11, 1055, 1993],
  ['Debit', 'Withdrawal in Cash', 'Payment of Statement', 43151, 17, 1993],
  ['Debit', 'Withdrawal in Cash', 'Regular Transaction', 74006, 8507, 1993],
  ['Debit', 'Withdrawal in Cash', 'Sanction Interest if Negative Balance', 407, 17, 1993],
].map(([type, operation, purpose, count, avg, from]) => ({ type, operation, purpose, count, avg, from }));

const YEARS = [1993, 1994, 1995, 1996, 1997, 1998];
const YEAR_TXNS = { 1993: 30000, 1994: 76000, 1995: 113000, 1996: 172000, 1997: 284409, 1998: 380911 };
const STATUSES = {
  A: ['Contract finished, no problems', 'Finished', 'Good'],
  B: ['Contract finished, loan not paid', 'Finished', 'Bad'],
  C: ['Contract running, OK so far', 'Running', 'Good'],
  D: ['Contract running, client in debt', 'Running', 'Bad'],
};

// Deterministic pseudo-random number in [0, 1) from a list of integers.
function rand(...ints) {
  let h = 2166136261;
  for (const n of ints) {
    h ^= n;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const round2 = (x) => Math.round(x * 100) / 100;
const lower = (s) => s.toLowerCase();
const byText = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0); // like MySQL's _ci collation
const regionIndex = (name) => (name == null ? -1 : REGIONS.findIndex((r) => r.name === name));

// ---- transaction cube: one cell per (day, region, detail) -------------------------------------------
let cube;
function getCube() {
  if (cube) return cube;
  const days = [];
  for (let t = Date.UTC(1993, 0, 1); t <= Date.UTC(1998, 11, 31); t += 864e5) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    days.push({ y, q: Math.ceil(m / 3), m, date: d.toISOString().slice(0, 10) });
  }
  const R = REGIONS.length;
  const K = DETAILS.length;
  const regionTotal = REGIONS.reduce((s, r) => s + r.weight, 0);
  const detailTotal = DETAILS.reduce((s, k) => s + k.count, 0);
  const counts = new Float64Array(days.length * R * K);
  const amounts = new Float64Array(days.length * R * K);
  days.forEach((day, i) => {
    const daysInYear = day.y % 4 === 0 ? 366 : 365;
    const base = (YEAR_TXNS[day.y] / daysInYear) * (0.85 + (0.3 * (day.m - 1)) / 11);
    for (let r = 0; r < R; r++) {
      for (let k = 0; k < K; k++) {
        const det = DETAILS[k];
        if (day.y < det.from) continue;
        const expected = base * (REGIONS[r].weight / regionTotal) * (det.count / detailTotal);
        const c = Math.floor(expected * (0.7 + 0.6 * rand(i, r, k)) + rand(i, r, k, 7));
        if (!c) continue;
        // money leaves in January and June, comes back the rest of the year
        const season = det.type === 'Debit'
          ? (day.m === 1 ? 1.32 : day.m === 6 ? 1.12 : 0.98)
          : (day.m === 6 ? 1.06 : 1);
        const idx = (i * R + r) * K + k;
        counts[idx] = c;
        amounts[idx] = Math.round(c * det.avg * season * (0.8 + 0.4 * rand(i, r, k, 9)) * 10) / 10;
      }
    }
  });
  cube = { days, counts, amounts, R, K };
  return cube;
}

// Calls fn(day, regionIdx, detail, count, amount) for every non-empty cell that passes the filters.
function scan({ from = '1993-01-01', to = '1998-12-31', yearFrom = 1993, yearTo = 1998, region = null, type = null }, fn) {
  const { days, counts, amounts, R, K } = getCube();
  const ri = regionIndex(region);
  if (region != null && ri < 0) return;
  days.forEach((day, i) => {
    if (day.date < from || day.date > to || day.y < yearFrom || day.y > yearTo) return;
    for (let r = 0; r < R; r++) {
      if (ri >= 0 && r !== ri) continue;
      for (let k = 0; k < K; k++) {
        if (type && DETAILS[k].type !== type) continue;
        const idx = (i * R + r) * K + k;
        if (counts[idx]) fn(day, r, DETAILS[k], counts[idx], amounts[idx]);
      }
    }
  });
}

function regionTotals(filter) {
  const totals = REGIONS.map(() => ({ count: 0, credit: 0, debit: 0 }));
  scan(filter, (day, r, det, c, a) => {
    totals[r].count += c;
    totals[r][det.type === 'Credit' ? 'credit' : 'debit'] += a;
  });
  return totals;
}

// ---- accounts and loans ----------------------------------------------------------------------------
let accounts;
function getAccounts() {
  if (accounts) return accounts;
  accounts = [];
  let id = 1;
  REGIONS.forEach((reg, r) => {
    for (let i = 0; i < reg.accounts; i++) {
      const u = rand(101, r, i);
      const f = rand(102, r, i);
      accounts.push({
        region: r,
        district: reg.districts[Math.floor(rand(103, r, i) * reg.districts.length)],
        account_id: (id += 1 + Math.floor(rand(104, r, i) * 3)),
        frequency: f < 0.9 ? 'Monthly' : f < 0.95 ? 'Weekly' : 'After Transaction',
        openYear: YEARS[Math.min(4, Math.floor(rand(105, r, i) ** 1.6 * 5))],
        weight: 0.3 + u * u * 2,
        debitRatio: 0.86 + 0.13 * rand(106, r, i),
      });
    }
  });
  return accounts;
}

const salary = (r, district) => (REGIONS[r].name === 'Prague'
  ? 12541 : 8000 + Math.round(rand(107, r, district.length, district.charCodeAt(0)) * 3500));

let loans;
function getLoans() {
  if (loans) return loans;
  loans = [];
  const yearWeights = [20, 100, 120, 140, 200, 102];
  REGIONS.forEach((reg, r) => {
    const list = [];
    const order = Array.from({ length: reg.loans }, (_, i) => i).sort((a, b) => rand(201, r, a) - rand(201, r, b));
    const bad = new Set(order.slice(0, reg.problems));
    for (let i = 0; i < reg.loans; i++) {
      let pick = rand(202, r, i) * 682;
      let y = 0;
      while (pick > yearWeights[y]) pick -= yearWeights[y++];
      const year = YEARS[Math.min(y, 5)];
      const duration = [12, 24, 36, 48, 60][Math.floor(rand(203, r, i) * 5)];
      const finished = year + duration / 12 <= 1998;
      const status = bad.has(i) ? (finished ? 'B' : 'D') : (finished ? 'A' : 'C');
      list.push({ region: r, year, duration, status, raw: 40000 + rand(204, r, i) ** 1.4 * 420000 });
    }
    // scale the region's loans so the totals match the warehouse
    const rawTotal = list.reduce((s, l) => s + l.raw, 0);
    let assigned = 0;
    list.forEach((l, i) => {
      l.amount = i === list.length - 1 ? reg.loanAmount - assigned : Math.round((l.raw / rawTotal) * reg.loanAmount);
      assigned += l.amount;
      l.payment = Math.round(l.amount / l.duration);
    });
    loans.push(...list);
  });
  return loans;
}

// ---- reports ----------------------------------------------------------------------------------------
function r1({ level, date_from, date_to, region }) {
  const key = {
    year: (d) => String(d.y),
    quarter: (d) => `${d.y}-Q${d.q}`,
    month: (d) => `${d.y}-${String(d.m).padStart(2, '0')}`,
    day: (d) => d.date,
  }[level];
  if (!key) return [];
  const periods = new Map();
  scan({ from: date_from || undefined, to: date_to || undefined, region }, (day, r, det, c, a) => {
    const k = key(day);
    if (!periods.has(k)) periods.set(k, { period: k, txn_count: 0, total_credit: 0, total_debit: 0 });
    const p = periods.get(k);
    p.txn_count += c;
    if (det.type === 'Credit') p.total_credit += a; else p.total_debit += a;
  });
  let cumulative = 0;
  let previous = null;
  return [...periods.values()].map((p) => {
    const net = round2(p.total_credit - p.total_debit);
    cumulative = round2(cumulative + net);
    const change = previous === null || previous === 0 ? null : round2((100 * (net - previous)) / Math.abs(previous));
    previous = net;
    return { ...p, total_credit: round2(p.total_credit), total_debit: round2(p.total_debit),
      net_cash_flow: net, cumulative_net: cumulative, net_change_pct: change };
  });
}

function r2({ year_from, year_to, txn_type, region }) {
  const yearFrom = year_from || 1993;
  const yearTo = year_to || 1998;
  const totals = regionTotals({ yearFrom, yearTo, type: txn_type });
  const ri = regionIndex(region);
  if (region != null && ri < 0) return [];
  const rows = [];
  const grand = { active_accounts: 0, txn_count: 0, total_amount: 0, net_cash_flow: 0 };
  REGIONS.forEach((reg, r) => {
    if (ri >= 0 && r !== ri) return;
    const active = getAccounts().filter((a) => a.region === r && a.openYear <= yearTo);
    const regionWeight = active.reduce((s, a) => s + a.weight, 0);
    const t = totals[r];
    const districts = reg.districts.map((name) => {
      const mine = active.filter((a) => a.district === name);
      const share = mine.reduce((s, a) => s + a.weight, 0) / regionWeight;
      return { name, n: mine.length, count: Math.round(t.count * share),
        amount: round2((t.credit + t.debit) * share), net: round2((t.credit - t.debit) * share) };
    }).filter((d) => d.n > 0 && d.count > 0).sort((a, b) => b.amount - a.amount);
    const sub = { active_accounts: 0, txn_count: 0, total_amount: 0, net_cash_flow: 0 };
    for (const d of districts) {
      rows.push({ region: reg.name, district: d.name, row_level: 'district', active_accounts: d.n, txn_count: d.count,
        total_amount: d.amount, net_cash_flow: d.net, amount_per_account: round2(d.amount / d.n),
        district_average_salary: salary(r, d.name) });
      sub.active_accounts += d.n;
      sub.txn_count += d.count;
      sub.total_amount += d.amount;
      sub.net_cash_flow += d.net;
    }
    if (!districts.length) return;
    rows.push({ region: reg.name, district: 'ALL DISTRICTS', row_level: 'region subtotal', ...sub,
      total_amount: round2(sub.total_amount), net_cash_flow: round2(sub.net_cash_flow),
      amount_per_account: round2(sub.total_amount / sub.active_accounts), district_average_salary: null });
    for (const k of Object.keys(grand)) grand[k] += sub[k];
  });
  if (!rows.length) return rows;
  rows.push({ region: 'ALL REGIONS', district: null, row_level: 'grand total', ...grand,
    total_amount: round2(grand.total_amount), net_cash_flow: round2(grand.net_cash_flow),
    amount_per_account: round2(grand.total_amount / grand.active_accounts), district_average_salary: null });
  return rows;
}

function r3({ measure, txn_type, region }) {
  if (measure !== 'amount' && measure !== 'count') return [];
  const ops = new Map();
  scan({ region, type: txn_type }, (day, r, det, c, a) => {
    if (!ops.has(det.operation)) ops.set(det.operation, Object.fromEntries(YEARS.map((y) => [y, 0])));
    ops.get(det.operation)[day.y] += measure === 'count' ? c : a;
  });
  if (!ops.size) return [];
  const row = (operation, byYear) => {
    const out = { operation };
    let total = 0;
    for (const y of YEARS) {
      out['y' + y] = round2(byYear[y]);
      total += byYear[y];
    }
    out.total = round2(total);
    return out;
  };
  const all = Object.fromEntries(YEARS.map((y) => [y, 0]));
  const rows = [...ops.keys()].sort(byText).map((op) => {
    for (const y of YEARS) all[y] += ops.get(op)[y];
    return row(op, ops.get(op));
  });
  rows.push(row('ALL OPERATIONS', all));
  return rows;
}

function r4({ group_by, phase, health, region, year_from, year_to, duration }) {
  const label = {
    region: (l) => REGIONS[l.region].name,
    status: (l) => `${l.status} - ${STATUSES[l.status][0]}`,
    duration: (l) => `${l.duration} months`,
    year: (l) => String(l.year),
  }[group_by];
  if (!label) return [];
  const groups = new Map();
  for (const l of getLoans()) {
    const [, ph, hl] = STATUSES[l.status];
    if ((phase && ph !== phase) || (health && hl !== health)) continue;
    if (region != null && REGIONS[l.region].name !== region) continue;
    if (l.year < (year_from || 1993) || l.year > (year_to || 1998)) continue;
    if (duration != null && l.duration !== duration) continue;
    const g = label(l);
    if (!groups.has(g)) groups.set(g, { n: 0, amount: 0, payment: 0, bad: 0 });
    const s = groups.get(g);
    s.n += 1;
    s.amount += l.amount;
    s.payment += l.payment;
    s.bad += hl === 'Bad' ? 1 : 0;
  }
  const total = [...groups.values()].reduce((s, g) => s + g.amount, 0);
  return [...groups.keys()].sort(byText).map((g) => {
    const s = groups.get(g);
    return { grp: g, loan_count: s.n, total_loan_amount: s.amount, avg_loan_amount: round2(s.amount / s.n),
      total_monthly_payment: s.payment, loans_with_problems: s.bad, problem_rate_pct: round2((100 * s.bad) / s.n),
      share_of_amount_pct: round2((100 * s.amount) / total) };
  });
}

function r5({ region, year, top_n }) {
  const yearFrom = year || 1993;
  const yearTo = year || 1998;
  const totals = regionTotals({ yearFrom, yearTo, region });
  const top = top_n || 5;
  const rows = [];
  REGIONS.forEach((reg, r) => {
    if (region != null && reg.name !== region) return;
    const active = getAccounts().filter((a) => a.region === r && a.openYear <= yearTo);
    const weight = active.reduce((s, a) => s + a.weight, 0);
    const meanRatio = active.reduce((s, a) => s + a.debitRatio * a.weight, 0) / weight;
    const t = totals[r];
    const list = active.map((a) => {
      const share = a.weight / weight;
      const credit = round2(t.credit * share);
      const debit = round2(Math.min(t.debit * share * (a.debitRatio / meanRatio), credit * 1.08));
      return { region: reg.name, account_id: a.account_id, district_name: a.district, frequency: a.frequency,
        txn_count: Math.max(1, Math.round(t.count * share)), total_credit: credit, total_debit: debit,
        net_cash_flow: round2(credit - debit) };
    }).sort((a, b) => b.net_cash_flow - a.net_cash_flow || a.account_id - b.account_id);
    let rank = 0;
    list.forEach((a, i) => {
      if (i === 0 || a.net_cash_flow !== list[i - 1].net_cash_flow) rank = i + 1;
      if (rank <= top) rows.push({ region: a.region, rank_in_region: rank, ...a });
    });
  });
  return rows;
}

function r6({ year, region, txn_type }) {
  const cells = new Map();
  scan({ yearFrom: year || 1993, yearTo: year || 1998, region, type: txn_type }, (day, r, det, c, a) => {
    const s = cells.get(det) || { c: 0, a: 0 };
    s.c += c;
    s.a += a;
    cells.set(det, s);
  });
  const row = (txn_type, operation, purpose, row_level, s) =>
    ({ txn_type, operation, purpose, row_level, txn_count: s.c, total_amount: round2(s.a), avg_amount: round2(s.a / s.c) });
  const add = (into, s) => { into.c += s.c; into.a += s.a; };
  const rows = [];
  const grand = { c: 0, a: 0 };
  const types = [...new Set(DETAILS.map((d) => d.type))].sort(byText);
  for (const type of types) {
    const typeSum = { c: 0, a: 0 };
    const ops = [...new Set(DETAILS.filter((d) => d.type === type).map((d) => d.operation))].sort(byText);
    for (const op of ops) {
      const opSum = { c: 0, a: 0 };
      const dets = DETAILS.filter((d) => d.type === type && d.operation === op && cells.has(d))
        .sort((a, b) => byText(a.purpose, b.purpose));
      for (const d of dets) {
        rows.push(row(type, op, d.purpose, 'detail', cells.get(d)));
        add(opSum, cells.get(d));
      }
      if (opSum.c) rows.push(row(type, op, 'ALL PURPOSES', 'operation subtotal', opSum));
      add(typeSum, opSum);
    }
    if (typeSum.c) rows.push(row(type, 'ALL OPERATIONS', null, 'type subtotal', typeSum));
    add(grand, typeSum);
  }
  if (grand.c) rows.push(row('ALL TYPES', null, null, 'grand total', grand));
  return rows;
}

function r7({ year_from, year_to, region }) {
  const yearFrom = year_from || 1993;
  const yearTo = year_to || 1998;
  const totals = regionTotals({ yearFrom, yearTo, region });
  return REGIONS.map((reg, r) => ({ reg, r })).filter(({ reg }) => region == null || reg.name === region)
    .map(({ reg, r }) => {
      const mine = getLoans().filter((l) => l.region === r && l.year >= yearFrom && l.year <= yearTo);
      const net = round2(totals[r].credit - totals[r].debit);
      return { region: reg.name, account_count: reg.accounts, txn_count: totals[r].count, net_cash_flow: net,
        net_cash_flow_per_account: round2(net / reg.accounts), loans_granted: mine.length,
        loan_amount: mine.reduce((s, l) => s + l.amount, 0),
        problem_loans: mine.filter((l) => STATUSES[l.status][2] === 'Bad').length,
        loans_per_100_accounts: round2((100 * mine.length) / reg.accounts) };
    });
}

const regions = () => REGIONS.map((r) => ({ region: r.name }));

module.exports = { r1, r2, r3, r4, r5, r6, r7, regions };
