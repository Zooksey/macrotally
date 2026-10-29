/**
 * MacroTally — state, persistence, local dates and units.
 * All dates are local 'YYYY-MM-DD' strings (never toISOString, which is UTC).
 */

/** Kilograms per pound (exact). */
export const KG_PER_LB = 0.45359237;
/** localStorage key holding the whole app state as JSON. */
export const STORAGE_KEY = 'macrotally_v1';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Local date string for a Date.
 * @param {Date} [d=new Date()]
 * @returns {string} 'YYYY-MM-DD'
 */
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Parse a 'YYYY-MM-DD' string to a Date at LOCAL midnight.
 * @param {string} s
 * @returns {Date}
 */
export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * Add n days to a date string (DST-safe; works on calendar days).
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

/**
 * Whole calendar days from a to b (b - a).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

/**
 * Short random unique id.
 * @returns {string}
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * A fresh default state object.
 * @returns {object}
 */
export function defaults() {
  return {
    version: 1,
    onboarded: false,
    profile: { name: '', sex: 'male', birthYear: 1990, heightCm: 175, units: 'imperial', activity: 1.4, usdaKey: '', region: 'us' },
    goal: {
      mode: 'lose',
      targetWeightKg: null,
      rateKgPerWeek: 0.45,
      proteinPerKg: 1.8,
      fatPct: 0.28,
      macroMode: 'auto',
      manual: { cal: 2000, p: 150, c: 200, f: 65 },
      startDate: null
    },
    expenditure: { kcal: null, method: null, updatedAt: null, detail: null, history: [] },
    // Calorie bank: running tally of (target − eaten) over finished days since `since` (see bankStatus in
    // js/calc.js). targets = { 'YYYY-MM-DD': kcal } snapshots of the base calorie target per day.
    bank: { on: false, since: null, targets: {} },
    weights: [],
    foods: {},
    diary: {},
    recents: [],
    favorites: [],
    meals: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'],
    // User-imported food packs (raw macrotally-pack/1 JSON keyed by pack id); see js/packs.js.
    packs: {},
    // Ids of food packs (bundled or user) switched off on this device: not searched; see js/packs.js.
    packsOff: [],
    // Google Drive backup connection. Belongs to this device: kept as-is when a backup is imported.
    drive: {
      connected: false,
      email: '',
      fileId: null,
      autoBackup: true,
      lastBackupAt: null,
      lastError: null
    },
    // Weigh-ins pulled from a GitHub gist that an iPhone Shortcut fills from Apple Health; see js/feed.js.
    // imported = { 'YYYY-MM-DD': kg } of the weigh-ins the feed wrote (never overwrites a typed weigh-in).
    feed: { gistId: '', lastSync: null, lastCount: 0, lastError: null, imported: {} },
    // AI helper (the owner's server running Claude; see js/ai.js and SPEC-ai.md). url + secret both set = on.
    // lastOk = ISO time of the last answer; lastError = message of the last failed request.
    ai: { url: '', secret: '', lastOk: null, lastError: null }
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Object.assign(defaults(), obj), but nested profile/goal/expenditure/bank/drive/feed/ai objects are merged too. */
function merge(obj) {
  const out = Object.assign(defaults(), isObj(obj) ? obj : {});
  const d = defaults();
  for (const k of ['profile', 'goal', 'expenditure', 'bank', 'drive', 'feed', 'ai']) {
    out[k] = Object.assign({}, d[k], isObj(out[k]) ? out[k] : {});
  }
  out.goal.manual = Object.assign({}, d.goal.manual, isObj(out.goal.manual) ? out.goal.manual : {});
  if (!isObj(out.bank.targets)) out.bank.targets = {};
  if (!isObj(out.feed.imported)) out.feed.imported = {};
  if (typeof out.feed.gistId !== 'string') out.feed.gistId = '';
  for (const k of ['url', 'secret']) if (typeof out.ai[k] !== 'string') out.ai[k] = '';
  for (const k of ['lastOk', 'lastError']) if (typeof out.ai[k] !== 'string') out.ai[k] = null;
  if (!Array.isArray(out.expenditure.history)) out.expenditure.history = [];
  if (!Array.isArray(out.weights)) out.weights = [];
  if (!Array.isArray(out.recents)) out.recents = [];
  if (!Array.isArray(out.favorites)) out.favorites = [];
  if (!Array.isArray(out.meals) || !out.meals.length) out.meals = d.meals;
  if (!isObj(out.foods)) out.foods = {};
  if (!isObj(out.diary)) out.diary = {};
  if (!isObj(out.packs)) out.packs = {};
  out.packsOff = Array.isArray(out.packsOff) ? [...new Set(out.packsOff.filter((x) => typeof x === 'string' && x))] : [];
  return out;
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function load() {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw) return merge(JSON.parse(raw));
  } catch (e) {
    console.warn('MacroTally: could not read saved data', e);
  }
  return defaults();
}

/**
 * The live app state. Mutate in place, then call save().
 * Reassigned by replaceState/resetAll/importJSON (ES module live binding).
 * @type {object}
 */
export let state = load();

/**
 * Persist state to localStorage. Quota/privacy-mode errors are swallowed (console.warn).
 * @returns {void}
 */
export function save() {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('MacroTally: could not save data (storage full or unavailable)', e);
  }
}

/**
 * Replace the whole state (merged over defaults) and save.
 * @param {object} obj
 * @returns {void}
 */
export function replaceState(obj) {
  state = merge(obj);
  save();
}

/**
 * Erase everything back to defaults and save.
 * @returns {void}
 */
export function resetAll() {
  state = defaults();
  save();
}

