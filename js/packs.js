/**
 * MacroTally — food packs: restaurant menus as searchable offline food lists (format `macrotally-pack/1`).
 * Bundled packs are listed in data/packs/index.json and loaded lazily once per session; user-imported packs
 * live in state.packs (raw pack JSON keyed by id, so backups carry them). A user pack with the same id as a
 * bundled pack overrides it. Packs whose id is in state.packsOff are switched off on this device: their foods are
 * left out of packFoods() (so search skips them); foods already logged or saved in the library are untouched.
 */
import { state, save } from './store.js';

/** Pack file format identifier. */
export const PACK_FORMAT = 'macrotally-pack/1';

/** Index of bundled packs, relative to this module (works from any sub-path). */
export const BUNDLED_INDEX = new URL('../data/packs/index.json', import.meta.url);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r2 = (x) => Math.round(x * 100) / 100;
const fmtG = (g) => String(Math.round(g * 10) / 10);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Validated bundled packs (id → pack) from the last successful load. */
let bundled = new Map();
/** Converted foods of the bundled packs (id → Food[]). */
let bundledFoods = new Map();
/** In-flight or settled load; reset after a failure so a later call can retry. */
let loading = null;
let loaded = false;
/** Cache of all converted foods, rebuilt when the bundled set, state.packs or state.packsOff changes. */
let cache = null;
let cacheUserRef = null;
let cacheOffRef = null;

/**
 * One validated pack food: `{ id, n, cat?, s: [label, grams|null], v: [kcal, p, c, f, fiber] }`, or null
 * when the food is unusable (missing id/name, or v not an array of >= 4 finite numbers >= 0).
 */
function cleanFood(f) {
  if (!isObj(f)) return null;
  const id = typeof f.id === 'number' && Number.isFinite(f.id) ? String(f.id) : str(f.id);
  const n = str(f.n);
  if (!id || !n) return null;
  if (!Array.isArray(f.v) || f.v.length < 4) return null;
  const v = f.v.slice(0, 5);
  if (!v.every(isNum)) return null;
  while (v.length < 5) v.push(0);
  const s = Array.isArray(f.s) ? f.s : [];
  const label = str(s[0]) || '1 serving';
  const grams = isNum(s[1]) && s[1] > 0 ? s[1] : null;
  const out = { id, n, s: [label, grams], v };
  const cat = str(f.cat);
  if (cat) out.cat = cat;
  return out;
}

/**
 * Validate a parsed pack (section 1 of SPEC-packs.md) and return a cleaned copy holding only valid foods
 * (duplicate food ids keep the first). Throws an Error with a user-readable message when the pack itself
 * is invalid; a pack with zero valid foods is returned with an empty foods array (callers decide).
 * @param {*} obj
 * @returns {{format:string, id:string, name:string, brand:string, source:string, generated:string, foods:object[]}}
 */
function cleanPack(obj) {
  if (!isObj(obj) || obj.format !== PACK_FORMAT) throw new Error('Not a MacroTally food pack (expected format "macrotally-pack/1").');
  const id = str(obj.id);
  const name = str(obj.name);
  if (!id || !name) throw new Error('This food pack has no id or name.');
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('The food pack id must use only lowercase letters, digits and dashes.');
  if (!Array.isArray(obj.foods)) throw new Error('This food pack has no foods list.');
  const seen = new Set();
  const foods = [];
  for (const raw of obj.foods) {
    const f = cleanFood(raw);
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    foods.push(f);
  }
  return {
    format: PACK_FORMAT,
    id,
    name,
    brand: str(obj.brand) || name,
    source: str(obj.source),
    generated: str(obj.generated),
    foods
  };
}

/**
 * Convert one pack food to a Food. With serving grams (`s[1]` > 0) it is a normal per-100 g food with one
 * serving "<label> (<g> g)"; without grams it is a `servingOnly` food whose per100 holds ONE serving and whose
 * single serving weighs a nominal 100 g (so qty 1 x 100 g = one serving).
 * @param {{id:string, brand?:string, name?:string}} pack
 * @param {{id:string|number, n:string, cat?:string, s?:Array, v:number[]}} f
 * @returns {object|null} Food (source 'pack'), or null when the food is malformed
 */
