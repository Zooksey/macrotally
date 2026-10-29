// MacroTally — Plan view: expenditure, targets, goal settings, intake chart.
import { state, save, todayStr, addDays, daysBetween, parseDate, toKg, fromKg, weightUnit, KG_PER_LB } from '../store.js';
import { refreshExpenditure, estimateExpenditure, targets, projection, intakeSeries, latestTrend, snapshotTarget, bankStatus, bankStreakStart } from '../calc.js';
import { lineChart, barChart } from '../charts.js';
import { esc, fmt, parseNum, dateLabel, shortDate, on, toast, requestRender, confirmDialog } from '../ui.js';

const RECALC_REASON = 'Needs ≥7 logged days and 2 weigh-ins ≥7 days apart in the last 3 weeks';
const RATE_PRESETS = [0.25, 0.5, 0.75, 1];

/** Current bodyweight estimate in kg (trend, else target, else 75). */
function currentKg() {
  const lt = latestTrend(state.weights || []);
  if (lt && Number.isFinite(lt.trend)) return lt.trend;
  if (state.goal && state.goal.targetWeightKg) return state.goal.targetWeightKg;
  return 75;
}

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function signedWeight(kgDelta, units) {
  const v = round(fromKg(kgDelta, units), 1);
  const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
  return `${sign}${fmt(Math.abs(v), 1)} ${weightUnit(units)}`;
}

function rateHintText(rateUser, units) {
  const kg = toKg(rateUser, units);
  if (!(kg > 0)) return '';
  const pct = (kg / currentKg()) * 100;
  return `≈ ${fmt(pct, 2)}% of bodyweight per week`;
}

function expenditureCard() {
  const exp = state.expenditure || {};
  const units = state.profile.units;
  const badge = exp.method === 'adaptive'
    ? '<span class="badge badge-accent">Adaptive</span>'
    : exp.method === 'formula' ? '<span class="badge">Initial estimate</span>' : '';
  const d = exp.detail;
  const detail = d && exp.method === 'adaptive'
    ? `<p class="muted small">Avg intake ${fmt(d.avgIntake)} · trend ${esc(signedWeight(d.deltaKg, units))} over ${fmt(d.spanDays)} d · ${fmt(d.loggedDays)} logged days</p>`
    : '<p class="muted small">Based on your profile and activity level. It adapts once you have about two weeks of logging and weigh-ins.</p>';
  // One point per date (the last recalculation that day wins).
  const byDate = new Map();
  (exp.history || []).forEach((h) => {
    if (h && h.date && Number.isFinite(h.kcal)) byDate.set(h.date, h);
  });
  const hist = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let chart = '';
  if (hist.length >= 2) {
    const first = hist[0].date;
    const last = hist[hist.length - 1].date;
    const span = Math.max(1, daysBetween(first, last));
    chart = lineChart({
      series: [{ points: hist.map((h) => ({ x: daysBetween(first, h.date), y: h.kcal })), color: 'var(--accent)', width: 2, dots: true }],
      height: 140,
      xLabels: [{ x: 0, label: shortDate(first) }, { x: span, label: shortDate(last) }]
    });
  }
  return `
    <section class="card">
      <div class="card-head"><h2>Expenditure</h2>${badge}</div>
      <div class="big-num">${fmt(exp.kcal)} <span class="unit">kcal/day</span></div>
      ${exp.updatedAt ? `<p class="muted small">Updated ${esc(dateLabel(exp.updatedAt))}</p>` : ''}
      ${detail}
      ${chart}
      <button type="button" class="btn btn-ghost btn-block" data-action="recalc">Recalculate now</button>
    </section>`;
}

