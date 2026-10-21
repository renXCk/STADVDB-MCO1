'use strict';
// Group 5 MCO1 OLAP Dashboard. Every card loads its own report (api/r1..r7) and renders as soon as its
// data arrives, so a slow report never holds up the others.

const $ = (id) => document.getElementById(id);
const YEARS = [1993, 1994, 1995, 1996, 1997, 1998];
const LEVELS = ['year', 'quarter', 'month', 'day'];
const UNIT = { year: ['year', 'years'], quarter: ['quarter', 'quarters'], month: ['month', 'months'], day: ['day', 'days'] };
const C = {
  primary: '#0b6e4f', accent: '#1fa971', credit: '#16946a', debit: '#2f6db5', net: '#1f3a30',
  ink: '#16241e', ink2: '#3d4c45', muted: '#56665e', line: '#ebe8e1', mint: '#e6f4ec',
  amber: '#e09b1a', amberInk: '#8a5a00', neg: '#c2483d',
};
const GREEN_RAMP = ['#e6f4ec', '#b5e0c8', '#74c49b', '#2f9e6f', '#0b6e4f'];
const CREDIT_SHADES = ['#0b6e4f', '#16946a', '#3fae82', '#74c49b'];
const DEBIT_SHADES = ['#1f4f86', '#2f6db5', '#5089c9', '#7ea8da'];
const RANK_SHADES = ['#0b6e4f', '#16946a', '#1fa971', '#4cb98a', '#7ccba5'];
const OP_SHORT = {
  'Collection from Another Bank': 'Collection', 'Credit Card Withdrawal': 'Card withdrawal', 'Credit in Cash': 'Cash credit',
  'No operation': 'None', 'Remittance to Another Bank': 'Remittance', 'Withdrawal in Cash': 'Cash withdrawal', 'All operations': 'All',
};
const STATUS_SHORT = { A: 'A · finished, paid', B: 'B · finished, unpaid', C: 'C · running, OK', D: 'D · running, in debt' };

// ---------------------------------------------------------------- formatting
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function compact(v, digits = 1) {
  const a = Math.abs(v);
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B'
    : a >= 1e6 ? (a / 1e6).toFixed(digits) + 'M'
      : a >= 1e3 ? (a / 1e3).toFixed(digits) + 'K' : nf0.format(a);
  return (v < 0 ? '−' : '') + s;
}
const signed = (v, digits) => (v > 0 ? '+' : '') + compact(v, digits);
const int = (v) => nf0.format(v);
const money = (v) => nf2.format(v);
const pct = (v, d = 1) => `${Number(v).toFixed(d)}%`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
const maxBy = (rows, f) => rows.reduce((best, r) => (best === null || f(r) > f(best) ? r : best), null);
const minBy = (rows, f) => rows.reduce((best, r) => (best === null || f(r) < f(best) ? r : best), null);
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- state
const DEFAULTS = { yearFrom: 1993, yearTo: 1998, region: '', level: 'month', type: '' };
const state = {
  tab: 'transactions',
  ...DEFAULTS,
  regions: [],
  r1: { level: 'month', path: [] }, // path: drill stack of { label, level, parentLevel, from, to }
  r2: { region: null, measure: 'total_amount' },
  r3: { measure: 'amount', swapped: false },
  r4: { group: 'region', phase: '', health: '', duration: '' },
  r5: { region: '', year: '', top: 5 },
  r6: { year: '', measure: 'total_amount' },
  r7: { sort: 'region', dir: 1 },
};
const dirty = { transactions: true, loans: true, cross: true };

// ---------------------------------------------------------------- API
const cache = new Map();
const sources = new Set();
function api(endpoint, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') qs.set(k, v);
  const url = `/api/${endpoint}?${qs}`;
  if (!cache.has(url)) {
    const request = fetch(url)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ? `${body.error}${body.code ? ` (${body.code})` : ''}` : `Request failed (HTTP ${res.status})`);
        noteSource(body.source);
        return body;
      })
      .catch((e) => {
        cache.delete(url);
        throw e instanceof TypeError ? new Error('Cannot reach the API. Is the server running?') : e;
      });
    cache.set(url, request);
  }
  return cache.get(url);
}

function noteSource(source) {
  if (!source) return;
  sources.add(source);
  $('demo-badge').hidden = !sources.has('demo');
}

async function checkHealth() {
  const el = $('db-status');
  try {
    const h = await (await fetch('/api/health')).json();
    const text = { connected: 'Live warehouse', 'not configured': 'Database not connected', unreachable: 'Database unreachable' };
    el.textContent = text[h.database] || 'Database: ' + h.database;
    el.className = 'db-status ' + (h.database === 'connected' ? 'ok' : 'bad');
  } catch {
    el.textContent = 'API not reachable';
    el.className = 'db-status bad';
  }
}

// ---------------------------------------------------------------- card states + loading
function setState(cardId, s, message, retry) {
  const card = $(cardId);
  card.dataset.state = s;
  const msg = card.querySelector('.msg');
  if (card.classList.contains('kpi')) {
    if (s === 'error') {
      card.querySelector('[data-kpi-value]').textContent = 'Not available';
      card.querySelector('[data-kpi-delta]').textContent = message;
    }
    return;
  }
  if (!msg) return;
  if (s === 'empty') {
    msg.innerHTML = `<strong>No data for this slice</strong><span>${esc(message || 'Try a wider year range or another region.')}</span>`;
  } else if (s === 'error') {
    msg.innerHTML = `<strong>Could not load this report</strong><span>${esc(message)}</span><button type="button" class="mini-btn">Retry</button>`;
    msg.querySelector('button').addEventListener('click', retry);
  } else msg.innerHTML = '';
}

const tokens = {};
// Loads one card (or a group of cards fed by the same request). Older responses are ignored.
async function load(key, cardIds, fetcher, render) {
  const token = (tokens[key] = (tokens[key] || 0) + 1);
  cardIds.forEach((id) => setState(id, 'loading'));
  const retry = () => load(key, cardIds, fetcher, render);
  let data;
  try {
    data = await fetcher();
  } catch (e) {
    if (token === tokens[key]) cardIds.forEach((id) => setState(id, 'error', e.message, retry));
    return;
  }
  if (token !== tokens[key]) return;
  cardIds.forEach((id) => setState(id, 'ready'));
  try {
    render(data);
  } catch (e) {
    console.error(e);
    cardIds.forEach((id) => setState(id, 'error', 'The chart could not be drawn: ' + e.message, retry));
  }
}

// ---------------------------------------------------------------- charts
const charts = new Map();
function chart(elOrId) {
  const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
  if (!charts.has(el)) {
    const c = echarts.init(el, null, { renderer: 'canvas' });
    new ResizeObserver(() => c.resize()).observe(el);
    charts.set(el, c);
  }
  return charts.get(el);
}

const tooltipStyle = {
  backgroundColor: '#fff', borderColor: C.line, borderWidth: 1, padding: [10, 12], confine: true,
  textStyle: { color: C.ink, fontSize: 12, fontFamily: 'Inter, system-ui, sans-serif' },
  extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(16,40,30,.12);',
};
const base = () => ({
  aria: { enabled: true },
  textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: C.ink2 },
  animationDuration: 450,
  tooltip: { ...tooltipStyle },
});
const axisLabel = { color: C.muted, fontSize: 11 };
const valueAxis = (extra = {}) => ({
  type: 'value', axisLine: { show: false }, axisTick: { show: false },
  splitLine: { lineStyle: { color: C.line } }, axisLabel: { ...axisLabel, formatter: (v) => compact(v, 0) }, ...extra,
});
const categoryAxis = (data, extra = {}) => ({
  type: 'category', data, axisTick: { show: false }, axisLine: { lineStyle: { color: '#d9d5cc' } },
  axisLabel: { ...axisLabel, hideOverlap: true }, ...extra,
});
const legend = (extra = {}) => ({
  top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 4, itemGap: 16,
  textStyle: { color: C.ink2, fontSize: 12 }, ...extra,
});
const dot = (color) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`;
const tipTitle = (t) => `<div style="font-weight:700;margin-bottom:6px">${esc(t)}</div>`;
const tipRow = (label, value, color) =>
  `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7"><span>${color ? dot(color) : ''}${esc(label)}</span><b>${value}</b></div>`;
const zoom = (n, limit = 60) => (n > limit ? [
  { type: 'inside' },
  { type: 'slider', height: 16, bottom: 4, borderColor: 'transparent', backgroundColor: '#f3f1ec', fillerColor: 'rgba(31,169,113,.18)',
    handleStyle: { color: C.primary }, moveHandleSize: 0, showDetail: false, brushSelect: false, dataBackground: { lineStyle: { color: '#c9d3ce' }, areaStyle: { color: '#e4ebe7' } } },
] : []);

