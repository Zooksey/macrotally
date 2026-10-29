/**
 * MacroTally — AI add: talks to the owner's AI helper server (server/ai-server.mjs, which runs the Claude Code CLI
 * on their Claude subscription), turns its answer into Foods, and matches them against the foods the app already
 * has so no duplicate is created. Nothing here runs unless Settings holds a helper URL and secret (state.ai).
 * See SPEC-ai.md.
 */
import { state, save } from './store.js';
import { makeCustomFood, unitOptions, rankFoods, tokenize } from './foods.js';

/** Client-side limit for one ask (the server stops Claude after 85 s; Cloudflare gives up at 100 s). */
const ASK_TIMEOUT_MS = 95000;
const HEALTH_TIMEOUT_MS = 15000;
/** Longest description the helper accepts. */
export const MAX_AI_TEXT = 2000;

/**
 * true when the AI helper is set up (url and secret both non-empty).
 * @param {object} [s] app state (defaults to the live state)
 * @returns {boolean}
 */
export function aiConfigured(s = state) {
  const ai = s && s.ai;
  return !!(ai && String(ai.url || '').trim() && String(ai.secret || '').trim());
}

/**
 * Clean up a helper address: trims and strips trailing '/'. Must be https://, or http://localhost /
 * http://127.0.0.1 (any port) for development.
 * @param {string} url
 * @returns {string}
 * @throws {Error} with a readable message otherwise
 */
export function normalizeUrl(url) {
  const raw = String(url ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error("Enter the helper's address, e.g. https://ai.example.com");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a web address (it should start with https://)");
  }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (u.protocol !== 'https:' && !local) throw new Error('The helper address must start with https:// (http:// only works for localhost)');
  if (u.search || u.hash || u.username || u.password) throw new Error('Enter just the address, without ?, # or a user name');
  return raw;
}

/**
 * Shrink a photo for upload: longest side at most `max` px, JPEG at `quality`, EXIF orientation applied.
 * Uses createImageBitmap + canvas, falling back to an <img> when createImageBitmap is missing or fails.
 * @param {Blob} file
 * @param {{max?: number, quality?: number}} [opts]
 * @returns {Promise<{base64: string, mime: 'image/jpeg'}>} base64 without the data: prefix
 */
export async function downscaleImage(file, { max = 1280, quality = 0.85 } = {}) {
  let src = null;
  let w = 0;
  let h = 0;
  let cleanup = () => {};
  if (typeof createImageBitmap === 'function') {
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = src.width;
      h = src.height;
      cleanup = () => { if (typeof src.close === 'function') src.close(); };
    } catch {
      src = null;
    }
  }
  if (!src) {
    const url = URL.createObjectURL(file);
    try {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Couldn't read that photo"));
        img.src = url;
      });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    w = src.naturalWidth || src.width;
    h = src.naturalHeight || src.height;
    cleanup = () => URL.revokeObjectURL(url);
  }
  try {
    if (!(w > 0 && h > 0)) throw new Error("Couldn't read that photo");
    const k = Math.min(1, max / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // transparent PNGs become white, not black
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(src, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mime: 'image/jpeg' };
  } finally {
    cleanup();
  }
}

/**
 * User-facing message for a helper HTTP status.
 * @param {number} status
 * @param {string} [serverError] the body's `error` field, if any
 * @returns {string}
 */
export function aiErrorMessage(status, serverError = '') {
  if (status === 401) return 'The helper rejected the secret';
  if (status === 429) return 'The helper is busy, try again in a minute';
  if (status === 504) return 'The helper took too long';
  if (status === 502) return "Claude didn't return a food";
  if (status === 413) return 'That photo is too large for the helper';
  if (status === 404) return 'No AI helper at that address (404)';
  if (status === 400) return serverError ? `The helper refused the request: ${serverError}` : 'The helper refused the request';
  return `The helper had a problem (HTTP ${status})`;
}

/** Error thrown when the caller aborted (Cancel / sheet closed); never shown or recorded. */
function cancelled() {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  e.cancelled = true;
  return e;
}

