// MacroTally — Weight view: trend weight stats, chart, log form and history.
import { state, todayStr, addDays, daysBetween, toKg, fromKg, weightUnit, fmtWeight, addWeight, removeWeight } from '../store.js';
import { trendSeries } from '../calc.js';
import { lineChart } from '../charts.js';
import { esc, fmt, parseNum, dateLabel, shortDate, icon, on, toast, requestRender, confirmDialog } from '../ui.js';

/** Selected chart range in days, or 'all'. Persists while the app is open. */
let range = 90;

const RANGES = [
  { id: '30', label: '30 d' },
  { id: '90', label: '90 d' },
  { id: '180', label: '180 d' },
  { id: 'all', label: 'All' }
];

function signedWeight(kgDelta, units) {
  if (kgDelta == null || !Number.isFinite(kgDelta)) return '–';
  const v = fromKg(kgDelta, units);
  const r = Math.round(v * 10) / 10;
  const sign = r > 0 ? '+' : r < 0 ? '−' : '±';
  return `${sign}${fmt(Math.abs(r), 1)} ${weightUnit(units)}`;
}

/** Trend change between the latest point and the last point on/before (latest - days). */
function trendChange(series, days) {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const cutoff = addDays(last.date, -days);
  let ref = null;
  for (let i = series.length - 2; i >= 0; i--) {
    if (series[i].date <= cutoff) {
      ref = series[i];
      break;
    }
  }
  if (!ref) return null;
  return last.trend - ref.trend;
}

function progressBlock(series, units) {
  const goal = state.goal || {};
  if (goal.mode === 'maintain' || goal.targetWeightKg == null || !series.length) return '';
  const last = series[series.length - 1];
  // Starting point: last trend point on/before the goal start date, else the first one after it.
  let start = series[0];
  if (goal.startDate) {
    start = series.filter((p) => p.date <= goal.startDate).pop()
      || series.find((p) => p.date >= goal.startDate)
      || series[0];
  }
  const total = goal.targetWeightKg - start.trend;
  const done = last.trend - start.trend;
  const toGo = goal.targetWeightKg - last.trend;
  let pct = 0;
  if (Math.abs(total) > 0.05) pct = Math.max(0, Math.min(100, (done / total) * 100));
  const reached = (goal.mode === 'lose' && toGo >= 0) || (goal.mode === 'gain' && toGo <= 0);
  return `
    <div class="progress-block">
      <div class="macro-head"><span>Progress to ${esc(fmtWeight(goal.targetWeightKg, units))}</span>
        <span>${reached ? 'Reached' : `${esc(fmt(Math.abs(fromKg(toGo, units)), 1))} ${esc(weightUnit(units))} to go`}</span></div>
      <div class="bar"><span style="width:${(reached ? 100 : pct).toFixed(1)}%"></span></div>
    </div>`;
}

function chartBlock(series, units) {
  if (!series.length) return '<div class="chart-empty">No data yet</div>';
  const today = todayStr();
  const from = range === 'all' ? series[0].date : addDays(today, -Number(range));
  const pts = series.filter((p) => p.date >= from);
  if (!pts.length) return '<div class="chart-empty">No weigh-ins in this range</div>';
  // The chart scales its x domain to the data, so labels span first → last weigh-in.
  const first = pts[0].date;
  const span = Math.max(1, daysBetween(first, pts[pts.length - 1].date));
  const raw = pts.map((p) => ({ x: daysBetween(first, p.date), y: fromKg(p.kg, units) }));
  const trend = pts.map((p) => ({ x: daysBetween(first, p.date), y: fromKg(p.trend, units) }));
  const xLabels = [];
  const nLabels = span >= 3 ? 4 : 2;
  for (let i = 0; i < nLabels; i++) {
    const x = Math.round((span * i) / (nLabels - 1));
    xLabels.push({ x, label: shortDate(addDays(first, x)) });
  }
  const yFmt = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? fmt(v) : fmt(v, 1));
  return lineChart({
    series: [
      { points: raw, color: 'var(--muted)', width: 0, dots: true },
      { points: trend, color: 'var(--accent)', width: 2.5 }
    ],
    yFmt,
    xLabels
  });
}