function sparkline(el, { data, labels, color = C.accent, type = 'line', format = compact }) {
  chart(el).setOption({
    animation: false,
    grid: { left: 0, right: 0, top: 6, bottom: 0 },
    xAxis: { type: 'category', data: labels, show: false, boundaryGap: type === 'bar' },
    yAxis: { type: 'value', show: false, scale: type === 'line' },
    tooltip: { ...tooltipStyle, trigger: 'axis', padding: [4, 8], axisPointer: { type: 'none' },
      formatter: (ps) => `${esc(ps[0].name)}: <b>${format(ps[0].value)}</b>` },
    series: [type === 'line' ? {
      type: 'line', data, smooth: 0.35, symbol: 'none', lineStyle: { width: 2, color },
      areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: color + '55' }, { offset: 1, color: color + '00' }]) },
    } : {
      type: 'bar', data, barCategoryGap: '25%', itemStyle: { color: color + 'aa', borderRadius: [3, 3, 0, 0] },
    }],
  }, true);
}

function setKpi(id, { value, title, neg = false, delta = '', spark }) {
  const card = $(id);
  card.dataset.state = 'ready';
  const v = card.querySelector('[data-kpi-value]');
  v.textContent = value;
  v.title = title || '';
  v.classList.toggle('neg', neg);
  card.querySelector('[data-kpi-delta]').innerHTML = delta;
  if (spark) sparkline(card.querySelector('[data-kpi-spark]'), spark);
}

function deltaHtml(now, before, label, { goodWhenUp = true, points = false } = {}) {
  if (before === undefined || before === null || !Number.isFinite(now)) return label || '';
  const diff = points ? now - before : before === 0 ? null : (100 * (now - before)) / Math.abs(before);
  if (diff === null) return label || '';
  const up = diff >= 0;
  const cls = up === goodWhenUp ? 'up' : 'down';
  const text = points ? `${Math.abs(diff).toFixed(1)} pts` : pct(Math.abs(diff));
  return `<span class="${cls}">${up ? '▲' : '▼'} ${text}</span> ${esc(label)}`;
}