async function call(path, { method = 'GET', body, signal, timeoutMs }) {
  if (!aiConfigured(state)) throw new Error('Set up the AI helper in Settings');
  const base = String(state.ai.url).trim().replace(/\/+$/, '');
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res;
  try {
    const headers = { Authorization: `Bearer ${String(state.ai.secret).trim()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    res = await fetch(`${base}${path}`, { method, headers, body, signal: ctrl.signal, cache: 'no-store' });
  } catch {
    if (signal && signal.aborted && !timedOut) throw cancelled();
    throw new Error("Can't reach the helper");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) throw new Error(aiErrorMessage(res.status, json && typeof json.error === 'string' ? json.error : ''));
  if (!json || typeof json !== 'object') throw new Error('The helper sent an unreadable reply');
  return json;
}

/**
 * Ask the helper about a meal: POST /v1/food. Records state.ai.lastOk (and clears lastError) or lastError, and
 * saves. A caller abort rejects with an error whose `cancelled` is true (not recorded).
 * @param {{text?: string, image?: {base64: string, mime?: string}|null, signal?: AbortSignal}} o
 * @returns {Promise<{items: object[], model?: string, seconds?: number}>}
 */
export async function askAi({ text = '', image = null, signal } = {}) {
  const body = { text: String(text || '') };
  if (image && image.base64) {
    body.image = image.base64;
    body.mime = image.mime || 'image/jpeg';
  }
  try {
    const data = await call('/v1/food', { method: 'POST', body: JSON.stringify(body), signal, timeoutMs: ASK_TIMEOUT_MS });
    if (!Array.isArray(data.items) || !data.items.length) throw new Error("Claude didn't return a food");
    state.ai.lastOk = new Date().toISOString();
    state.ai.lastError = null;
    save();
    return data;
  } catch (err) {
    if (!(err && err.cancelled)) {
      state.ai.lastError = (err && err.message) || "Can't reach the helper";
      save();
    }
    throw err;
  }
}

/**
 * Check the connection: GET /v1/health. Same error messages as askAi; success clears state.ai.lastError.
 * @returns {Promise<{version: string, model: string}>}
 */
export async function testAi() {
  const data = await call('/v1/health', { timeoutMs: HEALTH_TIMEOUT_MS });
  if (!data.ok) throw new Error('The helper sent an unreadable reply');
  if (state.ai.lastError) {
    state.ai.lastError = null;
    save();
  }
  return { version: String(data.version || '?'), model: String(data.model || '?') };
}

/**
 * Claude's item as a custom Food (not saved). per 'serving' + servingGrams → per-100 g food with that serving;
 * per 'serving' without grams → servingOnly food; per '100g' → per-100 g food (serving when known).
 * @param {object} item
 * @returns {object} Food
 */
export function foodFromAiItem(item) {
  const sg = Number(item && item.servingGrams);
  return makeCustomFood({
    name: item.name,
    brand: item.brand || '',
    per: item.per === '100g' ? '100g' : 'serving',
    servingGrams: Number.isFinite(sg) && sg > 0 ? sg : null,
    servingLabel: item.servingLabel || '1 serving',
    cal: item.cal,
    p: item.p,
    c: item.c,
    f: item.f,
    fiber: item.fiber
  });
}

/**
 * The amount Claude says was eaten, as a quantity in one of the food's units (from unitOptions):
 * grams known and the food not servingOnly → grams; else servings known → the food's first serving × servings;
 * else 1 × first serving, or 100 g when the food has no serving.
 * @param {object} item
 * @param {object} food the food the entry will use (Claude's or an existing one)
 * @returns {{qty: number, unit: {label: string, grams: number}}}
 */
export function amountFromAiItem(item, food) {
  const units = unitOptions(food);
  const g = units.find((u) => u.label === 'g');
  const serving = (food.servings && food.servings.length) ? units[0] : null;
  const grams = Number(item && item.grams);
  const servings = Number(item && item.servings);
  const sg = Number(item && item.servingGrams);
  if (grams > 0 && g && !food.servingOnly) return { qty: Math.round(grams * 10) / 10, unit: g };
  if (servings > 0 && sg > 0 && g && !food.servingOnly) {
    // Claude's serving (1 medium, 118 g) need not be the stored food's first serving (1 cup, 225 g): use a
    // stored serving of the same weight when there is one, else grams.
    const sameWeight = units.find((u) => u.label !== 'g' && u.label !== 'oz' && Math.abs(Number(u.grams) - sg) < 0.5);
    if (sameWeight) return { qty: Math.round(servings * 100) / 100, unit: sameWeight };
    return { qty: Math.round(servings * sg * 10) / 10, unit: g };
  }
  if (serving) return { qty: servings > 0 ? Math.round(servings * 100) / 100 : 1, unit: serving };
  return { qty: 100, unit: g || units[0] };
}

/**
 * Badge text for Claude's confidence.
 * @param {string} c 'label' | 'web' | 'estimate'
 * @returns {string}
 */
export function confidenceLabel(c) {
  if (c === 'label') return 'Label';
  if (c === 'web') return 'Web';
  return 'Estimate';
}

const near = (a, b, rel, abs = 0) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b));

/** Nutrients of one serving of a food (servingOnly: per100 is one serving), or null when it has no serving. */
function perServing(food) {
  const n = food.per100 || {};
  if (food.servingOnly) return n;
  const s = food.servings && food.servings[0];
  if (!s || !(Number(s.grams) > 0)) return null;
  const k = Number(s.grams) / 100;
  const out = {};
  for (const key of ['cal', 'p', 'c', 'f', 'fiber']) out[key] = (Number(n[key]) || 0) * k;
  return out;
}

/**
 * Compare Claude's food with a stored one: per 100 g when neither is servingOnly, else per (first) serving; when
 * only one side is servingOnly and the other has no serving, they are not comparable.
 * same = kcal within 10 % and each of p, c, f within max(2 g, 15 %). diffs lists the values outside that band
 * (fiber is listed too but never breaks `same`). Tolerances are relative to the stored value.
 * @param {object} aiFood
 * @param {object} existing
 * @returns {{comparable: boolean, same?: boolean, basis?: '100g'|'serving', diffs?: {key: string, ai: number, existing: number}[]}}
 */
export function compareNutrients(aiFood, existing) {
  if (!aiFood || !existing) return { comparable: false };
  let a;
  let e;
  let basis;
  if (!aiFood.servingOnly && !existing.servingOnly) {
    a = aiFood.per100 || {};
    e = existing.per100 || {};
    basis = '100g';
  } else {
    a = perServing(aiFood);
    e = perServing(existing);
    basis = 'serving';
    if (!a || !e) return { comparable: false };
  }
  const diffs = [];
  let same = true;
  for (const key of ['cal', 'p', 'c', 'f', 'fiber']) {
    const av = Number(a[key]) || 0;
    const ev = Number(e[key]) || 0;
    const ok = key === 'cal' ? near(av, ev, 0.10) : near(av, ev, 0.15, 2);
    if (!ok) {
      diffs.push({ key, ai: av, existing: ev });
      if (key !== 'fiber') same = false;
    }
  }
  return { comparable: true, same, basis, diffs };
}

/**
 * Look for a food the app already has that is the same as Claude's item (no second AI call): ranks the pool for
 * "brand name" (rankFoods, top 5), then keeps candidates whose name and brand tokens cover at least 60 % of the
 * item's name tokens (brand words are taken out of the item's name first, so "Dot's Pretzels Original" by
 * "Dot's Pretzels" counts as "original"), and, when both have a brand, whose brand shares a token. Library foods
 * win, then the better rank.
 * @param {object} item Claude's item
 * @param {object} food foodFromAiItem(item)
 * @param {object[]} pool library + built-in + enabled pack foods
 * @param {{localIds?: Set<string>}} [opts] ids of the user's library (default: state.foods)
 * @returns {{food: object, cmp: ReturnType<typeof compareNutrients>}|null}
 */
export function findExisting(item, food, pool, { localIds } = {}) {
  const ids = localIds || new Set(Object.keys((state && state.foods) || {}));
  const brand = String((item && item.brand) || '').trim();
  const name = String((item && item.name) || '').trim();
  const query = `${brand} ${name}`.trim();
  if (!tokenize(query).length) return null;
  const brandTok = new Set(tokenize(brand));
  const allName = [...new Set(tokenize(name))];
  const nameTok = allName.filter((t) => !brandTok.has(t));
  const want = nameTok.length ? nameTok : allName;
  if (!want.length) return null;
  const ranked = rankFoods(query, (pool || []).filter((f) => f && f.id && f.id !== (food && food.id)), { limit: 5, localIds: ids });
  const matches = [];
  ranked.forEach((cand, rank) => {
    const candName = tokenize(cand.name);
    const candBrand = tokenize(cand.brand);
    const have = new Set([...candName, ...candBrand]);
    const covered = want.filter((t) => have.has(t)).length;
    if (covered / want.length < 0.6) return;
    if (brandTok.size && candBrand.length && !candBrand.some((t) => brandTok.has(t))) return;
    // A generic food ("banana", no brand) must not become a branded one ("Banana · Five Guys"), unless the
    // user saved that branded food themselves.
    if (!brandTok.size && candBrand.length && !ids.has(cand.id)) return;
    matches.push({ cand, rank, lib: ids.has(cand.id) ? 1 : 0 });
  });
  if (!matches.length) return null;
  matches.sort((x, y) => y.lib - x.lib || x.rank - y.rank);
  const best = matches[0].cand;
  return { food: best, cmp: compareNutrients(food, best) };
}
