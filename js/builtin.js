/**
 * MacroTally — built-in generic food list (data/foods.json, USDA Foundation + SR Legacy).
 * Loaded lazily once per session and searched locally (works offline once cached by the service worker).
 */

/** Location of the data file, relative to this module (so it works from any sub-path). */
const DATA_URL = new URL('../data/foods.json', import.meta.url).href;

/** Loaded foods (empty until the first successful load). */
let foods = [];
/** In-flight or settled load; reset after a failure so a later call can retry. */
let loading = null;

const n1 = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : 0;
};

/**
 * Convert one compact record `{ id, n, c, p100: [kcal, p, c, f, fiber], s: [[label, grams]] }` to a Food.
 * @param {object} r
 * @returns {object|null} Food (source 'builtin'), or null when the record is malformed
 */
function toFood(r) {
  if (!r || typeof r !== 'object' || !r.id || !r.n) return null;
  const p = Array.isArray(r.p100) ? r.p100 : [];
  const servings = (Array.isArray(r.s) ? r.s : [])
    .filter((s) => Array.isArray(s) && s[0] && n1(s[1]) > 0)
    .map(([label, grams]) => ({ label: `${label} (${n1(grams)} g)`, grams: n1(grams) }));
  return {
    id: String(r.id),
    source: 'builtin',
    barcode: null,
    name: String(r.n),
    brand: '',
    category: String(r.c || ''),
    per100: { cal: n1(p[0]), p: n1(p[1]), c: n1(p[2]), f: n1(p[3]), fiber: n1(p[4]) },
    servings,
    defaultGrams: servings[0] ? servings[0].grams : 100
  };
}

/**
 * Lazily fetch ./data/foods.json once and convert it to Food objects (source 'builtin').
 * Never throws: resolves to [] on any failure (and a later call retries).
 * @returns {Promise<object[]>} Foods
 */
export function loadBuiltinFoods() {
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const list = (data && Array.isArray(data.foods) ? data.foods : []).map(toFood).filter(Boolean);
        foods = list;
        return list;
      } catch (err) {
        console.warn('Built-in food list unavailable:', err && err.message);
        loading = null;
        return [];
      }
    })();
  }
  return loading;
}

/**
 * Synchronous access to the built-in foods after they have loaded; [] before.
 * @returns {object[]} Foods
 */
export function builtinFoods() {
  return foods;
}

/**
 * Kick off loading in the background (fire-and-forget; called from app.js at start).
 * @returns {void}
 */
export function preloadBuiltinFoods() {
  loadBuiltinFoods();
}