// ---------------------------------------------------------------- shared controls
function segControl(name, onChange) {
  const el = document.querySelector(`[data-control="${name}"]`);
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.classList.contains('active')) return;
    setSeg(el, b.dataset.value);
    onChange(b.dataset.value);
  });
}
function setSeg(el, value) {
  el.querySelectorAll('button').forEach((b) => {
    const on = b.dataset.value === String(value);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

// Cards whose report takes a transaction-type parameter.
const TYPE_AWARE = new Set(['card-r2', 'card-r3', 'card-r6']);
function renderOps() {
  document.querySelectorAll('[data-ops]').forEach((el) => {
    const card = el.closest('.card');
    let html = el.dataset.ops.split(',').map((o) => `<span class="op">${esc(o)}</span>`).join('');
    if (state.type && !TYPE_AWARE.has(card.id)) {
      html += '<span class="op na" title="This report has no transaction-type parameter, so the type filter does not apply">Type filter n/a</span>';
    }
    el.innerHTML = html;
  });
}

const yearsLabel = () => (state.yearFrom === state.yearTo ? String(state.yearFrom) : `${state.yearFrom}–${state.yearTo}`);
const regionOrNull = () => state.region || null;

// ================================================================= TRANSACTIONS
// ---------- KPIs (R2 grand total + R1 by quarter for the sparklines)
function r2Params(region) {
  return { year_from: state.yearFrom, year_to: state.yearTo, txn_type: state.type, region };
}

function loadTxnKpis() {
  const ids = ['kpi-txn', 'kpi-amount', 'kpi-net', 'kpi-accounts'];
  load('kpi-txn', ids, () => Promise.all([
    api('r2-regional', r2Params(regionOrNull())),
    api('r1-cash-flow', { level: 'quarter', date_from: `${state.yearFrom}-01-01`, date_to: `${state.yearTo}-12-31`, region: regionOrNull() }),
  ]), ([r2, r1]) => {
    const grand = r2.rows.find((r) => r.row_level === 'grand total');
    if (!grand) {
      ids.forEach((id) => setKpi(id, { value: '0', delta: 'No transactions in this slice' }));
      return;
    }
    const q = r1.rows;
    const labels = q.map((r) => r.period);
    const byYear = {};
    for (const r of q) {
      const y = r.period.slice(0, 4);
      byYear[y] = byYear[y] || { n: 0, amount: 0, net: 0 };
      byYear[y].n += r.txn_count;
      byYear[y].amount += r.total_credit + r.total_debit;
      byYear[y].net += r.net_cash_flow;
    }
    const ys = Object.keys(byYear).sort();
    const last = byYear[ys.at(-1)];
    const prev = ys.length > 1 ? byYear[ys.at(-2)] : null;
    const vs = prev ? `${ys.at(-1)} vs ${ys.at(-2)}` : `in ${yearsLabel()}`;
    const typeNote = state.type ? ` · ${state.type} only` : '';

    setKpi('kpi-txn', {
      value: int(grand.txn_count), title: int(grand.txn_count) + ' transactions',
      delta: (prev ? deltaHtml(last.n, prev.n, vs) : vs) + typeNote,
      spark: { data: q.map((r) => r.txn_count), labels, color: C.accent, format: int },
    });
    setKpi('kpi-amount', {
      value: compact(grand.total_amount, 2), title: money(grand.total_amount),
      delta: (prev ? deltaHtml(last.amount, prev.amount, vs) : vs) + typeNote,
      spark: { data: q.map((r) => r.total_credit + r.total_debit), labels, color: C.debit },
    });
    setKpi('kpi-net', {
      value: signed(grand.net_cash_flow, 2), title: money(grand.net_cash_flow), neg: grand.net_cash_flow < 0,
      delta: prev ? `${signed(last.net)} in ${ys.at(-1)} · ${signed(prev.net)} in ${ys.at(-2)}` : `Credits minus debits, ${yearsLabel()}`,
      spark: { data: q.map((r) => r.net_cash_flow), labels, color: C.primary },
    });
    const parts = r2.rows.filter((r) => r.row_level === (state.region ? 'district' : 'region subtotal'));
    setKpi('kpi-accounts', {
      value: int(grand.active_accounts), title: `${int(grand.active_accounts)} accounts with at least one transaction`,
      delta: `with transactions in ${yearsLabel()} · ${parts.length} ${state.region ? 'districts' : 'regions'}`,
      spark: { data: parts.map((r) => r.active_accounts), labels: parts.map((r) => r.district || r.region), type: 'bar', color: C.accent, format: int },
    });
  });
}

// ---------- R1 cash flow trend + net flow per period
function periodRange(level, period) {
  const y = Number(period.slice(0, 4));
  if (level === 'year') return [`${y}-01-01`, `${y}-12-31`];
  if (level === 'quarter') {
    const qn = Number(period.slice(-1));
    const m1 = (qn - 1) * 3 + 1;
    return [`${y}-${pad(m1)}-01`, `${y}-${pad(m1 + 2)}-${lastDay(y, m1 + 2)}`];
  }
  if (level === 'month') {
    const m = Number(period.slice(5, 7));
    return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${lastDay(y, m)}`];
  }
  return [period, period];
}

function r1Window() {
  const p = state.r1.path.at(-1);
  return p ? { from: p.from, to: p.to } : { from: `${state.yearFrom}-01-01`, to: `${state.yearTo}-12-31` };
}

function setLevel(level) {
  state.r1.level = level;
  $('f-level').value = level;
}

function drillR1(period) {
  const level = state.r1.level;
  const next = LEVELS[LEVELS.indexOf(level) + 1];
  if (!next) return;
  const [from, to] = periodRange(level, period);
  state.r1.path.push({ label: period, level: next, parentLevel: level, from, to });
  setLevel(next);
  loadR1();
}

function rollupR1() {
  const p = state.r1.path.pop();
  if (p) setLevel(p.parentLevel);
  else if (state.r1.level !== 'year') setLevel(LEVELS[LEVELS.indexOf(state.r1.level) - 1]);
  loadR1();
}

function renderR1Crumbs() {
  const path = state.r1.path;
  // earlier steps are buttons (roll up to them); the current step is plain text
  const labels = [yearsLabel(), ...path.map((p) => p.label)];
  $('r1-crumbs').innerHTML = labels.map((label, depth) => (depth < path.length
    ? `<button type="button" data-depth="${depth}">${esc(label)}</button><span class="sep">›</span>`
    : `<span class="here">${esc(label)}</span>`)).join('') + `<span class="sep">·</span><span>by ${state.r1.level}</span>`;
  $('r1-rollup').disabled = !path.length && state.r1.level === 'year';
  $('r1-drill').disabled = state.r1.level === 'day';
}

function loadR1() {
  renderR1Crumbs();
  const w = r1Window();
  load('r1', ['card-r1', 'card-net'],
    () => api('r1-cash-flow', { level: state.r1.level, date_from: w.from, date_to: w.to, region: regionOrNull() }),
    (body) => {
      r1Rows = body.rows;
      if (!r1Rows.length) {
        setState('card-r1', 'empty');
        setState('card-net', 'empty');
        return;
      }
      renderR1(r1Rows);
      renderNet(r1Rows);
    });
}

let r1Rows = [];
function r1Tooltip(rows) {
  return (ps) => {
    if (!ps.length) return '';
    const r = rows[ps[0].dataIndex];
    return tipTitle(r.period)
      + tipRow('Credits', money(r.total_credit), C.credit)
      + tipRow('Debits', money(r.total_debit), C.debit)
      + tipRow('Net cash flow', `<span style="color:${r.net_cash_flow < 0 ? C.neg : C.primary}">${signed(r.net_cash_flow, 2)}</span>`)
      + tipRow('Cumulative net', signed(r.cumulative_net, 2), C.net)
      + tipRow('Transactions', int(r.txn_count))
      + (r.net_change_pct === null ? '' : tipRow('Net vs previous', `${r.net_change_pct > 0 ? '+' : ''}${pct(r.net_change_pct)}`))
      + (state.r1.level !== 'day' ? '<div style="color:#56665e;margin-top:6px;font-size:11px">Click to drill down</div>' : '');
  };
}

function renderR1(rows) {
  const periods = rows.map((r) => r.period);
  const n = rows.length;
  const hasOutflow = rows.some((r) => r.net_cash_flow < 0);
  // shaded band behind every period where debits beat credits (full-height bars on a hidden 0..1 axis)
  const band = {
    name: 'Net outflow', type: 'bar', yAxisIndex: 2, silent: true, z: 0, barCategoryGap: '0%',
    data: rows.map((r) => (r.net_cash_flow < 0 ? 1 : 0)), itemStyle: { color: 'rgba(224,155,26,.2)' },
    tooltip: { show: false },
  };
  const line = (name, key, color, extra = {}) => ({
    name, type: 'line', data: rows.map((r) => r[key]), smooth: 0.25, showSymbol: n <= 40, symbol: 'circle', symbolSize: 7,
    lineStyle: { width: 2, color }, itemStyle: { color, borderColor: '#fff', borderWidth: 2 }, emphasis: { focus: 'none' }, ...extra,
  });
  chart('r1-chart').setOption({
    ...base(),
    legend: legend({ data: ['Credits', 'Debits', 'Cumulative net', ...(hasOutflow ? [{ name: 'Net outflow', icon: 'rect', itemHeight: 10 }] : [])] }),
    // the legend wraps to two lines on a phone
    grid: { left: 4, right: 4, top: $('r1-chart').clientWidth < 560 ? 76 : 52, bottom: n > 60 ? 30 : 4, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: '#9fb0a8' } }, formatter: r1Tooltip(rows) },
    xAxis: categoryAxis(periods, { boundaryGap: false }),
    yAxis: [
      valueAxis({ name: 'Credits / debits', nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' } }),
      valueAxis({ name: 'Cumulative net', position: 'right', splitLine: { show: false },
        nameTextStyle: { color: C.net, fontSize: 11, align: 'right', fontWeight: 600 },
        axisLabel: { color: C.net, fontSize: 11, formatter: (v) => compact(v, 0) } }),
      { type: 'value', show: false, min: 0, max: 1 },
    ],
    dataZoom: zoom(n),
    series: [
      ...(hasOutflow ? [band] : []),
      line('Credits', 'total_credit', C.credit),
      line('Debits', 'total_debit', C.debit),
      line('Cumulative net', 'cumulative_net', C.net, { yAxisIndex: 1, lineStyle: { width: 2.5, color: C.net, type: [6, 3] } }),
    ],
  }, true);

  const unit = UNIT[state.r1.level];
  const positive = rows.filter((r) => r.total_credit > r.total_debit).length;
  const worst = minBy(rows, (r) => r.net_cash_flow);
  const best = maxBy(rows, (r) => r.net_cash_flow);
  const end = rows.at(-1).cumulative_net;
  $('r1-insight').textContent = (worst.net_cash_flow < 0
    ? `Credits exceed debits in ${positive} of ${n} ${unit[1]}; the biggest outflow was ${worst.period} (${signed(worst.net_cash_flow)}).`
    : `Credits exceed debits in every ${unit[0]} shown; the strongest inflow was ${best.period} (${signed(best.net_cash_flow)}).`)
    + ` Cumulative net ends at ${signed(end)}.`;
}

function renderNet(rows) {
  const periods = rows.map((r) => r.period);
  const n = rows.length;
  const avg = sum(rows, 'net_cash_flow') / n;
  chart('net-chart').setOption({
    ...base(),
    grid: { left: 4, right: 8, top: 24, bottom: n > 60 ? 30 : 4, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(11,110,79,.06)' } }, formatter: r1Tooltip(rows) },
    xAxis: categoryAxis(periods, { axisLine: { onZero: true, lineStyle: { color: '#c8c3b8' } } }),
    yAxis: valueAxis(),
    dataZoom: zoom(n),
    series: [{
      type: 'bar', name: 'Net cash flow', barCategoryGap: n > 30 ? '20%' : '35%',
      data: rows.map((r) => ({
        value: r.net_cash_flow,
        itemStyle: { color: r.net_cash_flow >= 0 ? C.credit : C.neg, borderRadius: r.net_cash_flow >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] },
        label: { position: r.net_cash_flow >= 0 ? 'top' : 'bottom' },
      })),
      label: { show: n <= 16, fontSize: 10, color: C.ink2, formatter: (p) => signed(p.value) },
      markLine: { silent: true, symbol: 'none', lineStyle: { color: '#9aa59f', type: 'dashed' },
        label: { color: C.muted, fontSize: 10, formatter: `avg ${signed(avg)}`, position: 'insideStartTop' }, data: [{ yAxis: avg }] },
    }],
  }, true);

  const unit = UNIT[state.r1.level];
  const negatives = rows.filter((r) => r.net_cash_flow < 0);
  const best = maxBy(rows, (r) => r.net_cash_flow);
  $('net-insight').textContent = negatives.length
    ? `${negatives.length} of ${n} ${unit[1]} lost money; the best ${unit[0]} was ${best.period} (${signed(best.net_cash_flow)}), against an average of ${signed(avg)}.`
    : `No ${unit[0]} lost money; the best was ${best.period} (${signed(best.net_cash_flow)}), against an average of ${signed(avg)}.`;
}

// Click anywhere on the plot to drill into the nearest period.
function bindDrillClick(id) {
  const c = chart(id);
  c.getZr().on('click', (e) => {
    const point = [e.offsetX, e.offsetY];
    if (!c.containPixel('grid', point) || !r1Rows.length) return;
    const idx = Math.round(c.convertFromPixel({ gridIndex: 0 }, point)[0]);
    if (r1Rows[idx]) drillR1(r1Rows[idx].period);
  });
}

// ---------- R2 regional roll-up
const R2_MEASURES = {
  total_amount: { label: 'amount moved', fmt: (v) => compact(v) },
  net_cash_flow: { label: 'net cash flow', fmt: (v) => signed(v) },
  txn_count: { label: 'transactions', fmt: (v) => compact(v) },
  amount_per_account: { label: 'amount per account', fmt: (v) => compact(v) },
};
let r2Drilled = false;

function loadR2() {
  const region = state.region || state.r2.region || null;
  renderR2Crumbs(region);
  load('r2', ['card-r2'], () => Promise.all([
    api('r2-regional', r2Params(region)),
    region && !state.region ? api('r2-regional', r2Params(null)).catch(() => null) : null,
  ]), ([body, top]) => renderR2(body.rows, region, top && top.rows));
}

function renderR2Crumbs(region) {
  const el = $('r2-crumbs');
  const lockedTitle = 'Clear the Region filter at the top to roll up to all regions';
  if (!region) el.innerHTML = '<span class="here">All regions</span><span class="sep">·</span><span>click a bar to drill into its districts</span>';
  else if (state.region) el.innerHTML = `<span title="${lockedTitle}">All regions</span><span class="sep">›</span><span class="here">${esc(region)}</span><span class="sep">·</span><span>sliced by the Region filter</span>`;
  else el.innerHTML = `<button type="button" data-rollup>All regions</button><span class="sep">›</span><span class="here">${esc(region)}</span><span class="sep">·</span><span>districts</span>`;
  $('r2-rollup').disabled = !region || Boolean(state.region);
  $('r2-rollup').title = state.region ? lockedTitle : '';
}

function renderR2(rows, region, topRows) {
  r2Drilled = Boolean(region);
  const m = state.r2.measure;
  const meta = R2_MEASURES[m];
  const bars = rows.filter((r) => r.row_level === (region ? 'district' : 'region subtotal'))
    .map((r) => ({ ...r, name: region ? r.district : r.region }))
    .sort((a, b) => b[m] - a[m]);
  if (!bars.length) {
    setState('card-r2', 'empty');
    $('r2-totals').innerHTML = '';
    return;
  }
  const el = $('r2-chart');
  el.style.height = Math.max(300, Math.min(560, bars.length * 30 + 40)) + 'px';
  const c = chart(el);
  c.setOption({
    ...base(),
    grid: { left: 4, right: 64, top: 8, bottom: 4, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'item', formatter: (p) => {
      const r = bars[p.dataIndex];
      return tipTitle(region ? `${r.district} (${r.region})` : r.region)
        + tipRow('Amount moved', money(r.total_amount))
        + tipRow('Net cash flow', money(r.net_cash_flow))
        + tipRow('Transactions', int(r.txn_count))
        + tipRow('Active accounts', int(r.active_accounts))
        + tipRow('Amount per account', money(r.amount_per_account))
        + (r.district_average_salary ? tipRow('Average salary', int(r.district_average_salary)) : '')
        + (region ? '' : '<div style="color:#56665e;margin-top:6px;font-size:11px">Click to drill into districts</div>');
    } },
    xAxis: valueAxis({ splitNumber: 4 }),
    yAxis: categoryAxis(bars.map((b) => b.name), { inverse: true, axisLine: { show: false }, axisLabel: { ...axisLabel, color: C.ink2, fontSize: 12, hideOverlap: false } }),
    series: [{
      type: 'bar', barWidth: bars.length > 10 ? 14 : 18, cursor: region ? 'default' : 'pointer',
      data: bars.map((b) => ({
        value: b[m],
        itemStyle: { borderRadius: b[m] < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
          color: b[m] < 0 ? C.neg : new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: '#9ad7b7' }, { offset: 1, color: C.primary }]) },
      })),
      label: { show: true, position: 'right', fontSize: 11, color: C.ink2, fontWeight: 600, formatter: (p) => meta.fmt(p.value) },
      showBackground: true, backgroundStyle: { color: '#f4f2ed', borderRadius: 4 },
    }],
  }, true);

  const grand = rows.find((r) => r.row_level === 'grand total');
  const sub = region ? rows.find((r) => r.row_level === 'region subtotal') : null;
  const allGrand = topRows ? topRows.find((r) => r.row_level === 'grand total') : (state.region ? null : grand);
  const line = (label, r) => `<span class="lbl">${esc(label)}</span><span><b>${compact(r.total_amount, 2)}</b> moved</span>`
    + `<span>net <b>${signed(r.net_cash_flow, 2)}</b></span><span><b>${int(r.txn_count)}</b> txns</span><span><b>${int(r.active_accounts)}</b> accounts</span>`;
  $('r2-totals').innerHTML = [
    sub ? `<div class="totals">${line(`Subtotal · ${region}`, sub)}</div>` : '',
    allGrand ? `<div class="totals">${line('Grand total · all regions', allGrand)}</div>` : '',
  ].join('') || '';

  const top = bars[0];
  const total = sum(bars, m);
  const share = m !== 'amount_per_account' && total > 0 ? ` (${pct((100 * top[m]) / total)} of the ${region ? 'region' : 'total'})` : '';
  if (!region) {
    const perAcct = maxBy(bars, (b) => b.amount_per_account);
    $('r2-insight').textContent = `${top.name} leads on ${meta.label}: ${meta.fmt(top[m])}${share}. Accounts in ${perAcct.name} move the most each (${compact(perAcct.amount_per_account)} per account).`;
  } else {
    const regionShare = allGrand && sub ? ` ${region} is ${pct((100 * sub.total_amount) / allGrand.total_amount)} of all money moved.` : '';
    $('r2-insight').textContent = bars.length === 1
      ? `${region} has a single district, ${top.name}, with ${int(top.active_accounts)} active accounts.${regionShare}`
      : `${top.name} leads ${region}'s ${bars.length} districts on ${meta.label}: ${meta.fmt(top[m])}${share}.${regionShare}`;
  }
}

function drillR2(region) {
  state.r2.region = region;
  loadR2();
  if (!state.region) {
    state.r5.region = region;
    $('r5-region').value = region;
    loadR5();
  }
}

// ---------- R5 top accounts
function loadR5() {
  if (!state.r5.region) return;
  load('r5', ['card-r5'], () => api('r5-top-accounts', { region: state.r5.region, year: state.r5.year, top_n: state.r5.top }), (body) => {
    const rows = body.rows;
    if (!rows.length) {
      setState('card-r5', 'empty', 'No accounts had transactions in this slice.');
      return;
    }
    const max = Math.max(...rows.map((r) => r.net_cash_flow), 1);
    $('r5-list').innerHTML = '<div class="rank-head"><span>#</span><span>Account · district</span><span>Net flow share</span><span>Net flow</span></div>'
      + rows.map((r) => {
        const w = Math.max(0, (100 * r.net_cash_flow) / max);
        return `<div class="rank-row" title="Credits ${money(r.total_credit)} · Debits ${money(r.total_debit)}">
          <span class="rank-badge" style="background:${RANK_SHADES[Math.min(r.rank_in_region - 1, RANK_SHADES.length - 1)]}">${r.rank_in_region}</span>
          <div class="rank-who"><b>Account ${esc(r.account_id)}</b><span>${esc(r.district_name)} · ${esc(r.frequency)} · ${int(r.txn_count)} txns</span></div>
          <div class="rank-bar"><div class="track"><div class="fill" style="width:${w.toFixed(1)}%"></div></div><span class="split">${compact(r.total_credit)} in</span></div>
          <span class="num ${r.net_cash_flow < 0 ? 'neg' : ''}">${signed(r.net_cash_flow)}</span>
        </div>`;
      }).join('');
    const [first, second] = rows;
    const when = state.r5.year ? ` in ${state.r5.year}` : ' across all years';
    const lead = second && second.net_cash_flow > 0
      ? `, ${pct((100 * (first.net_cash_flow - second.net_cash_flow)) / second.net_cash_flow, 0)} ahead of #2`
      : '';
    const ties = new Set(rows.map((r) => r.rank_in_region)).size < rows.length ? ' Some accounts tie and share a rank.' : '';
    $('r5-insight').textContent = `Account ${first.account_id} (${first.district_name}) leads ${state.r5.region} with ${signed(first.net_cash_flow)} net${when}${lead}.${ties}`;
  });
}

// ---------- R3 operations by year (pivot heatmap)
function loadR3() {
  load('r3', ['card-r3'], () => api('r3-operation-pivot', { measure: state.r3.measure, txn_type: state.type, region: regionOrNull() }), (body) => {
    const rows = body.rows;
    const ops = rows.filter((r) => r.operation !== 'ALL OPERATIONS');
    if (!ops.length) {
      setState('card-r3', 'empty');
      return;
    }
    renderR3(ops, rows.find((r) => r.operation === 'ALL OPERATIONS'));
  });
}

function renderR3(ops, all) {
  const isCount = state.r3.measure === 'count';
  const fmt = (v) => (isCount ? compact(v, v >= 1e6 ? 2 : 0) : compact(v));
  const fmtFull = (v) => (isCount ? int(v) : money(v));
  const opNames = ops.map((r) => (r.operation === 'N/A' ? 'No operation' : r.operation)).concat('All operations');
  const cols = YEARS.map(String).concat('Total');
  const inRange = (j) => j === YEARS.length || (YEARS[j] >= state.yearFrom && YEARS[j] <= state.yearTo);
  const source = ops.concat(all);
  const value = (i, j) => (j === YEARS.length ? source[i].total : source[i]['y' + YEARS[j]]);
  const max = Math.max(...ops.flatMap((r) => YEARS.map((y) => r['y' + y])), 1);
  const swapped = state.r3.swapped;
  const cells = [];
  const totals = [];
  source.forEach((r, i) => cols.forEach((col, j) => {
    const v = value(i, j);
    const isTotal = i === ops.length || j === YEARS.length;
    const xy = swapped ? [i, j] : [j, i];
    const dim = !inRange(j);
    const item = { value: [...xy, v], i, j,
      itemStyle: { opacity: dim ? 0.3 : 1 },
      label: { color: isTotal ? C.ink : v / max > 0.5 ? '#fff' : C.ink, fontWeight: isTotal ? 700 : 500, opacity: dim ? 0.5 : 1 } };
    (isTotal ? totals : cells).push(item);
  }));
  // operations become column headers when pivoted, so they get short names there (the tooltip has the full name)
  const shortOps = opNames.map((o) => OP_SHORT[o] || o);
  const xNames = swapped ? shortOps : cols;
  const yNames = swapped ? cols : opNames;
  // on a phone the 7 x 7 grid has no room for numbers in the cells: colour + tooltip carry the values
  const narrow = $('r3-chart').clientWidth < 420;
  chart('r3-chart').setOption({
    ...base(),
    grid: { left: 4, right: 4, top: 8, bottom: 4, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'item', formatter: (p) => {
      const { i, j } = p.data;
      const v = value(i, j);
      const rowTotal = source[i].total;
      return tipTitle(`${opNames[i]} · ${cols[j]}`) + tipRow(isCount ? 'Transactions' : 'Amount', fmtFull(v))
        + (j < YEARS.length && rowTotal ? tipRow('Share of the row total', pct((100 * v) / rowTotal)) : '')
        + (!inRange(j) ? '<div style="color:#8a5a00;margin-top:6px;font-size:11px">Outside the selected years</div>' : '');
    } },
    xAxis: { type: 'category', data: xNames, position: 'top', splitArea: { show: false }, axisTick: { show: false }, axisLine: { show: false },
      axisLabel: { ...axisLabel, interval: 0, width: swapped ? (narrow ? 40 : 60) : undefined, overflow: swapped ? 'break' : 'none',
        fontWeight: 600, fontSize: narrow ? 10 : 11, lineHeight: 13 } },
    yAxis: { type: 'category', data: yNames, inverse: true, axisTick: { show: false }, axisLine: { show: false },
      axisLabel: { ...axisLabel, color: C.ink2, width: narrow ? 78 : 104, overflow: 'break', interval: 0, fontSize: narrow ? 10 : 11 } },
    visualMap: { show: false, seriesIndex: 0, min: 0, max, inRange: { color: GREEN_RAMP } },
    series: [
      { type: 'heatmap', data: cells, label: { show: !narrow, fontSize: 10.5, formatter: (p) => fmt(p.value[2]) },
        itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 6 }, emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } } },
      { type: 'heatmap', data: totals, label: { show: !narrow, fontSize: 10.5, formatter: (p) => fmt(p.value[2]) },
        itemStyle: { color: '#f1efe9', borderColor: '#fff', borderWidth: 2, borderRadius: 6 } },
    ],
  }, true);

  const full = state.yearFrom === 1993 && state.yearTo === 1998;
  $('r3-note').textContent = (full ? '' : `This report has no year parameter, so all six years are queried; years outside ${yearsLabel()} are dimmed. `)
    + (narrow ? 'Darker cells hold more; tap a cell for its value.' : '');

  const years = YEARS.filter((y) => y >= state.yearFrom && y <= state.yearTo);
  const growth = ops.map((r) => {
    const firstYear = years.find((y) => r['y' + y] > 0);
    const lastYear = years.at(-1);
    return { name: r.operation === 'N/A' ? 'No operation' : r.operation, firstYear, lastYear,
      g: firstYear && firstYear !== lastYear ? r['y' + lastYear] / r['y' + firstYear] : null };
  }).filter((x) => x.g !== null);
  const topGrowth = maxBy(growth, (x) => x.g);
  const biggest = maxBy(ops, (r) => r.total);
  const share = all && all.total ? ` ${biggest.operation === 'N/A' ? 'No operation' : biggest.operation} is ${pct((100 * biggest.total) / all.total)} of the total ${isCount ? 'count' : 'amount'}.` : '';
  $('r3-insight').textContent = topGrowth
    ? `${topGrowth.name} grew ${topGrowth.g.toFixed(1)}× from ${topGrowth.firstYear} to ${topGrowth.lastYear}.${share}`
    : `Only one year is selected.${share}`;
}