function targetsCard() {
  const t = targets(state);
  const pr = projection(state);
  let projText = '';
  if (pr) {
    const dt = typeof pr.date === 'string' ? parseDate(pr.date) : pr.date;
    projText = `<p class="small">Goal weight in ≈ ${fmt(pr.weeks, 1)} weeks · ${esc(shortDate(dt))}</p>`;
  }
  return `
    <section class="card">
      <div class="card-head"><h2>Daily targets</h2>${t.source === 'manual' ? '<span class="badge">Manual</span>' : '<span class="badge">Auto</span>'}</div>
      <div class="target-grid">
        <div class="target"><div class="target-val">${fmt(t.cal)}</div><div class="muted small">kcal</div></div>
        <div class="target"><div class="target-val" style="color:var(--p)">${fmt(t.p)}</div><div class="muted small">protein g</div></div>
        <div class="target"><div class="target-val" style="color:var(--c)">${fmt(t.c)}</div><div class="muted small">carbs g</div></div>
        <div class="target"><div class="target-val" style="color:var(--f)">${fmt(t.f)}</div><div class="muted small">fat g</div></div>
      </div>
      ${t.floored ? '<p class="warn small">Calories were raised to the safe minimum. Consider a slower rate.</p>' : ''}
      ${projText}
    </section>`;
}

