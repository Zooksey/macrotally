/**
 * MacroTally — trend weight, adaptive expenditure, targets and totals.
 * Pure functions over the state shape defined in SPEC.md (they never save).
 */
import { todayStr, addDays, daysBetween } from './store.js';

/** Approximate energy content of 1 kg of body-mass change. */
export const KCAL_PER_KG = 7700;

const round10 = (x) => Math.round(x / 10) * 10;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const sortByDate = (arr) => [...arr].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/**
 * EWMA trend weight. Gap-aware: for a gap of g days the effective alpha is 1 - (1 - alpha)^g,
 * so sparse (e.g. weekly) weigh-ins still move the trend.
 * @param {{date:string, kg:number}[]} weights sorted ascending (re-sorted defensively)
 * @param {number} [alpha=0.1]
 * @returns {{date:string, kg:number, trend:number}[]}
 */
export function trendSeries(weights, alpha = 0.1) {
  const out = [];
  let trend = null;
  let prev = null;
  for (const w of sortByDate(weights || [])) {
    const kg = Number(w.kg);
    if (!Number.isFinite(kg)) continue;
    if (trend === null) {
      trend = kg;
    } else {
      const gap = Math.max(1, daysBetween(prev, w.date));
      const a = 1 - Math.pow(1 - alpha, gap);
      trend += a * (kg - trend);
    }
    prev = w.date;
    out.push({ date: w.date, kg, trend });
  }
  return out;
}

/**
 * Most recent trend point.
 * @param {{date:string, kg:number}[]} weights
 * @returns {{date:string, kg:number, trend:number}|null}
 */