// ---------- R6 transaction mix (treemap)
function loadR6() {
  load('r6', ['card-r6'], () => api('r6-transaction-mix', { year: state.r6.year, region: regionOrNull(), txn_type: state.type }), (body) => {
    const rows = body.rows;
    const details = rows.filter((r) => r.row_level === 'detail');
    if (!details.length) {
      setState('card-r6', 'empty');
      return;
    }
    renderR6(rows, details);
  });
}

function renderR6(rows, details) {
  const m = state.r6.measure;
  const fmt = m === 'txn_count' ? (v) => compact(v, 1) : (v) => compact(v);
  const grand = rows.find((r) => r.row_level === 'grand total');
  const total = grand ? grand[m] : sum(details, m);
  const opName = (op) => (op === 'N/A' ? 'No operation' : op);
  // sunburst rings: type (inner) > operation > purpose (outer); click a slice to drill, the centre to roll up
  const types = [...new Set(details.map((d) => d.txn_type))];
  const tree = types.map((type) => {
    const shades = type === 'Credit' ? CREDIT_SHADES : DEBIT_SHADES;
    const ops = [...new Set(details.filter((d) => d.txn_type === type).map((d) => d.operation))];
    return {
      name: type,
      itemStyle: { color: shades[0] },
      children: ops.map((op, k) => {
        const opColor = shades[(k + 1) % shades.length];
        const leaves = details.filter((d) => d.txn_type === type && d.operation === op);
        return {
          name: opName(op),
          itemStyle: { color: opColor },
          children: leaves.map((d, i) => ({
            name: d.purpose, value: d[m], row: d,
            itemStyle: { color: echarts.color.lerp(0.25 + (0.4 * i) / Math.max(leaves.length, 1), [opColor, '#ffffff']) },
          })),
        };
      }),
    };
  });
  chart('r6-chart').setOption({
    ...base(),
    tooltip: { ...tooltipStyle, formatter: (p) => {
      const path = (p.treePathInfo || []).slice(1).map((x) => x.name).join(' › ');
      const row = p.data && p.data.row;
      return tipTitle(path || 'All transactions') + tipRow(m === 'txn_count' ? 'Transactions' : 'Amount', m === 'txn_count' ? int(p.value) : money(p.value))
        + tipRow('Share of the total', pct((100 * p.value) / total))
        + (row ? tipRow('Average amount', money(row.avg_amount)) : '<div style="color:#56665e;margin-top:6px;font-size:11px">Click to drill down</div>');
    } },
    series: [{
      type: 'sunburst', data: tree, radius: ['12%', '95%'], center: ['50%', '50%'], sort: 'desc', nodeClick: 'rootToNode',
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
      emphasis: { focus: 'ancestor' },
      label: { color: '#fff', fontSize: 10.5, minAngle: 14, overflow: 'truncate' },
      levels: [
        {},
        { r0: '12%', r: '38%', label: { rotate: 0, fontWeight: 700, fontSize: 12, formatter: (p) => `${p.name}\n${fmt(p.value)}` } },
        { r0: '38%', r: '68%', label: { rotate: 'tangential', width: 90, formatter: (p) => p.name } },
        { r0: '68%', r: '95%', label: { rotate: 'radial', width: 54, fontSize: 10, color: C.ink, formatter: (p) => p.name } },
      ],
    }],
  }, true);

  const opSubs = rows.filter((r) => r.row_level === 'operation subtotal');
  const topOp = maxBy(opSubs, (r) => r[m]);
  const totalCount = grand ? grand.txn_count : sum(details, 'txn_count');
  const totalAmount = grand ? grand.total_amount : sum(details, 'total_amount');
  const gap = maxBy(details, (d) => d.txn_count / totalCount - d.total_amount / totalAmount);
  const when = state.r6.year ? ` in ${state.r6.year}` : '';
  $('r6-insight').textContent = `${opName(topOp.operation)} is ${pct((100 * topOp[m]) / total)} of the ${m === 'txn_count' ? 'transactions' : 'money moved'}${when}. `
    + `${gap.purpose} makes up ${pct((100 * gap.txn_count) / totalCount)} of transactions but only ${pct((100 * gap.total_amount) / totalAmount)} of the amount.`;
}