export function packFoodToFood(pack, f) {
  const c = cleanFood(f);
  if (!c || !pack) return null;
  const packId = String(pack.id || '');
  const [label, grams] = c.s;
  const [cal, p, carbs, fat, fiber] = c.v;
  const base = {
    id: `pack:${packId}:${c.id}`,
    source: 'pack',
    packId,
    barcode: null,
    name: c.n,
    brand: String(pack.brand || pack.name || ''),
    category: c.cat || ''
  };
  if (grams) {
    const k = 100 / grams;
    return {
      ...base,
      per100: { cal: r2(cal * k), p: r2(p * k), c: r2(carbs * k), f: r2(fat * k), fiber: r2(fiber * k) },
      servings: [{ label: `${label} (${fmtG(grams)} g)`, grams }],
      defaultGrams: grams
    };
  }
  return {
    ...base,
    servingOnly: true,
    per100: { cal: r2(cal), p: r2(p), c: r2(carbs), f: r2(fat), fiber: r2(fiber) },
    servings: [{ label, grams: 100 }],
    defaultGrams: 100
  };
}

function convertPack(pack) {
  return (pack.foods || []).map((f) => packFoodToFood(pack, f)).filter(Boolean);
}

/** User packs from state, validated (invalid entries are skipped, never thrown). */
function userPacks() {
  const out = new Map();
  const packs = isObj(state.packs) ? state.packs : {};
  for (const [key, raw] of Object.entries(packs)) {
    try {
      const p = cleanPack(raw);
      if (p.foods.length) out.set(p.id || key, p);
    } catch {
      // A broken stored pack is ignored rather than breaking search.
    }
  }
  return out;
}

/** Ids of the packs switched off on this device. */
function offIds() {
  return new Set(Array.isArray(state.packsOff) ? state.packsOff.filter((x) => typeof x === 'string') : []);
}

/** Rebuild the converted food list (bundled packs overridden by user packs with the same id; off packs left out). */
function refresh() {
  const users = userPacks();
  const off = offIds();
  const list = [];
  for (const [id, foods] of bundledFoods) if (!users.has(id) && !off.has(id)) list.push(...foods);
  for (const p of users.values()) if (!off.has(p.id)) list.push(...convertPack(p));
  cache = { list, users, off };
  cacheUserRef = state.packs;
  cacheOffRef = state.packsOff;
}

function current() {
  // state is reassigned by backup restore / erase, so a different packs object or packsOff array means a rebuild.
  if (!cache || cacheUserRef !== state.packs || cacheOffRef !== state.packsOff) refresh();
  return cache;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (res.status === 404) return null; // not part of this deployment: settles as "no pack"
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Fetch the bundled pack index and each bundled pack once, and convert them (plus the user packs in
 * state.packs) to Foods. Idempotent; never throws: a missing index or pack file means zero bundled foods,
 * and a network failure resolves with what is available (a later call retries).
 * @param {{reload?: boolean}} [opts] reload: fetch again even after a successful load
 * @returns {Promise<object[]>} all pack Foods
 */
export function loadPacks({ reload = false } = {}) {
  if (reload) loading = null;
  if (!loading) {
    loading = (async () => {
      let failed = false;
      const nextPacks = new Map();
      try {
        if (typeof fetch !== 'function') throw new Error('fetch unavailable');
        const index = await fetchJSON(BUNDLED_INDEX.href);
        const files = index && Array.isArray(index.packs) ? index.packs.filter((x) => typeof x === 'string' && x) : [];
        const results = await Promise.allSettled(files.map((file) => fetchJSON(new URL(file, BUNDLED_INDEX).href)));
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            failed = true;
            console.warn(`Food pack ${files[i]} unavailable:`, r.reason && r.reason.message);
            return;
          }
          if (!r.value) return;
          try {
            const p = cleanPack(r.value);
            if (p.foods.length) nextPacks.set(p.id, p);
          } catch (err) {
            console.warn(`Food pack ${files[i]} is invalid:`, err && err.message);
          }
        });
      } catch (err) {
        failed = true;
        console.warn('Bundled food packs unavailable:', err && err.message);
      }
      if (!failed || nextPacks.size) {
        bundled = nextPacks;
        bundledFoods = new Map([...nextPacks].map(([id, p]) => [id, convertPack(p)]));
      }
      if (failed) loading = null;
      else loaded = true;
      refresh();
      return cache.list;
    })();
  }
  return loading;
}