export function latestTrend(weights) {
  const s = trendSeries(weights);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Basal metabolic rate (Mifflin-St Jeor).
 * @param {{sex:'male'|'female', kg:number, cm:number, age:number}} p
 * @returns {number} kcal/day
 */
export function bmr({ sex, kg, cm, age }) {
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
}

/**
 * Formula-based starting expenditure: round(bmr * profile.activity).
 * @param {object} profile
 * @param {number} kg
 * @returns {number}
 */
export function initialExpenditure(profile, kg) {
  const age = new Date().getFullYear() - (Number(profile.birthYear) || 1990);
  const b = bmr({ sex: profile.sex, kg: Number(kg) || 75, cm: Number(profile.heightCm) || 175, age });
  return Math.round(b * (Number(profile.activity) || 1.4));
}

/**
 * Sum the nutrients of a diary day.
 * @param {{entries:object[]}|undefined} day
 * @returns {{cal:number, p:number, c:number, f:number, fiber:number}}
 */
export function dayTotals(day) {
  const t = { cal: 0, p: 0, c: 0, f: 0, fiber: 0 };
  for (const e of day?.entries || []) {
    for (const k of Object.keys(t)) t[k] += Number(e[k]) || 0;
  }
  return t;
}

/**
 * Adaptive TDEE over the window ending at endDate (inclusive).
 * Intake averages only days with ≥1 entry. Weight change uses the full trend series,
 * from the first to the last weigh-in inside the window.
 * tdee = avgIntake - deltaKg * KCAL_PER_KG / spanDays.
 * @param {object} state
 * @param {string} endDate
 * @param {number} [windowDays=21]
 * @returns {{kcal:number, avgIntake:number, deltaKg:number, spanDays:number, loggedDays:number}|null}
 *   null unless loggedDays ≥ 7, ≥ 2 weigh-ins in window and spanDays ≥ 7.
 */
export function estimateExpenditure(state, endDate, windowDays = 21) {
  const start = addDays(endDate, -(windowDays - 1));
  let sum = 0;
  let loggedDays = 0;
  for (const [date, day] of Object.entries(state.diary || {})) {
    if (date < start || date > endDate) continue;
    if (!day?.entries?.length) continue;
    sum += dayTotals(day).cal;
    loggedDays++;
  }
  const inWindow = trendSeries(state.weights).filter((w) => w.date >= start && w.date <= endDate);
  if (loggedDays < 7 || inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const spanDays = daysBetween(first.date, last.date);
  if (spanDays < 7) return null;
  const avgIntake = sum / loggedDays;
  const deltaKg = last.trend - first.trend;
  const kcal = avgIntake - (deltaKg * KCAL_PER_KG) / spanDays;
  return { kcal: Math.round(kcal), avgIntake: Math.round(avgIntake), deltaKg, spanDays, loggedDays };
}

/**
 * Initialize or weekly-refresh state.expenditure (mutates state; caller saves).
 * - kcal null → formula estimate (method 'formula').
 * - else if force or ≥7 days since updatedAt → blend 50/50 with estimateExpenditure(state, yesterday)
 *   (clamped 1000–6000, method 'adaptive'); updatedAt/history are updated even when no estimate is possible.
 * @param {object} state
 * @param {{force?:boolean}} [opts]
 * @returns {boolean} true if state.expenditure changed
 */
export function refreshExpenditure(state, { force = false } = {}) {
  const ex = state.expenditure;
  const today = todayStr();
  if (!Array.isArray(ex.history)) ex.history = [];
  if (ex.kcal === null || ex.kcal === undefined || !Number.isFinite(Number(ex.kcal))) {
    const lt = latestTrend(state.weights);
    ex.kcal = initialExpenditure(state.profile, lt ? lt.trend : 75);
    ex.method = 'formula';
    ex.updatedAt = today;
    ex.detail = null;
    ex.history.push({ date: today, kcal: ex.kcal, method: ex.method });
    if (ex.history.length > 200) ex.history = ex.history.slice(-200);
    return true;
  }
  if (!force && ex.updatedAt && daysBetween(ex.updatedAt, today) < 7) return false;
  const est = estimateExpenditure(state, addDays(today, -1));
  if (est) {
    ex.kcal = clamp(Math.round(0.5 * Number(ex.kcal) + 0.5 * est.kcal), 1000, 6000);
    ex.method = 'adaptive';
    ex.detail = est;
  }
  ex.updatedAt = today;
  // One history point per day: a repeated "Recalculate now" replaces today's point instead of stacking.
  const last = ex.history[ex.history.length - 1];
  if (last && last.date === today) {
    last.kcal = ex.kcal;
    last.method = ex.method;
  } else {
    ex.history.push({ date: today, kcal: ex.kcal, method: ex.method });
  }
  if (ex.history.length > 200) ex.history = ex.history.slice(-200);
  return true;
}

/**
 * Signed weekly rate in kg (negative for lose, positive for gain, 0 for maintain).
 * @param {object} goal
 * @returns {number}
 */
export function signedRate(goal) {
  const r = Math.abs(Number(goal?.rateKgPerWeek) || 0);
  if (goal?.mode === 'lose') return -r;
  if (goal?.mode === 'gain') return r;
  return 0;
}

/**
 * Daily calorie and macro targets.
 * @param {object} state
 * @returns {{cal:number, p:number, c:number, f:number, floored:boolean, source:'auto'|'manual'}}
 */
export function targets(state) {
  const goal = state.goal;
  if (goal.macroMode === 'manual') {
    return { ...goal.manual, floored: false, source: 'manual' };
  }
  const lt = latestTrend(state.weights);
  const trendKg = lt ? lt.trend : (Number(goal.targetWeightKg) || 75);
  const exp = Number.isFinite(Number(state.expenditure?.kcal)) && state.expenditure.kcal !== null
    ? Number(state.expenditure.kcal)
    : initialExpenditure(state.profile, trendKg);
  let cal = round10(exp + (signedRate(goal) * KCAL_PER_KG) / 7);
  const floor = state.profile.sex === 'female' ? 1200 : 1500;
  let floored = false;
  if (cal < floor) {
    cal = floor;
    floored = true;
  }
  const p = Math.round((Number(goal.proteinPerKg) || 0) * trendKg);
  let f = Math.round(((Number(goal.fatPct) || 0) * cal) / 9);
  let c = Math.round((cal - 4 * p - 9 * f) / 4);
  if (c < 0) {
    c = 0;
    f = Math.max(0, Math.round((cal - 4 * p) / 9));
  }
  return { cal, p, c, f, floored, source: 'auto' };
}

/**
 * Projection to the goal weight at the configured rate.
 * @param {object} state
 * @returns {{weeks:number, date:string}|null} null for maintain / no target / rate 0 / no weigh-ins / already past target
 */
export function projection(state) {
  const goal = state.goal;
  const rate = signedRate(goal);
  const target = goal.targetWeightKg;
  if (goal.mode === 'maintain' || target === null || target === undefined || rate === 0) return null;
  const lt = latestTrend(state.weights);
  if (!lt) return null;
  const diff = Number(target) - lt.trend;
  if (!Number.isFinite(diff) || diff === 0 || Math.sign(diff) !== Math.sign(rate)) return null;
  const weeks = Math.round((Math.abs(diff) / Math.abs(rate)) * 10) / 10;
  return { weeks, date: addDays(todayStr(), Math.round(weeks * 7)) };
}

/**
 * Daily intake for the last `days` days ending today (oldest first).
 * @param {object} state
 * @param {number} [days=14]
 * @returns {{date:string, cal:number, logged:boolean}[]}
 */
export function intakeSeries(state, days = 14) {
  const today = todayStr();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const day = state.diary?.[date];
    out.push({ date, cal: dayTotals(day).cal, logged: !!day?.entries?.length });
  }
  return out;
}

// ---------- Calorie bank ----------

/**
 * Record the base calorie target for `date` (default today) in state.bank.targets, so later target
 * changes do not rewrite past days. Drops snapshots older than bank.since or older than 400 days.
 * Mutates state; caller saves.
 * @param {object} state
 * @param {string} [date=todayStr()]
 * @returns {number} the recorded kcal
 */
export function snapshotTarget(state, date = todayStr()) {
  if (!state.bank || typeof state.bank !== 'object') state.bank = { on: false, since: null, targets: {} };
  const bank = state.bank;
  if (!bank.targets || typeof bank.targets !== 'object' || Array.isArray(bank.targets)) bank.targets = {};
  const cal = targets(state).cal;
  bank.targets[date] = cal;
  const oldest = addDays(date, -400);
  for (const k of Object.keys(bank.targets)) {
    if (k < oldest || (bank.since && k < bank.since)) delete bank.targets[k];
  }
  return cal;
}

/**
 * The calorie bank as of `date`: the tally of finished days from bank.since up to but excluding
 * min(date, today). null when bank.on is false or since is null. Days oldest first: a day with no entries
 * resets the balance to 0 (resetDate = that day; the list restarts after it); a day with entries adds
 * diff = round(target − eaten), target = bank.targets[day] ?? targets(state).cal.
 * @param {object} state
 * @param {string} [date=todayStr()]
 * @returns {null|{balance:number, since:string, from:string, resetDate:string|null,
 *   days:{date:string, target:number, eaten:number, diff:number, balance:number}[]}}
 *   from: first counted day (the day after the last reset, or since); days: counted days oldest first
 *   with the running balance.
 */
export function bankStatus(state, date = todayStr()) {
  const bank = state?.bank;
  if (!bank || !bank.on || !bank.since) return null;
  const today = todayStr();
  const end = date < today ? date : today;
  const snaps = bank.targets && typeof bank.targets === 'object' ? bank.targets : {};
  let current = null;
  let balance = 0;
  let from = bank.since;
  let resetDate = null;
  let days = [];
  for (let d = bank.since; d < end; d = addDays(d, 1)) {
    const day = state.diary?.[d];
    if (!day?.entries?.length) {
      balance = 0;
      resetDate = d;
      from = addDays(d, 1);
      days = [];
      continue;
    }
    const snap = Number(snaps[d]);
    let target;
    if (snaps[d] !== null && snaps[d] !== undefined && Number.isFinite(snap)) {
      target = snap;
    } else {
      if (current === null) current = targets(state).cal;
      target = current;
    }
    const eaten = dayTotals(day).cal;
    const diff = Math.round(target - eaten);
    balance += diff;
    days.push({ date: d, target, eaten, diff, balance });
  }
  return { balance, since: bank.since, from, resetDate, days };
}

/**
 * Where a newly switched-on bank should start counting: the first day of the run of logged days that ends
 * yesterday (so the tally reflects the current streak at once), or `date` itself when yesterday has no
 * entries. Looks back at most `maxDays` days.
 * @param {object} state
 * @param {string} [date=todayStr()]
 * @param {number} [maxDays=60]
 * @returns {string} YYYY-MM-DD
 */
export function bankStreakStart(state, date = todayStr(), maxDays = 60) {
  let start = date;
  for (let i = 1; i <= maxDays; i++) {
    const d = addDays(date, -i);
    if (!state.diary?.[d]?.entries?.length) break;
    start = d;
  }
  return start;
}