// ================================================================= LOANS
function r4Params(group) {
  return {
    group_by: group, phase: state.r4.phase, health: state.r4.health, region: regionOrNull(),
    year_from: state.yearFrom, year_to: state.yearTo, duration: state.r4.duration,
  };
}

function loadLoanKpis() {
  const ids = ['kpi-loans', 'kpi-loan-amount', 'kpi-problem', 'kpi-avg-loan'];
  load('kpi-loans', ids, () => api('r4-loan-portfolio', r4Params('year')), (body) => {
    const rows = body.rows;
    const n = sum(rows, 'loan_count');
    if (!n) {
      ids.forEach((id) => setKpi(id, { value: '0', delta: 'No loans in this slice' }));
      return;
    }
    const amount = sum(rows, 'total_loan_amount');
    const bad = sum(rows, 'loans_with_problems');
    const labels = rows.map((r) => r.grp);
    const [prev, last] = rows.slice(-2);
    const vs = rows.length > 1 ? `${last.grp} vs ${prev.grp}` : `granted in ${rows[0].grp}`;
    const two = rows.length > 1;
    setKpi('kpi-loans', {
      value: int(n), title: `${int(n)} loans`,
      delta: two ? deltaHtml(last.loan_count, prev.loan_count, vs) : vs,
      spark: { data: rows.map((r) => r.loan_count), labels, type: 'bar', color: C.accent, format: int },
    });
    setKpi('kpi-loan-amount', {
      value: compact(amount, 2), title: money(amount),
      delta: two ? deltaHtml(last.total_loan_amount, prev.total_loan_amount, vs) : vs,
      spark: { data: rows.map((r) => r.total_loan_amount), labels, color: C.debit },
    });
    setKpi('kpi-problem', {
      value: pct((100 * bad) / n, 2), title: `${int(bad)} of ${int(n)} loans have payment problems`,
      delta: `${int(bad)} loans with problems` + (two ? ` · ${deltaHtml(last.problem_rate_pct, prev.problem_rate_pct, `${last.grp}`, { goodWhenUp: false, points: true })}` : ''),
      spark: { data: rows.map((r) => r.problem_rate_pct), labels, color: C.amber, format: (v) => pct(v) },
    });
    setKpi('kpi-avg-loan', {
      value: compact(amount / n), title: money(amount / n),
      delta: two ? deltaHtml(last.avg_loan_amount, prev.avg_loan_amount, vs) : vs,
      spark: { data: rows.map((r) => r.avg_loan_amount), labels, color: C.primary },
    });
  });
}