function opt(value, label, selected) {
  return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function goalForm() {
  const g = state.goal || {};
  const units = state.profile.units;
  const u = weightUnit(units);
  const imperial = units === 'imperial';
  const m = g.manual || { cal: 2000, p: 150, c: 200, f: 65 };
  const rateUser = g.rateKgPerWeek != null ? round(fromKg(g.rateKgPerWeek, units), 2) : '';
  const target = g.targetWeightKg != null ? round(fromKg(g.targetWeightKg, units), 1) : '';
  const protein = imperial ? round((g.proteinPerKg || 0) * KG_PER_LB, 2) : round(g.proteinPerKg || 0, 2);
  const fatPct = round((g.fatPct || 0) * 100, 1);
  const manual = g.macroMode === 'manual';
  const maintain = g.mode === 'maintain';
  return `
    <form class="card goal-form" data-submit="save-goal">
      <h2>Goal</h2>
      <div class="field-row">
        <label class="field"><span>Goal</span>
          <select name="mode" data-change="goal-mode">
            ${opt('lose', 'Lose weight', g.mode === 'lose')}
            ${opt('maintain', 'Maintain', g.mode === 'maintain')}
            ${opt('gain', 'Gain weight', g.mode === 'gain')}
          </select>
        </label>
        <label class="field"><span>Target weight (${esc(u)})</span>
          <input name="targetWeight" type="text" inputmode="decimal" autocomplete="off" value="${esc(target)}" placeholder="optional">
        </label>
      </div>
      <div class="rate-group"${maintain ? ' hidden' : ''}>
        <label class="field"><span>Rate per week (${esc(u)})</span>
          <input name="rate" type="text" inputmode="decimal" autocomplete="off" value="${esc(rateUser)}" data-input="rate-input">
        </label>
        <p class="hint rate-hint">${esc(rateHintText(Number(rateUser), units))}</p>
        <div class="chips">
          ${RATE_PRESETS.map((p) => `<button type="button" class="chip" data-action="rate-preset" data-pct="${p}">${p}%</button>`).join('')}
        </div>
      </div>
      <div class="field-row">
        <label class="field"><span>Protein (g per ${imperial ? 'lb' : 'kg'})</span>
          <input name="protein" type="text" inputmode="decimal" autocomplete="off" value="${esc(protein)}">
        </label>
        <label class="field"><span>Fat (% of calories)</span>
          <input name="fatPct" type="text" inputmode="decimal" autocomplete="off" value="${esc(fatPct)}">
        </label>
      </div>
      <label class="field"><span>Macro targets</span>
        <select name="macroMode" data-change="macro-mode">
          ${opt('auto', 'Auto (from expenditure & goal)', !manual)}
          ${opt('manual', 'Manual', manual)}
        </select>
      </label>
      <div class="manual-fields"${manual ? '' : ' hidden'}>
        <div class="field-row four">
          <label class="field"><span>kcal</span><input name="mcal" type="text" inputmode="numeric" value="${esc(m.cal)}"></label>
          <label class="field"><span>Protein g</span><input name="mp" type="text" inputmode="numeric" value="${esc(m.p)}"></label>
          <label class="field"><span>Carbs g</span><input name="mc" type="text" inputmode="numeric" value="${esc(m.c)}"></label>
          <label class="field"><span>Fat g</span><input name="mf" type="text" inputmode="numeric" value="${esc(m.f)}"></label>
        </div>
      </div>
      <button type="submit" class="btn btn-primary btn-block">Save goal</button>
    </form>`;
}

const BANK_HINT = 'Every finished day adds target minus eaten to the bank: under target saves calories, over '
  + 'target takes them off. A day with nothing logged resets the bank. Your targets never change; spend or '
  + 'make up the balance when you choose.';
const BANK_ROWS = 60;

/** Signed kcal with a real minus sign and its colour class: +180 (bank-pos) / −150 (over) / 0 (muted). */
function signedKcal(n) {
  const v = Math.round(Number(n) || 0);
  if (v > 0) return `<span class="bank-pos">+${fmt(v)}</span>`;
  if (v < 0) return `<span class="over">−${fmt(-v)}</span>`;
  return '<span class="muted">0</span>';
}

/** 'Tue 28' for a ledger row. */
function ledgerDay(date) {
  const d = parseDate(date);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`;
}

/** 'Mon 27 Oct'. */
function longDay(date) {
  const d = parseDate(date);
  return `${ledgerDay(date)} ${d.toLocaleDateString(undefined, { month: 'short' })}`;
}

function bankDetails() {
  const st = bankStatus(state);
  if (!st) return '';
  const rows = st.days.slice(-BANK_ROWS).reverse().map((d) => `
        <div class="ledger-row"><span class="ledger-day">${esc(ledgerDay(d.date))}</span><span class="ledger-eat">${fmt(d.eaten)} / ${fmt(d.target)}</span><span class="ledger-diff">${signedKcal(d.diff)}</span></div>`).join('');
  return `
      <p class="ledger-sum">Bank ${signedKcal(st.balance)} kcal · since ${esc(longDay(st.from))}</p>
      ${st.resetDate ? `<p class="muted small">Reset on ${esc(longDay(st.resetDate))} (no food logged)</p>` : ''}
      ${st.days.length ? `<div class="ledger">${rows}</div>` : '<p class="muted small">Nothing counted yet. Finished days are added the next day.</p>'}
      ${st.days.length ? '<button type="button" class="btn btn-ghost btn-block" data-action="bank-reset">Reset bank</button>' : ''}`;
}

function bankCard() {
  const on = !!(state.bank && state.bank.on);
  return `
    <section class="card bank-card">
      <h2>Calorie bank</h2>
      <label class="check-row"><input type="checkbox" data-change="bank-toggle"${on ? ' checked' : ''}><span>Keep a calorie bank</span></label>
      ${on ? bankDetails() : ''}
      <p class="hint">${esc(BANK_HINT)}</p>
    </section>`;
}

function intakeCard() {
  const t = targets(state);
  const series = intakeSeries(state, 14);
  const bars = series.map((d) => ({
    label: String(parseDate(d.date).getDate()),
    value: d.logged ? d.cal : 0,
    color: 'var(--accent)',
    muted: !d.logged
  }));
  const logged = series.filter((d) => d.logged);
  const avg = logged.length ? logged.reduce((s, d) => s + d.cal, 0) / logged.length : null;
  return `
    <section class="card">
      <div class="card-head"><h2>Intake, last 14 days</h2></div>
      ${barChart({ bars, line: { value: t.cal, color: 'var(--muted)', label: 'Target' }, yFmt: (v) => fmt(v) })}
      <p class="muted small">${logged.length ? `Average ${fmt(avg)} kcal on ${logged.length} logged day${logged.length === 1 ? '' : 's'}` : 'No days logged yet'}</p>
    </section>`;
}

/**
 * Plan tab: expenditure estimate, current targets, calorie bank, goal form and intake chart.
 * @returns {string} HTML
 */
export function planView() {
  return `
    <header class="topbar"><h1>Plan</h1></header>
    ${expenditureCard()}
    ${targetsCard()}
    ${bankCard()}
    ${goalForm()}
    ${intakeCard()}`;
}

on('recalc', () => {
  const before = state.expenditure.kcal;
  refreshExpenditure(state, { force: true });
  snapshotTarget(state);
  save();
  const est = estimateExpenditure(state, addDays(todayStr(), -1));
  if (state.expenditure.method !== 'adaptive' || est == null) {
    toast(RECALC_REASON, { ms: 4000 });
  } else {
    const after = state.expenditure.kcal;
    toast(after === before ? `Expenditure unchanged at ${fmt(after)} kcal/day` : `Expenditure updated to ${fmt(after)} kcal/day`);
  }
  requestRender();
});

on('goal-mode', (el) => {
  const form = el.form;
  const grp = form && form.querySelector('.rate-group');
  if (grp) grp.hidden = el.value === 'maintain';
});

on('macro-mode', (el) => {
  const form = el.form;
  const box = form && form.querySelector('.manual-fields');
  if (box) box.hidden = el.value !== 'manual';
});

on('rate-input', (el) => {
  const hint = el.form && el.form.querySelector('.rate-hint');
  if (hint) hint.textContent = rateHintText(parseNum(el.value), state.profile.units);
});

on('rate-preset', (el) => {
  const form = el.closest('form');
  if (!form) return;
  const pct = Number(el.dataset.pct);
  const units = state.profile.units;
  const kg = (currentKg() * pct) / 100;
  const v = round(fromKg(kg, units), 2);
  form.rate.value = String(v);
  const hint = form.querySelector('.rate-hint');
  if (hint) hint.textContent = rateHintText(v, units);
});

on('save-goal', (form) => {
  const units = state.profile.units;
  const g = state.goal;
  const mode = form.mode.value;
  const targetRaw = parseNum(form.targetWeight.value);
  const rate = parseNum(form.rate.value);
  const protein = parseNum(form.protein.value);
  const fatPct = parseNum(form.fatPct.value);
  const macroMode = form.macroMode.value === 'manual' ? 'manual' : 'auto';

  if (form.targetWeight.value.trim() !== '' && !(targetRaw > 0)) {
    toast('Target weight must be a positive number', { kind: 'error' });
    return;
  }
  if (mode !== 'maintain' && !(Math.abs(rate) > 0)) {
    toast('Enter a rate per week (or pick a preset)', { kind: 'error' });
    return;
  }
  if (!(protein > 0)) {
    toast('Enter a protein target', { kind: 'error' });
    return;
  }
  if (!(fatPct >= 10 && fatPct <= 70)) {
    toast('Fat should be between 10% and 70% of calories', { kind: 'error' });
    return;
  }
  let manual = g.manual;
  if (macroMode === 'manual') {
    const cal = parseNum(form.mcal.value);
    const p = parseNum(form.mp.value);
    const c = parseNum(form.mc.value);
    const f = parseNum(form.mf.value);
    if (![cal, p, c, f].every((v) => v >= 0) || !(cal > 0)) {
      toast('Fill in all manual targets', { kind: 'error' });
      return;
    }
    manual = { cal: Math.round(cal), p: Math.round(p), c: Math.round(c), f: Math.round(f) };
  }

  const modeChanged = g.mode !== mode;
  g.mode = mode;
  // Fields left as rendered keep their stored (unrounded) value, so saving doesn't drift on unit rounding.
  const edited = (input) => input.value.trim() !== input.defaultValue.trim();
  if (edited(form.targetWeight)) g.targetWeightKg = form.targetWeight.value.trim() === '' ? null : toKg(targetRaw, units);
  if (edited(form.rate) && Number.isFinite(rate) && rate !== 0) g.rateKgPerWeek = Math.abs(toKg(rate, units));
  if (edited(form.protein)) g.proteinPerKg = units === 'imperial' ? protein / KG_PER_LB : protein;
  if (edited(form.fatPct)) g.fatPct = fatPct / 100;
  g.macroMode = macroMode;
  g.manual = manual;
  if (!g.startDate || modeChanged) g.startDate = todayStr();
  snapshotTarget(state);
  save();
  toast('Goal saved');
  requestRender();
});

on('bank-toggle', (el) => {
  const bank = state.bank;
  bank.on = !!el.checked;
  if (bank.on) {
    if (!bank.since) bank.since = bankStreakStart(state); // count the current logged streak from the start
    snapshotTarget(state);
  }
  save();
  toast(bank.on ? 'Calorie bank on' : 'Calorie bank off');
  requestRender();
});

on('bank-reset', async () => {
  const ok = await confirmDialog('Start the bank again from today?', { okLabel: 'Reset' });
  if (!ok) return;
  state.bank.since = todayStr();
  snapshotTarget(state);
  save();
  toast('Bank reset');
  requestRender();
});