/**
 * Synchronous access to all converted pack foods (bundled once loaded, plus user packs); [] before.
 * @returns {object[]} Foods
 */
export function packFoods() {
  return current().list;
}

/**
 * true once the bundled pack index has been loaded successfully (even when it lists no packs).
 * @returns {boolean}
 */
export function packsLoaded() {
  return loaded;
}

/**
 * Kick off loading in the background (fire-and-forget; called from app.js at start).
 * @returns {void}
 */
export function preloadPacks() {
  loadPacks();
}

/**
 * Packs available on this device, sorted by name. A user pack overriding a bundled one is listed once,
 * as the user pack. enabled is false for a pack switched off on this device.
 * @returns {{id:string, name:string, count:number, generated:string, bundled:boolean, enabled:boolean}[]}
 */
export function listPacks() {
  const { users, off } = current();
  const out = [];
  for (const p of bundled.values()) {
    if (!users.has(p.id)) out.push({ id: p.id, name: p.name, count: (bundledFoods.get(p.id) || []).length, generated: p.generated, bundled: true, enabled: !off.has(p.id) });
  }
  for (const p of users.values()) out.push({ id: p.id, name: p.name, count: p.foods.length, generated: p.generated, bundled: false, enabled: !off.has(p.id) });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Import a pack from JSON text: validates it, stores it in state.packs (replacing an older copy with the
 * same id, overriding a bundled pack with that id, and switching the id back on if it was off), saves and refreshes.the food list.
 * @param {string} text
 * @returns {{id:string, name:string, count:number}}
 * @throws {Error} with a user-readable message when the file is not a valid pack or has no valid foods
 */
export function importPack(text) {
  let obj;
  try {
    obj = JSON.parse(String(text));
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const pack = cleanPack(obj);
  if (!pack.foods.length) throw new Error(`"${pack.name}" has no valid foods (each needs an id, a name and nutrition values).`);
  if (!isObj(state.packs)) state.packs = {};
  state.packs[pack.id] = pack;
  // Importing is an explicit choice: a pack switched off under this id comes back on.
  if (Array.isArray(state.packsOff) && state.packsOff.includes(pack.id)) state.packsOff = state.packsOff.filter((x) => x !== pack.id);
  save();
  refresh();
  return { id: pack.id, name: pack.name, count: pack.foods.length };
}

/**
 * Delete a user-imported pack (a bundled pack it overrode becomes visible again), save and refresh.
 * Foods already logged or saved in the library are kept.
 * @param {string} id
 * @returns {boolean} true when a pack was removed
 */
export function removePack(id) {
  if (!isObj(state.packs) || !Object.prototype.hasOwnProperty.call(state.packs, id)) return false;
  delete state.packs[id];
  save();
  refresh();
  return true;
}

/**
 * Switch a pack (bundled or user) on or off on this device. Off packs are left out of packFoods(), so search
 * skips them; foods already logged or saved in the library are untouched. Writes a new state.packsOff array
 * (so the cache sees the change), saves and refreshes. An id that is neither a listed pack nor already off,
 * or a pack already in the requested state, is a no-op.
 * @param {string} id
 * @param {boolean} on
 * @returns {boolean} true when the setting changed
 */
export function setPackEnabled(id, on) {
  const key = String(id || '');
  const off = Array.isArray(state.packsOff) ? state.packsOff.filter((x) => typeof x === 'string') : [];
  const isOff = off.includes(key);
  if (!key || isOff === !on) return false;
  if (!isOff && !listPacks().some((p) => p.id === key)) return false;
  state.packsOff = on ? off.filter((x) => x !== key) : [...off, key];
  save();
  refresh();
  return true;
}