const grpLabel = (g) => (state.r4.group === 'status' ? STATUS_SHORT[g[0]] || g : g);

function loadR4() {
  load('r4', ['card-r4', 'card-r4-share'], () => api('r4-loan-portfolio', r4Params(state.r4.group)), (body) => {
    const rows = body.rows;
    if (!rows.length) {
      setState('card-r4', 'empty', 'No loans match these filters.');
      setState('card-r4-share', 'empty', 'No loans match these filters.');
      return;
    }
    renderR4(rows);
    renderR4Share(rows);
  });
}

function renderR4(rows) {
  const n = sum(rows, 'loan_count');
  const overall = (100 * sum(rows, 'loans_with_problems')) / n;
  const labels = rows.map((r) => grpLabel(r.grp));
  chart('r4-chart').setOption({
    ...base(),
    legend: legend({ data: ['Loan amount', 'Problem rate'] }),
    grid: { left: 4, right: 4, top: 52, bottom: 4, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(11,110,79,.06)' } }, formatter: (ps) => {
      const r = rows[ps[0].dataIndex];
      return tipTitle(r.grp) + tipRow('Loans', int(r.loan_count)) + tipRow('Loan amount', money(r.total_loan_amount), C.accent)
        + tipRow('Average loan', money(r.avg_loan_amount)) + tipRow('Monthly payments', money(r.total_monthly_payment))
        + tipRow('Loans with problems', int(r.loans_with_problems)) + tipRow('Problem rate', pct(r.problem_rate_pct, 2), C.amber)
        + tipRow('Share of loan money', pct(r.share_of_amount_pct, 2));
    } },
    xAxis: categoryAxis(labels, { axisLabel: { ...axisLabel, interval: 0, rotate: rows.length > 5 ? 30 : 0, color: C.ink2 } }),
    yAxis: [
      valueAxis({ name: 'Loan amount', nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' } }),
      valueAxis({ name: 'Problem rate', position: 'right', splitLine: { show: false }, min: 0,
        nameTextStyle: { color: C.amberInk, fontSize: 11, align: 'right', fontWeight: 600 },
        axisLabel: { color: C.amberInk, fontSize: 11, formatter: (v) => v + '%' } }),
    ],
    series: [
      { name: 'Loan amount', type: 'bar', data: rows.map((r) => r.total_loan_amount), barMaxWidth: 42,
        itemStyle: { color: C.accent, borderRadius: [4, 4, 0, 0] },
        label: { show: rows.length <= 8, position: 'top', fontSize: 10.5, color: C.ink2, formatter: (p) => compact(p.value) } },
      { name: 'Problem rate', type: 'line', yAxisIndex: 1, data: rows.map((r) => r.problem_rate_pct), symbol: 'circle', symbolSize: 9,
        lineStyle: { color: C.amber, width: 2 }, itemStyle: { color: C.amber, borderColor: '#fff', borderWidth: 2 },
        markLine: { silent: true, symbol: 'none', lineStyle: { color: C.amber, type: 'dashed' },
          label: { color: C.amberInk, fontSize: 10.5, fontWeight: 600, formatter: `overall ${pct(overall)}`, position: 'insideEndTop' },
          data: [{ yAxis: overall }] } },
    ],
  }, true);

  const topAmt = maxBy(rows, (r) => r.total_loan_amount);
  if (state.r4.group === 'status') {
    const bad = rows.filter((r) => /^[BD]/.test(r.grp));
    const badAmt = sum(bad, 'total_loan_amount');
    $('r4-insight').textContent = `${pct((100 * sum(bad, 'loan_count')) / n)} of loans (statuses B and D) have payment problems, holding ${compact(badAmt)} of loan money. ${grpLabel(topAmt.grp)} is the largest group.`;
  } else {
    const worst = maxBy(rows.filter((r) => r.loan_count >= 5), (r) => r.problem_rate_pct) || maxBy(rows, (r) => r.problem_rate_pct);
    $('r4-insight').textContent = `${grpLabel(topAmt.grp)} carries the most loan money (${pct(topAmt.share_of_amount_pct)}); `
      + (worst.problem_rate_pct > 0
        ? `${grpLabel(worst.grp)} has the highest problem rate (${pct(worst.problem_rate_pct)} vs ${pct(overall)} overall).`
        : 'no group has loans with payment problems.');
  }
}

function renderR4Share(rows) {
  const total = sum(rows, 'total_loan_amount');
  const shades = rows.map((_, i) => {
    const t = rows.length === 1 ? 0 : i / (rows.length - 1);
    return echarts.color.lerp(t, [C.primary, '#b5e0c8']);
  });
  chart('r4-share-chart').setOption({
    ...base(),
    title: { text: compact(total, 2), subtext: 'loan money', left: 'center', top: '40%',
      textStyle: { fontSize: 20, fontWeight: 800, color: C.ink }, subtextStyle: { color: C.muted, fontSize: 11 } },
    tooltip: { ...tooltipStyle, trigger: 'item', formatter: (p) => {
      const r = rows[p.dataIndex];
      return tipTitle(r.grp) + tipRow('Loan amount', money(r.total_loan_amount)) + tipRow('Share', pct(r.share_of_amount_pct, 2)) + tipRow('Loans', int(r.loan_count));
    } },
    series: [{
      type: 'pie', radius: $('r4-share-chart').clientWidth < 420 ? ['36%', '54%'] : ['42%', '62%'], center: ['50%', '48%'],
      avoidLabelOverlap: true, minAngle: 3,
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 4 },
      label: { fontSize: 11, color: C.ink2, formatter: (p) => `${grpLabel(p.name)}\n${pct(p.data.share)}`,
        alignTo: 'edge', edgeDistance: 4, overflow: 'break', width: 84, lineHeight: 14 },
      labelLine: { length: 6, length2: 0, lineStyle: { color: '#c9d3ce' } },
      data: rows.map((r, i) => ({ name: r.grp, value: r.total_loan_amount, share: r.share_of_amount_pct, itemStyle: { color: shades[i] } })),
    }],
  }, true);

  const sorted = [...rows].sort((a, b) => b.total_loan_amount - a.total_loan_amount);
  const k = Math.min(3, sorted.length);
  const topShare = (100 * sum(sorted.slice(0, k), 'total_loan_amount')) / total;
  $('r4-share-insight').textContent = sorted.length <= 1
    ? 'Only one group matches these filters.'
    : `The top ${k} of ${sorted.length} groups hold ${pct(topShare)} of loan money; the smallest, ${grpLabel(sorted.at(-1).grp)}, holds ${pct(sorted.at(-1).share_of_amount_pct)}.`;
}

