// MacroTally — first-run setup wizard (single form).
import { state, save, todayStr, addWeight, toKg, fromKg, weightUnit } from '../store.js';
import { refreshExpenditure, latestTrend, snapshotTarget } from '../calc.js';
import { esc, fmt, parseNum, on, openModal, closeModal, toast, requestRender, icon } from '../ui.js';
import { heightFields, readHeightCm, activityOptions } from '../views/settings.js';

const DEFAULT_RATE_PCT = 0.5;

function round(v, d) {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

function rateHint(rateUser, weightUser, units) {
  const r = toKg(rateUser, units);
  const w = toKg(weightUser, units);
  if (!(r > 0) || !(w > 0)) return '';
  return `≈ ${fmt((r / w) * 100, 2)}% of bodyweight per week`;
}

/**
 * Canonical (metric) values the form is built from.
 * @typedef {{units:string, sex:string, birthYear:number, heightCm:number, weightKg:number|null, activity:number,
 *   mode:string, targetKg:number|null, rateKg:number|null}} SetupValues
 */

function fieldsHtml(v) {
  const units = v.units;
  const u = weightUnit(units);
  const w = v.weightKg ? round(fromKg(v.weightKg, units), 1) : '';
  const tgt = v.targetKg ? round(fromKg(v.targetKg, units), 1) : '';
  const rate = v.rateKg ? round(fromKg(v.rateKg, units), 2) : '';
  const opt = (val, label, cur) => `<option value="${esc(val)}"${val === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `
    <div class="field-row">
      <label class="field"><span>Units</span>
        <select name="units" data-change="setup-units">
          ${opt('imperial', 'Imperial (lb, ft)', units)}
          ${opt('metric', 'Metric (kg, cm)', units)}
        </select>
      </label>
      <label class="field"><span>Sex</span>
        <select name="sex">
          ${opt('male', 'Male', v.sex)}
          ${opt('female', 'Female', v.sex)}
        </select>
      </label>
    </div>
    <div class="field-row">
      <label class="field"><span>Birth year</span><input name="birthYear" type="text" inputmode="numeric" autocomplete="bday-year" value="${esc(v.birthYear)}" required></label>
      ${heightFields(v.heightCm, units)}
    </div>
    <div class="field-row">
      <label class="field"><span>Current weight (${esc(u)})</span><input name="weight" type="text" inputmode="decimal" autocomplete="off" value="${esc(w)}" data-input="setup-weight" required></label>
      <label class="field"><span>Activity</span><select name="activity">${activityOptions(v.activity)}</select></label>
    </div>
    <h3 class="form-section">Goal</h3>
    <div class="field-row">
      <label class="field"><span>I want to</span>
        <select name="mode" data-change="setup-mode">
          ${opt('lose', 'Lose weight', v.mode)}
          ${opt('maintain', 'Maintain', v.mode)}
          ${opt('gain', 'Gain weight', v.mode)}
        </select>
      </label>
      <label class="field"><span>Target weight (${esc(u)})</span><input name="targetWeight" type="text" inputmode="decimal" autocomplete="off" value="${esc(tgt)}" placeholder="optional"></label>
    </div>
    <div class="setup-rate"${v.mode === 'maintain' ? ' hidden' : ''}>
      <label class="field"><span>Rate per week (${esc(u)})</span><input name="rate" type="text" inputmode="decimal" autocomplete="off" value="${esc(rate)}" data-input="setup-rate"></label>
      <p class="hint setup-rate-hint">${esc(rateHint(Number(rate), Number(w), units))}</p>
    </div>`;
}

/** Read the form into canonical values using the units the fields were built with. */
function readValues(form, ctx) {
  const units = ctx.units;
  const num = (name) => {
    const el = form.elements.namedItem(name);
    return el ? parseNum(el.value) : NaN;
  };
  const weight = num('weight');
  const target = num('targetWeight');
  const rate = num('rate');
  const heightCm = readHeightCm(form);
  return {
    units,
    sex: form.elements.namedItem('sex').value === 'female' ? 'female' : 'male',
    birthYear: Math.round(num('birthYear')),
    heightCm: Number.isFinite(heightCm) ? heightCm : ctx.heightCm,
    weightKg: weight > 0 ? toKg(weight, units) : null,
    activity: Number(form.elements.namedItem('activity').value) || 1.4,
    mode: form.elements.namedItem('mode').value,
    targetKg: target > 0 ? toKg(target, units) : null,
    rateKg: rate > 0 ? toKg(rate, units) : null
  };
}

/**
 * Open the setup wizard. Sticky (cannot be dismissed) until the user has onboarded.
 * @returns {HTMLElement} backdrop
 */
export function openSetup() {
  const sticky = !state.onboarded;
  const p = state.profile || {};
  const g = state.goal || {};
  const lt = latestTrend(state.weights || []);
  const weightKg = lt ? lt.trend : null;
  /** @type {SetupValues} */
  const v = {
    units: p.units === 'metric' ? 'metric' : 'imperial',
    sex: p.sex === 'female' ? 'female' : 'male',
    birthYear: p.birthYear || 1990,
    heightCm: p.heightCm || 175,
    weightKg,
    activity: p.activity || 1.4,
    mode: g.mode || 'lose',
    targetKg: g.targetWeightKg || null,
    rateKg: state.onboarded && g.rateKgPerWeek ? g.rateKgPerWeek : (weightKg ? (weightKg * DEFAULT_RATE_PCT) / 100 : null)
  };
  const html = `
    <div class="sheet-head">
      <div class="sheet-title">
        <h2>${sticky ? 'Welcome to MacroTally' : 'Setup'}</h2>
        <div class="muted small">A few details to set your starting calorie and macro targets.</div>
      </div>
      ${sticky ? '' : `<button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>`}
    </div>
    <form class="setup-form" data-submit="setup-save">
      <div class="setup-fields">${fieldsHtml(v)}</div>
      <p class="hint">Everything stays on this device. You can change any of this later in Plan and Settings.</p>
      <button type="submit" class="btn btn-primary btn-block">${sticky ? 'Get started' : 'Save'}</button>
    </form>`;
  const bd = openModal(html, { cls: 'setup', sticky });
  bd._ctx = { units: v.units, heightCm: v.heightCm, rateTouched: state.onboarded && !!g.rateKgPerWeek };
  return bd;
}

function setupCtx(el) {
  const bd = el.closest('.modal-backdrop');
  return bd ? bd._ctx : null;
}

function updateRateHint(form, ctx) {
  const hint = form.querySelector('.setup-rate-hint');
  if (!hint) return;
  const rate = parseNum(form.elements.namedItem('rate').value);
  const w = parseNum(form.elements.namedItem('weight').value);
  hint.textContent = rateHint(rate, w, ctx.units);
}

on('setup-units', (el) => {
  const form = el.form;
  const ctx = setupCtx(el);
  if (!form || !ctx) return;
  const vals = readValues(form, ctx);
  vals.units = el.value === 'metric' ? 'metric' : 'imperial';
  ctx.units = vals.units;
  ctx.heightCm = vals.heightCm;
  form.querySelector('.setup-fields').innerHTML = fieldsHtml(vals);
});

on('setup-weight', (el) => {
  const form = el.form;
  const ctx = setupCtx(el);
  if (!form || !ctx) return;
  if (!ctx.rateTouched) {
    const w = parseNum(el.value);
    const rateEl = form.elements.namedItem('rate');
    if (rateEl) rateEl.value = w > 0 ? String(round((w * DEFAULT_RATE_PCT) / 100, 2)) : '';
  }
  updateRateHint(form, ctx);
});

on('setup-rate', (el) => {
  const ctx = setupCtx(el);
  if (!ctx || !el.form) return;
  ctx.rateTouched = true;
  updateRateHint(el.form, ctx);
});

on('setup-mode', (el) => {
  const grp = el.form && el.form.querySelector('.setup-rate');
  if (grp) grp.hidden = el.value === 'maintain';
});

on('setup-save', (form) => {
  const ctx = setupCtx(form);
  if (!ctx) return;
  const v = readValues(form, ctx);
  const thisYear = new Date().getFullYear();
  if (!(v.birthYear >= 1900 && v.birthYear <= thisYear - 10)) {
    toast('Enter a valid birth year', { kind: 'error' });
    return;
  }
  if (!(v.heightCm >= 90 && v.heightCm <= 250)) {
    toast('Enter a valid height', { kind: 'error' });
    return;
  }
  if (!(v.weightKg >= 20 && v.weightKg <= 500)) {
    toast('Enter your current weight', { kind: 'error' });
    return;
  }
  if (v.mode !== 'maintain' && !(v.rateKg > 0)) {
    toast('Enter a rate per week', { kind: 'error' });
    return;
  }
  if (v.targetKg != null && v.mode === 'lose' && v.targetKg >= v.weightKg) {
    toast('Target weight should be below your current weight', { kind: 'error' });
    return;
  }
  if (v.targetKg != null && v.mode === 'gain' && v.targetKg <= v.weightKg) {
    toast('Target weight should be above your current weight', { kind: 'error' });
    return;
  }
  const today = todayStr();
  Object.assign(state.profile, {
    units: v.units,
    sex: v.sex,
    birthYear: v.birthYear,
    heightCm: Math.round(v.heightCm * 10) / 10,
    activity: v.activity
  });
  addWeight(today, v.weightKg);
  Object.assign(state.goal, {
    mode: v.mode,
    targetWeightKg: v.targetKg,
    rateKgPerWeek: v.rateKg > 0 ? Math.abs(v.rateKg) : (state.goal.rateKgPerWeek || (v.weightKg * DEFAULT_RATE_PCT) / 100),
    startDate: today
  });
  // Re-initialize the formula estimate from the new profile unless it has already gone adaptive.
  if (state.expenditure && state.expenditure.method !== 'adaptive') state.expenditure.kcal = null;
  refreshExpenditure(state, { force: true });
  snapshotTarget(state);
  state.onboarded = true;
  save();
  closeModal(form.closest('.modal-backdrop'));
  requestRender();
  toast("You're set. Log your first meal!");
});