/**
 * Pretty-printed JSON backup of the state.
 * @returns {string}
 */
export function exportJSON() {
  return JSON.stringify(state, null, 2);
}

/**
 * Restore a backup produced by exportJSON(). This device's state.drive block is kept
 * (the Drive connection belongs to the device, not to the backup). The backup's imported food
 * packs (state.packs) are restored when it has them; an older backup without a packs object keeps
 * the packs already on this device.
 * @param {string} text
 * @throws {Error} 'Not a MacroTally backup' when the JSON is invalid or lacks diary/version.
 * @returns {void}
 */
export function importJSON(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error('Not a MacroTally backup');
  }
  if (!obj || typeof obj !== 'object' || !obj.diary || !obj.version) throw new Error('Not a MacroTally backup');
  const keep = state.drive;
  const keepPacks = state.packs;
  replaceState(obj);
  state.drive = keep;
  if (!isObj(obj.packs) && isObj(keepPacks)) state.packs = keepPacks;
  save();
}

// ---------- Units ----------

/**
 * Convert a user-unit weight to kg (imperial: lb → kg).
 * @param {number} value
 * @param {'metric'|'imperial'} units
 * @returns {number}
 */
export function toKg(value, units) {
  return units === 'imperial' ? Number(value) * KG_PER_LB : Number(value);
}

/**
 * Convert kg to the user's unit.
 * @param {number} kg
 * @param {'metric'|'imperial'} units
 * @returns {number}
 */
export function fromKg(kg, units) {
  return units === 'imperial' ? Number(kg) / KG_PER_LB : Number(kg);
}

/**
 * Weight unit label for the unit system.
 * @param {'metric'|'imperial'} units
 * @returns {'kg'|'lb'}
 */
export function weightUnit(units) {
  return units === 'imperial' ? 'lb' : 'kg';
}

/**
 * Format a kg weight in user units, e.g. "182.4 lb" / "82.7 kg". '–' for null/NaN.
 * @param {number} kg
 * @param {'metric'|'imperial'} units
 * @param {number} [digits=1]
 * @returns {string}
 */
export function fmtWeight(kg, units, digits = 1) {
  if (kg === null || kg === undefined || !Number.isFinite(Number(kg))) return '–';
  return `${fromKg(kg, units).toFixed(digits)} ${weightUnit(units)}`;
}

// ---------- Diary / foods / weights ----------

/**
 * Get the diary day for a date, creating it if missing (does NOT save on create).
 * @param {string} date
 * @returns {{entries: object[]}}
 */
export function getDay(date) {
  if (!state.diary[date]) state.diary[date] = { entries: [] };
  if (!Array.isArray(state.diary[date].entries)) state.diary[date].entries = [];
  return state.diary[date];
}

/**
 * Append an entry to a day (assigns an id if missing), bump the food in recents, save.
 * @param {string} date
 * @param {object} entry
 * @returns {void}
 */
export function addEntry(date, entry) {
  if (!entry.id) entry.id = uid();
  getDay(date).entries.push(entry);
  if (entry.foodId) touchRecent(entry.foodId);
  save();
}

/**
 * Patch an existing entry (id is preserved) and save.
 * @param {string} date
 * @param {string} entryId
 * @param {object} patch
 * @returns {void}
 */
export function updateEntry(date, entryId, patch) {
  const e = state.diary[date]?.entries?.find((x) => x.id === entryId);
  if (e) Object.assign(e, patch, { id: entryId });
  save();
}

/**
 * Remove an entry (and the day itself if it becomes empty) and save.
 * @param {string} date
 * @param {string} entryId
 * @returns {void}
 */
export function removeEntry(date, entryId) {
  const day = state.diary[date];
  if (day?.entries) {
    day.entries = day.entries.filter((x) => x.id !== entryId);
    if (!day.entries.length) delete state.diary[date];
  }
  save();
}

/**
 * Move a food id to the front of recents (max 40) and save.
 * @param {string} foodId
 * @returns {void}
 */
export function touchRecent(foodId) {
  state.recents = [foodId, ...state.recents.filter((id) => id !== foodId)].slice(0, 40);
  save();
}

/**
 * Toggle a food's favorite status and save.
 * @param {string} foodId
 * @returns {boolean} the new favorite status
 */
export function toggleFavorite(foodId) {
  const fav = state.favorites.includes(foodId);
  state.favorites = fav ? state.favorites.filter((id) => id !== foodId) : [foodId, ...state.favorites];
  save();
  return !fav;
}

/**
 * Store a food in the local library and save.
 * @param {object} food
 * @returns {void}
 */
export function saveFood(food) {
  state.foods[food.id] = food;
  save();
}

/**
 * Delete a food from the library (and recents/favorites). Logged entries keep their snapshots.
 * @param {string} foodId
 * @returns {void}
 */
export function deleteFood(foodId) {
  delete state.foods[foodId];
  state.recents = state.recents.filter((id) => id !== foodId);
  state.favorites = state.favorites.filter((id) => id !== foodId);
  save();
}

/**
 * Add or replace the weigh-in for a date (kept sorted ascending by date) and save.
 * @param {string} date
 * @param {number} kg
 * @returns {void}
 */
export function addWeight(date, kg) {
  const w = state.weights.filter((x) => x.date !== date);
  w.push({ date, kg: Number(kg) });
  w.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  state.weights = w;
  save();
}

/**
 * Remove the weigh-in for a date and save.
 * @param {string} date
 * @returns {void}
 */
export function removeWeight(date) {
  state.weights = state.weights.filter((x) => x.date !== date);
  save();
}