// ================================================================= CROSS-FACT (R7)
const R7_COLUMNS = [
  ['region', 'Region'], ['account_count', 'Accounts'], ['txn_count', 'Transactions'], ['net_cash_flow', 'Net cash flow'],
  ['net_cash_flow_per_account', 'Net / account'], ['loans_granted', 'Loans'], ['loan_amount', 'Loan amount'],
  ['problem_loans', 'Problem loans'], ['loans_per_100_accounts', 'Loans / 100 accts'],
];
let r7Rows = [];

function loadR7() {
  const ids = ['kpi-x-accounts', 'kpi-x-net', 'kpi-x-loans', 'kpi-x-problem', 'card-r7', 'card-r7-table'];
  load('r7', ids, () => api('r7-region-profile', { year_from: state.yearFrom, year_to: state.yearTo, region: regionOrNull() }), (body) => {
    r7Rows = body.rows;
    if (!r7Rows.length) {
      ids.forEach((id) => setState(id, 'empty'));
      ids.slice(0, 4).forEach((id) => setKpi(id, { value: '0', delta: 'No data for this slice' }));
      return;
    }
    renderR7Kpis(r7Rows);
    renderR7(r7Rows);
    renderR7Table();
  });
}

function renderR7Kpis(rows) {
  const accounts = sum(rows, 'account_count');
  const net = sum(rows, 'net_cash_flow');
  const loans = sum(rows, 'loans_granted');
  const bad = sum(rows, 'problem_loans');
  const labels = rows.map((r) => r.region);
  const bars = (key, color, format) => ({ data: rows.map((r) => r[key]), labels, type: 'bar', color, format });
  setKpi('kpi-x-accounts', { value: int(accounts), delta: `in ${rows.length} region${rows.length > 1 ? 's' : ''}`, spark: bars('account_count', C.accent, int) });
  setKpi('kpi-x-net', { value: signed(net / accounts), title: money(net / accounts), neg: net < 0,
    delta: `${signed(net, 2)} net in ${yearsLabel()}`, spark: bars('net_cash_flow_per_account', C.primary, compact) });
  setKpi('kpi-x-loans', { value: (100 * loans / accounts).toFixed(2), delta: `${int(loans)} loans granted in ${yearsLabel()}`,
    spark: bars('loans_per_100_accounts', C.debit, (v) => v.toFixed(2)) });
  setKpi('kpi-x-problem', { value: int(bad), delta: loans ? `${pct((100 * bad) / loans)} of loans granted` : 'No loans granted',
    spark: bars('problem_loans', C.amber, int) });
}

function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

function renderR7(rows) {
  const rate = (r) => (r.loans_granted ? (100 * r.problem_loans) / r.loans_granted : 0);
  const maxAcc = Math.max(...rows.map((r) => r.account_count));
  const avgX = sum(rows, 'net_cash_flow') / sum(rows, 'account_count');
  const avgY = (100 * sum(rows, 'loans_granted')) / sum(rows, 'account_count');
  const maxRate = Math.max(...rows.map(rate), 1);
  const narrow = $('r7-chart').clientWidth < 560;
  chart('r7-chart').setOption({
    ...base(),
    grid: { left: 8, right: 24, top: narrow ? 64 : 36, bottom: 36, containLabel: true },
    tooltip: { ...tooltipStyle, trigger: 'item', formatter: (p) => {
      const r = rows[p.dataIndex];
      return tipTitle(r.region) + tipRow('Accounts', int(r.account_count)) + tipRow('Transactions', int(r.txn_count))
        + tipRow('Net cash flow', money(r.net_cash_flow)) + tipRow('Net per account', money(r.net_cash_flow_per_account))
        + tipRow('Loans granted', int(r.loans_granted)) + tipRow('Loan amount', money(r.loan_amount))
        + tipRow('Problem loans', `${int(r.problem_loans)} (${pct(rate(r))})`, C.amber) + tipRow('Loans per 100 accounts', r.loans_per_100_accounts.toFixed(2));
    } },
    xAxis: valueAxis({ name: 'Net cash flow per account →', nameLocation: 'middle', nameGap: 26, scale: true,
      nameTextStyle: { color: C.muted, fontSize: 11 } }),
    yAxis: valueAxis({ name: 'Loans per 100 accounts', scale: true, nameTextStyle: { color: C.muted, fontSize: 11, align: 'left' },
      axisLabel: { ...axisLabel, formatter: (v) => v.toFixed(1) } }),
    visualMap: { type: 'continuous', dimension: 3, min: 0, max: Math.ceil(maxRate), right: 0, top: 0, orient: 'horizontal',
      itemWidth: 10, itemHeight: 90, text: [`${Math.ceil(maxRate)}%`, 'Problem-loan rate  0%'], calculable: false,
      textStyle: { color: C.muted, fontSize: 11 }, inRange: { color: ['#bfe5cf', '#e9c46a', '#d9822b'] } },
    series: [{
      type: 'scatter',
      data: rows.map((r) => [r.net_cash_flow_per_account, r.loans_per_100_accounts, r.account_count, rate(r), r.region]),
      symbolSize: (d) => (narrow ? 10 + 22 * Math.sqrt(d[2] / maxAcc) : 16 + 40 * Math.sqrt(d[2] / maxAcc)),
      itemStyle: { borderColor: '#fff', borderWidth: 2, opacity: 0.92 },
      label: { show: true, position: narrow ? 'top' : 'right', fontSize: narrow ? 10.5 : 11.5, color: C.ink2, fontWeight: 600, formatter: (p) => p.data[4] },
      labelLayout: { hideOverlap: true },
      markLine: rows.length > 1 ? { silent: true, symbol: 'none', lineStyle: { color: '#b9c2bd', type: 'dashed' },
        label: { color: C.muted, fontSize: 10.5 },
        data: [{ xAxis: avgX, label: { formatter: 'avg net / account', position: 'end' } },
          { yAxis: avgY, label: { formatter: 'avg loans / 100', position: 'insideEndTop' } }] } : undefined,
    }],
  }, true);

  const most = maxBy(rows, (r) => r.account_count);
  if (rows.length < 3) {
    $('r7-insight').textContent = `${most.region}: ${int(most.account_count)} accounts, ${signed(most.net_cash_flow_per_account)} net per account and ${most.loans_per_100_accounts.toFixed(2)} loans per 100 accounts.`;
    return;
  }
  const leastBorrow = minBy(rows, (r) => r.loans_per_100_accounts);
  const r = pearson(rows.map((x) => x.net_cash_flow_per_account), rows.map((x) => x.loans_per_100_accounts));
  const relation = Math.abs(r) < 0.3 ? 'show no clear link with how much they borrow'
    : r > 0 ? 'tend to borrow more' : 'tend to borrow less';
  $('r7-insight').textContent = `${most.region} has the most accounts (${int(most.account_count)}); ${leastBorrow.region} borrows least `
    + `(${leastBorrow.loans_per_100_accounts.toFixed(2)} loans per 100 accounts). Regions with more net inflow per account ${relation} (r = ${r.toFixed(2)}).`;
}