/**
 * Weight tab: trend stats, chart with range chips, log form and recent entries.
 * @returns {string} HTML
 */
export function weightView() {
  const units = state.profile.units;
  const u = weightUnit(units);
  const weights = state.weights || [];
  const series = weights.length ? trendSeries(weights) : [];
  const last = series.length ? series[series.length - 1] : null;
  const ch7 = trendChange(series, 7);
  const ch30 = trendChange(series, 30);
  const trendByDate = new Map(series.map((p) => [p.date, p.trend]));
  const recent = weights.slice(-30).reverse();
  const today = todayStr();

  const stats = last
    ? `
      <div class="stat-hero">
        <div class="muted small">Trend weight</div>
        <div class="big-num">${esc(fmtWeight(last.trend, units))}</div>
        <div class="muted small">Scale ${esc(fmtWeight(last.kg, units))} · ${esc(dateLabel(last.date))}</div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="muted small">7-day change</div><div class="stat-val">${esc(signedWeight(ch7, units))}</div></div>
        <div class="stat"><div class="muted small">30-day change</div><div class="stat-val">${esc(signedWeight(ch30, units))}</div></div>
      </div>
      ${progressBlock(series, units)}`
    : '<p class="muted">Log your weight to start tracking your trend. Daily weigh-ins (morning, after the bathroom) give the smoothest trend.</p>';

  return `
    <header class="topbar"><h1>Weight</h1></header>
    <section class="card">${stats}</section>
    <section class="card">
      <div class="chips" role="tablist">
        ${RANGES.map((r) => `<button type="button" class="chip${String(range) === r.id ? ' active' : ''}" data-action="weight-range" data-range="${r.id}">${esc(r.label)}</button>`).join('')}
      </div>
      ${chartBlock(series, units)}
      <div class="legend small muted"><span class="dot dot-muted"></span> Scale <span class="line-swatch"></span> Trend</div>
    </section>
    <form class="card" data-submit="weight-log">
      <h2>Log weight</h2>
      <div class="field-row">
        <label class="field"><span>Date</span><input name="date" type="date" value="${esc(today)}" max="${esc(today)}" required></label>
        <label class="field"><span>Weight (${esc(u)})</span><input name="weight" type="text" inputmode="decimal" autocomplete="off" required></label>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Save weight</button>
    </form>
    <section class="card">
      <h2>Recent entries</h2>
      ${recent.length ? `<div class="list">${recent.map((w) => `
        <div class="row static">
          <div class="row-main">
            <div class="row-title">${esc(fmtWeight(w.kg, units))}</div>
            <div class="row-sub">${esc(dateLabel(w.date))}${trendByDate.has(w.date) ? ` · trend ${esc(fmtWeight(trendByDate.get(w.date), units))}` : ''}</div>
          </div>
          <button type="button" class="icon-btn" data-action="weight-delete" data-date="${esc(w.date)}" aria-label="Delete weight for ${esc(dateLabel(w.date))}">${icon('trash')}</button>
        </div>`).join('')}</div>` : '<p class="muted small">No entries yet.</p>'}
    </section>`;
}

on('weight-range', (el) => {
  const r = el.dataset.range;
  range = r === 'all' ? 'all' : Number(r) || 90;
  requestRender();
});

on('weight-log', (form) => {
  const date = form.date.value || todayStr();
  const v = parseNum(form.weight.value);
  if (!(v > 0)) {
    toast('Enter your weight', { kind: 'error' });
    return;
  }
  const kg = toKg(v, state.profile.units);
  if (kg < 20 || kg > 500) {
    toast('That weight looks off', { kind: 'error' });
    return;
  }
  if (date > todayStr()) {
    toast("Can't log a future weight", { kind: 'error' });
    return;
  }
  addWeight(date, kg);
  toast('Weight saved');
  requestRender();
});

on('weight-delete', async (el) => {
  const date = el.dataset.date;
  const ok = await confirmDialog(`Delete the weigh-in for ${dateLabel(date)}?`, { okLabel: 'Delete', danger: true });
  if (!ok) return;
  removeWeight(date);
  toast('Deleted');
  requestRender();
});