function renderR7Table() {
  const { sort, dir } = state.r7;
  const rows = [...r7Rows].sort((a, b) => (typeof a[sort] === 'string' ? a[sort].localeCompare(b[sort]) : a[sort] - b[sort]) * dir);
  const maxNet = Math.max(...rows.map((r) => Math.abs(r.net_cash_flow_per_account)), 1);
  const maxLoans = Math.max(...rows.map((r) => r.loans_per_100_accounts), 1);
  const overallRate = sum(rows, 'problem_loans') / Math.max(sum(rows, 'loans_granted'), 1);
  const bar = (v, max, color) => `<span class="cell-bar"><i style="width:${Math.round((48 * Math.abs(v)) / max)}px;background:${color}"></i>`;
  const cell = (r, key) => {
    const v = r[key];
    switch (key) {
      case 'region': return `<td class="region">${esc(v)}</td>`;
      case 'net_cash_flow': return `<td class="${v < 0 ? 'neg' : ''}" title="${money(v)}">${signed(v, 2)}</td>`;
      case 'net_cash_flow_per_account': return `<td class="${v < 0 ? 'neg' : ''}">${bar(v, maxNet, v < 0 ? C.neg : C.accent)}${signed(v)}</span></td>`;
      case 'loan_amount': return `<td title="${money(v)}">${compact(v, 2)}</td>`;
      case 'loans_per_100_accounts': return `<td>${bar(v, maxLoans, C.debit)}${v.toFixed(2)}</span></td>`;
      case 'problem_loans': {
        const high = r.loans_granted && v / r.loans_granted > overallRate;
        return `<td class="${high ? 'warn' : ''}" title="${high ? 'Above the overall problem rate' : ''}">${high ? '▲ ' : ''}${int(v)}</td>`;
      }
      default: return `<td>${int(v)}</td>`;
    }
  };
  const totals = { region: 'Total' };
  for (const [key] of R7_COLUMNS.slice(1)) totals[key] = sum(r7Rows, key);
  totals.net_cash_flow_per_account = totals.net_cash_flow / totals.account_count;
  totals.loans_per_100_accounts = (100 * totals.loans_granted) / totals.account_count;
  $('r7-table').innerHTML = `<table class="data"><thead><tr>${R7_COLUMNS.map(([key, label]) =>
    `<th scope="col" data-key="${key}" tabindex="0" aria-sort="${key === sort ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${R7_COLUMNS.map(([key]) => cell(r, key)).join('')}</tr>`).join('')}</tbody>
    ${r7Rows.length > 1 ? `<tfoot><tr>${R7_COLUMNS.map(([key]) => (key === 'region' ? '<td>Total</td>'
      : key === 'net_cash_flow_per_account' ? `<td>${signed(totals[key])}</td>`
        : key === 'loans_per_100_accounts' ? `<td>${totals[key].toFixed(2)}</td>`
          : key === 'net_cash_flow' ? `<td title="${money(totals[key])}">${signed(totals[key], 2)}</td>`
            : key === 'loan_amount' ? `<td title="${money(totals[key])}">${compact(totals[key], 2)}</td>` : `<td>${int(totals[key])}</td>`)).join('')}</tr></tfoot>` : ''}
  </table>`;
}

// ================================================================= wiring
const LOADERS = {
  transactions: () => { loadTxnKpis(); loadR2(); loadR5(); loadR1(); loadR3(); loadR6(); },
  loans: () => { loadLoanKpis(); loadR4(); },
  cross: () => { loadR7(); },
};

function loadTab(tab) {
  dirty[tab] = false;
  LOADERS[tab]();
}

function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  if (dirty[tab]) loadTab(tab);
  requestAnimationFrame(() => charts.forEach((c) => c.resize()));
}

function filtersChanged(changedId) {
  let yf = Number($('f-year-from').value);
  let yt = Number($('f-year-to').value);
  if (yf > yt) {
    if (changedId === 'f-year-from') yt = yf; else yf = yt;
    $('f-year-from').value = yf;
    $('f-year-to').value = yt;
  }
  const regionChanged = $('f-region').value !== state.region;
  Object.assign(state, { yearFrom: yf, yearTo: yt, region: $('f-region').value, type: $('f-type').value, level: $('f-level').value });
  // a new level, year range or region starts the cash flow drill path over
  state.r1 = { level: state.level, path: [] };
  if (regionChanged) {
    state.r2.region = null;
    if (state.region) {
      state.r5.region = state.region;
      $('r5-region').value = state.region;
    }
  }
  renderOps();
  Object.keys(dirty).forEach((k) => { dirty[k] = true; });
  loadTab(state.tab);
}

function initFilters() {
  for (const y of YEARS) {
    $('f-year-from').add(new Option(y, y));
    $('f-year-to').add(new Option(y, y));
  }
  for (const id of ['r5-year', 'r6-year']) {
    $(id).add(new Option('All years', ''));
    for (const y of YEARS) $(id).add(new Option(y, y));
  }
  $('f-year-from').value = DEFAULTS.yearFrom;
  $('f-year-to').value = DEFAULTS.yearTo;
  $('f-level').value = DEFAULTS.level;

  $('filters').addEventListener('change', (e) => filtersChanged(e.target.id));
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('filters').addEventListener('reset', (e) => {
    e.preventDefault();
    $('f-year-from').value = DEFAULTS.yearFrom;
    $('f-year-to').value = DEFAULTS.yearTo;
    $('f-region').value = DEFAULTS.region;
    $('f-level').value = DEFAULTS.level;
    $('f-type').value = DEFAULTS.type;
    filtersChanged('f-reset');
  });

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // R1
  $('r1-rollup').addEventListener('click', rollupR1);
  $('r1-drill').addEventListener('click', () => {
    const next = LEVELS[LEVELS.indexOf(state.r1.level) + 1];
    if (next) { setLevel(next); loadR1(); }
  });
  $('r1-crumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-depth]');
    if (!b) return;
    const depth = Number(b.dataset.depth);
    if (depth >= state.r1.path.length) return;
    const target = state.r1.path[depth];
    setLevel(target.parentLevel);
    state.r1.path = state.r1.path.slice(0, depth);
    loadR1();
  });
  bindDrillClick('r1-chart');
  bindDrillClick('net-chart');

  // R2
  segControl('r2-measure', (v) => { state.r2.measure = v; loadR2(); });
  chart('r2-chart').on('click', (p) => { if (!r2Drilled && p.componentType === 'series') drillR2(p.name); });
  $('r2-rollup').addEventListener('click', () => { state.r2.region = null; loadR2(); });
  $('r2-crumbs').addEventListener('click', (e) => { if (e.target.closest('[data-rollup]')) { state.r2.region = null; loadR2(); } });

  // R3
  segControl('r3-measure', (v) => { state.r3.measure = v; loadR3(); });
  $('r3-swap').addEventListener('click', () => {
    state.r3.swapped = !state.r3.swapped;
    $('r3-swap').setAttribute('aria-pressed', String(state.r3.swapped));
    $('r3-swap').classList.toggle('active', state.r3.swapped);
    loadR3();
  });

  // R5
  $('r5-region').addEventListener('change', (e) => { state.r5.region = e.target.value; loadR5(); });
  $('r5-year').addEventListener('change', (e) => { state.r5.year = e.target.value; loadR5(); });
  segControl('r5-top', (v) => { state.r5.top = Number(v); loadR5(); });

  // R6
  $('r6-year').addEventListener('change', (e) => { state.r6.year = e.target.value; loadR6(); });
  segControl('r6-measure', (v) => { state.r6.measure = v; loadR6(); });

  // R4
  segControl('r4-group', (v) => { state.r4.group = v; loadR4(); });
  segControl('r4-phase', (v) => { state.r4.phase = v; loadR4(); loadLoanKpis(); });
  segControl('r4-health', (v) => { state.r4.health = v; loadR4(); loadLoanKpis(); });
  $('r4-duration').addEventListener('change', (e) => { state.r4.duration = e.target.value; loadR4(); loadLoanKpis(); });

  // R7 table sort
  const sortBy = (th) => {
    const key = th.dataset.key;
    state.r7.dir = state.r7.sort === key ? -state.r7.dir : key === 'region' ? 1 : -1;
    state.r7.sort = key;
    renderR7Table();
  };
  $('r7-table').addEventListener('click', (e) => { const th = e.target.closest('th[data-key]'); if (th) sortBy(th); });
  $('r7-table').addEventListener('keydown', (e) => {
    const th = e.target.closest('th[data-key]');
    if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(th); }
  });
}

// Region names come from the warehouse (or the demo list when no database is configured).
async function loadRegions() {
  try {
    const body = await api('regions');
    state.regions = body.rows.map((r) => r.region);
  } catch (e) {
    $('db-status').textContent = 'Regions could not be loaded: ' + e.message;
    $('db-status').className = 'db-status bad';
    state.regions = [];
  }
  for (const r of state.regions) {
    $('f-region').add(new Option(r, r));
    $('r5-region').add(new Option(r, r));
  }
  state.r5.region = state.regions.includes('Prague') ? 'Prague' : state.regions[0] || '';
  $('r5-region').value = state.r5.region;
  if (!state.regions.length) setState('card-r5', 'error', 'The region list is not available.', () => location.reload());
}

async function start() {
  lucide.createIcons();
  initFilters();
  renderOps();
  checkHealth();
  dirty.transactions = false;
  // these cards do not need the region list; start them right away
  loadTxnKpis(); loadR2(); loadR1(); loadR3(); loadR6();
  await loadRegions();
  loadR5();
}

start();
