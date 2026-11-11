/**
 * MacroTally — food lookup (Open Food Facts, USDA FoodData Central), result ranking and portion scaling.
 * Food nutrients are always normalized to per 100 g, except `servingOnly` foods (restaurant items with no
 * known weight): their per100 holds ONE serving and their single serving weighs a nominal 100 g.
 */
import { uid, state } from './store.js';
import { config } from './config.js';
import { builtinFoods } from './builtin.js';

/** Grams unit. */
export const UNIT_G = { label: 'g', grams: 1 };
/** Ounce unit. */
export const UNIT_OZ = { label: 'oz', grams: 28.3495 };

const OFF_BASE = 'https://world.openfoodfacts.org';

/** Open Food Facts country subdomains for region-ranked search results. */
export const REGIONS = [
  { code: 'world', label: 'Worldwide' },
  { code: 'us', label: 'United States' },
  { code: 'ca', label: 'Canada' },
  { code: 'uk', label: 'United Kingdom' },
  { code: 'ie', label: 'Ireland' },
  { code: 'au', label: 'Australia' },
  { code: 'nz', label: 'New Zealand' },
  { code: 'de', label: 'Germany' },
  { code: 'fr', label: 'France' },
  { code: 'es', label: 'Spain' },
  { code: 'it', label: 'Italy' },
  { code: 'nl', label: 'Netherlands' },
  { code: 'mx', label: 'Mexico' }
];

/** Search base for a region code (falls back to world). Barcode lookups always use world. */
function offSearchBase(region) {
  const code = String(region || '').toLowerCase();
  return REGIONS.some((r) => r.code === code) ? `https://${code}.openfoodfacts.org` : OFF_BASE;
}
const OFF_FIELDS = 'code,product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,quantity,unique_scans_n';
const USDA_BASE = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const TIMEOUT_MS = 12000;

/** Number or null: parses numeric strings, rejects non-finite and negative values. */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const r2 = (x) => Math.round(x * 100) / 100;
const fmtG = (g) => String(Math.round(g * 10) / 10);

const GRAMS_PER_UNIT = {
  g: 1, gr: 1, gram: 1, grams: 1, mg: 0.001, kg: 1000,
  ml: 1, cl: 10, dl: 100, l: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495, floz: 29.5735,
  lb: 453.592, lbs: 453.592
};
const QTY_RE = /(\d+(?:[.,]\d+)?)\s*(fl\.?\s*oz|ounces?|oz|grams?|gr|mg|kg|g|ml|cl|dl|l|lbs?)(?![a-z])/gi;

/**
 * Serving size in grams. Uses serving_quantity when it is a positive number (or numeric string),
 * else parses free text like "30 g", "30g", "1 cup (240 ml)", "2 oz" (ml treated as ≈ g).
 * @param {string|null} servingSize
 * @param {*} servingQuantity
 * @returns {number|null}
 */
export function parseServingGrams(servingSize, servingQuantity) {
  const q = num(servingQuantity);
  if (q !== null && q > 0) return q;
  if (!servingSize) return null;
  QTY_RE.lastIndex = 0;
  let m;
  while ((m = QTY_RE.exec(String(servingSize))) !== null) {
    const n = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase().replace(/[.\s]/g, '');
    const per = GRAMS_PER_UNIT[unit];
    if (per && n > 0) return Math.round(n * per * 10) / 10;
  }
  return null;
}

/** Label for a serving from OFF/USDA text + grams. */
function servingLabel(text, grams) {
  const t = String(text || '').trim();
  if (!t) return `1 serving (${fmtG(grams)} g)`;
  if (/^[\d.,]+\s*(g|gr|grams?|ml)$/i.test(t)) return `1 serving (${t})`;
  if (t.includes('(')) return t;
  return `${t} (${fmtG(grams)} g)`;
}

/** Fill in calories / zeros so per100 always has every key. Returns null when nothing usable. */
function completeNutrients({ cal, p, c, f, fiber }) {
  if (cal === null && p === null && c === null && f === null) return null;
  const pp = p ?? 0;
  const cc = c ?? 0;
  const ff = f ?? 0;
  const kcal = cal ?? (4 * pp + 4 * cc + 9 * ff);
  return { cal: r2(kcal), p: r2(pp), c: r2(cc), f: r2(ff), fiber: r2(fiber ?? 0) };
}

function offNutrients(n, suffix) {
  let cal = num(n[`energy-kcal${suffix}`]);
  if (cal === null) {
    const kj = num(n[`energy-kj${suffix}`]) ?? num(n[`energy${suffix}`]);
    if (kj !== null) cal = kj / 4.184;
  }
  return {
    cal,
    p: num(n[`proteins${suffix}`]),
    c: num(n[`carbohydrates${suffix}`]),
    f: num(n[`fat${suffix}`]),
    fiber: num(n[`fiber${suffix}`])
  };
}

const allMissing = (o) => o.cal === null && o.p === null && o.c === null && o.f === null;

/**
 * Convert an Open Food Facts product to a Food.
 * @param {object} product
 * @returns {object|null} Food, or null if it has no usable nutrients
 */
export function foodFromOFF(product) {
  if (!product || typeof product !== 'object') return null;
  const n = product.nutriments || {};
  const servingGrams = parseServingGrams(product.serving_size, product.serving_quantity);
  let raw = offNutrients(n, '_100g');
  if (allMissing(raw)) {
    const s = offNutrients(n, '_serving');
    if (allMissing(s) || !servingGrams) return null;
    const k = 100 / servingGrams;
    raw = {};
    for (const key of Object.keys(s)) raw[key] = s[key] === null ? null : s[key] * k;
  }
  const per100 = completeNutrients(raw);
  if (!per100) return null;
  const code = String(product.code || '').trim();
  const servings = [];
  if (servingGrams) servings.push({ label: servingLabel(product.serving_size, servingGrams), grams: servingGrams });
  const pkg = parseServingGrams(product.quantity, null);
  if (pkg && pkg !== servingGrams && pkg <= 5000) servings.push({ label: `1 package (${fmtG(pkg)} g)`, grams: pkg });
  const name = String(product.product_name || product.product_name_en || '').trim() || 'Unnamed product';
  const brand = String(product.brands || '').split(',')[0].trim();
  return {
    id: `off:${code || uid()}`,
    source: 'off',
    barcode: code || null,
    name,
    brand,
    per100,
    servings,
    defaultGrams: servingGrams || 100,
    pop: num(product.unique_scans_n) ?? 0
  };
}

const titleCase = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()) : s);

/**
 * Convert a USDA FoodData Central search result to a Food.
 * @param {object} item
 * @returns {object|null}
 */
export function foodFromUSDA(item) {
  if (!item || !item.fdcId) return null;
  const byNum = {};
  for (const fn of item.foodNutrients || []) {
    const key = String(fn.nutrientNumber ?? fn.nutrient?.number ?? '');
    const v = num(fn.value ?? fn.amount);
    if (key && v !== null && byNum[key] === undefined) byNum[key] = v;
  }
  let cal = byNum['208'] ?? byNum['957'] ?? byNum['958'] ?? null;
  if (cal === null && byNum['268'] !== undefined) cal = byNum['268'] / 4.184;
  const per100 = completeNutrients({
    cal,
    p: byNum['203'] ?? null,
    c: byNum['205'] ?? null,
    f: byNum['204'] ?? null,
    fiber: byNum['291'] ?? null
  });
  if (!per100) return null;
  const servings = [];
  const unit = String(item.servingSizeUnit || '').toLowerCase();
  const size = num(item.servingSize);
  if (size && size > 0 && ['g', 'ml', 'grm', 'mlt'].includes(unit)) {
    const hh = String(item.householdServingFullText || '').trim();
    servings.push({ label: hh ? `${hh} (${fmtG(size)} g)` : `1 serving (${fmtG(size)} g)`, grams: size });
  }
  for (const m of item.foodMeasures || []) {
    const g = num(m.gramWeight);
    const text = String(m.disseminationText || '').trim();
    if (!g || !text || /^quantity not specified$/i.test(text) || servings.length >= 5) continue;
    servings.push({ label: `${text} (${fmtG(g)} g)`, grams: g });
  }
  return {
    id: `usda:${item.fdcId}`,
    source: 'usda',
    barcode: item.gtinUpc ? String(item.gtinUpc) : null,
    name: titleCase(String(item.description || 'Unnamed food').trim()),
    brand: String(item.brandOwner || item.brandName || '').trim(),
    per100,
    servings,
    defaultGrams: servings[0]?.grams || 100
  };
}

/** Error a retry may cure: a network TypeError (offline, or a CORS-less 503 page) or HTTP 429/503. */
function retryableError(message) {
  const err = new Error(message);
  err.retryable = true;
  return err;
}

/** Delay before the one retry of an Open Food Facts text search (its 503s usually clear within a second or two). */
const OFF_RETRY_DELAY_MS = 1500;

/**
 * fetch JSON with a 12 s timeout (per attempt) and friendly errors. Returns null on HTTP 404.
 * With retries > 0, a network TypeError or HTTP 429/503 is retried after retryDelayMs; a timeout or any
 * other status is not.
 * @param {string} url
 * @param {string} what human name of the service, for messages
 * @param {{retries?: number, retryDelayMs?: number}} [opts]
 */
async function fetchJSON(url, what, { retries = 0, retryDelayMs = OFF_RETRY_DELAY_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJSONOnce(url, what);
    } catch (err) {
      if (attempt >= retries || !err.retryable) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(retryDelayMs) || 0)));
    }
  }
}

async function fetchJSONOnce(url, what) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`${what} took too long to respond. Try again.`);
    // A TypeError is either offline or a blocked response (Open Food Facts answers rate-limited
    // searches with a 503 page that carries no CORS headers, which the browser reports the same way).
    if (e instanceof TypeError) throw retryableError(`Could not reach ${what}. You may be offline, or it is busy right now. Wait a moment and try again.`);
    throw new Error(`Could not reach ${what}.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`${what} rejected the request (check your API key).`);
  if (res.status === 429 || res.status === 503) throw retryableError(`${what} is busy or rate-limiting (about 10 searches a minute). Wait a moment and try again.`);
  if (!res.ok) throw new Error(`${what} is having trouble (HTTP ${res.status}). Try again later.`);
  try {
    return await res.json();
  } catch {
    throw new Error(`Unexpected response from ${what}.`);
  }
}

/**
 * Effective USDA FoodData Central key: the user's own key from Settings (trimmed) when non-empty,
 * else the shared deployment key from config.js ('' when neither is set).
 * @param {object} [profile] defaults to state.profile
 * @returns {string}
 */
export function effectiveUsdaKey(profile = state.profile) {
  const own = String((profile && profile.usdaKey) || '').trim();
  return own || String(config.usdaApiKey || '').trim();
}

const stripZeros = (code) => String(code || '').replace(/\D/g, '').replace(/^0+/, '');

/** Open Food Facts product lookup over the barcode variants. Returns Food or null; throws on network errors. */
async function lookupOFF(candidates) {
  for (const c of candidates) {
    const data = await fetchJSON(`${OFF_BASE}/api/v2/product/${c}.json?fields=${OFF_FIELDS}`, 'Open Food Facts');
    if (data && data.product && (data.status === 1 || data.status === undefined || data.status === 'success')) {
      const food = foodFromOFF({ ...data.product, code: data.product.code || c });
      if (food) return food;
    }
  }
  return null;
}

/** USDA Branded lookup: accepts a result whose gtinUpc equals the code, ignoring leading zeros. Throws on errors. */
async function lookupUSDABarcode(clean, key) {
  const url = `${USDA_BASE}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(clean)}&dataType=Branded&pageSize=5`;
  const data = await fetchJSON(url, 'USDA FoodData Central');
  const want = stripZeros(clean);
  const hit = (data?.foods || []).find((it) => it && it.gtinUpc && stripZeros(it.gtinUpc) === want);
  return hit ? foodFromUSDA(hit) : null;
}

/**
 * Look up a barcode. Open Food Facts first: tries the code as-is, then without a leading 0 (EAN-13 → UPC-A),
 * then with a leading 0 (UPC-A → EAN-13). When Open Food Facts has nothing (or cannot be reached) and a
 * USDA key is given, falls back to USDA Branded foods matched on gtinUpc (leading zeros ignored).
 * An Open Food Facts error is rethrown only when the USDA fallback did not find the product.
 * @param {string} code
 * @param {{usdaKey?: string}} [opts] pass effectiveUsdaKey() to enable the USDA fallback
 * @returns {Promise<object|null>} Food or null when not found
 */
export async function lookupBarcode(code, { usdaKey = '' } = {}) {
  const clean = String(code || '').replace(/\D/g, '');
  if (!clean) throw new Error('Enter a valid barcode (digits only).');
  const candidates = [clean];
  if (clean.length === 13 && clean.startsWith('0')) candidates.push(clean.slice(1));
  if (clean.length === 12) candidates.push('0' + clean);
  let offErr = null;
  try {
    const food = await lookupOFF(candidates);
    if (food) return food;
  } catch (err) {
    offErr = err;
  }
  const key = String(usdaKey || '').trim();
  if (key) {
    try {
      const food = await lookupUSDABarcode(clean, key);
      if (food) return food;
    } catch {
      // Swallowed: Open Food Facts is the primary source; its error (if any) is reported below.
    }
  }
  if (offErr) throw offErr;
  return null;
}

/**
 * Search Open Food Facts and, when usdaKey is given, USDA FoodData Central in parallel, with details.
 * - Open Food Facts: with relayUrl (pass aiUrl(state)), the helper's search relay `GET {relayUrl}/v1/search` is
 *   tried first (6 s, no retry; its foods carry `_partial: true`, as the relay sends no serving sizes). On any
 *   failure of it, or without relayUrl, the legacy cgi search runs, retried once after retryDelayMs on a network
 *   error or HTTP 429/503. A relay that answers 401/404 (an older helper) is skipped for 10 minutes.
 * - onPartial(foods, { source }) is called when the first source answers while the other is still pending
 *   (only with a USDA key, and only when that source succeeded), so a caller can show it right away.
 * - A source's failure is swallowed as long as the search produced foods; `failed` lists it ('off' | 'usda').
 *   When nothing was found and a source failed, the Open Food Facts error is thrown if it failed (else USDA's).
 * - Second chance (spelling): when no food fully matches the query (fullyMatches), some query word of 5+
 *   letters matched no food at all, and USDA answered, ONE more USDA request replaces that word (the longest
 *   one) by its first 4 letters + '*'. Foods with a name/brand word within fuzzyLimit of it (same first letter)
 *   are kept; `corrected` is the most frequent such word (lowercase, apostrophes dropped, unstemmed: "Miss
 *   Vickie's" gives "vickies", whose stem matches how the food's own name tokenizes). Then ONE more Open Food
 *   Facts search runs with the corrected word; its failure is ignored. `correctedQuery` is the query with the
 *   word replaced and `fuzzy` maps the query token to the stems of the matching words (pass it to rankFoods).
 * - Live USDA results that duplicate a loaded built-in food (same `usda:<fdcId>` id) are dropped.
 * - Searches where every request answered are cached for the session (with their correction).
 * @param {string} query
 * @param {{usdaKey?:string, region?:string, onPartial?:Function, retryDelayMs?:number, relayUrl?:string}} [opts] usdaKey: pass effectiveUsdaKey()
 * @returns {Promise<{foods: object[], failed: string[], corrected: string|null, correctedQuery: string|null, fuzzy: object|null}>}
 */
export async function searchFoodsDetailed(query, { usdaKey = '', region = 'world', onPartial = null, retryDelayMs = OFF_RETRY_DELAY_MS, relayUrl = '' } = {}) {
  const asked = String(query || '').trim();
  if (asked.length < 2) return { foods: [], failed: [], corrected: null, correctedQuery: null, fuzzy: null };
  // A brand that is commonly typed the way it sounds is searched under its real spelling.
  const alias = brandAlias(asked);
  const q = alias ? alias.query : asked;
  const key = String(usdaKey || '').trim();
  const relay = relayBase(relayUrl);
  const cacheKey = `${region}|${key ? 'u' : '-'}|${relay ? 'r' : '-'}|${q.toLowerCase()}`;
  let builtinIds = null;
  const visible = (list) => {
    if (!builtinIds) builtinIds = new Set(builtinFoods().map((f) => f.id));
    return list.filter((f) => f.source !== 'usda' || !builtinIds.has(f.id));
  };
  let r = searchCache.get(cacheKey);
  if (!r) {
    const partial = typeof onPartial === 'function'
      ? (foods, info) => { try { onPartial(visible(foods), info); } catch { /* a caller's render error must not break the search */ } }
      : null;
    r = await searchFoodsUncached(q, { key, region, retryDelayMs, onPartial: partial, relayUrl: relay });
    if (r.complete) {
      if (searchCache.size >= 60) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(cacheKey, r);
    }
  }
  const out = { foods: visible(r.foods), failed: [...r.failed], corrected: r.corrected, correctedQuery: r.correctedQuery, fuzzy: r.fuzzy };
  if (alias) {
    out.corrected = out.corrected || alias.brand;
    out.correctedQuery = out.correctedQuery || alias.query;
    out.fuzzy = { ...alias.fuzzy, ...(out.fuzzy || {}) };
  }
  return out;
}

/** Brands people type the way they sound: [pattern in the query, the brand's real spelling]. */
const BRAND_ALIASES = [
  [/\brice\s+(?:crisp(?:y|ie|ies|ys)?|krisp(?:y|ys)?)\b/i, 'rice krispies'],
  [/\bchee[sz]e?\s*its?\b/i, 'cheez it'],
  [/\bfruit\s+loops?\b/i, 'froot loops'],
  [/\bcaptain\s+crunch\b/i, "cap'n crunch"]
];

/**
 * Rewrite a query that names a brand by sound ("rice crispies" → "rice krispies").
 * @param {string} query
 * @returns {{query: string, brand: string, fuzzy: object}|null} the rewritten query, the brand spelling, and a
 *   fuzzy map (original token → the brand's tokens) for rankFoods; null when no alias applies
 */
export function brandAlias(query) {
  const q = String(query || '').trim();
  for (const [re, brand] of BRAND_ALIASES) {
    if (!re.test(q)) continue;
    const rewritten = q.replace(re, brand);
    if (rewritten.toLowerCase() === q.toLowerCase()) return null;
    const before = tokenize(q);
    const after = tokenize(rewritten);
    const added = after.filter((t) => !before.includes(t));
    const fuzzy = {};
    for (const t of before) if (!after.includes(t) && added.length) fuzzy[t] = added;
    return { query: rewritten, brand, fuzzy };
  }
  return null;
}

/**
 * Search Open Food Facts and, when usdaKey is given, USDA FoodData Central (see searchFoodsDetailed).
 * @param {string} query
 * @param {{usdaKey?:string, region?:string, onPartial?:Function, retryDelayMs?:number}} [opts]
 * @returns {Promise<object[]>} Foods, de-duplicated by id
 */
export async function searchFoods(query, opts = {}) {
  return (await searchFoodsDetailed(query, opts)).foods;
}

/** Session cache of search results, keyed by region + key presence + relay presence + query, so retyping costs no request. */
const searchCache = new Map();

const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

/** Timeout of one search-relay request (no retries: the legacy search is the fallback). */
const RELAY_TIMEOUT_MS = 6000;
/** How long a relay that answered 401/404 (a helper without the search relay) is skipped. */
const RELAY_SKIP_MS = 10 * 60 * 1000;
/** Relay base → time until which it is skipped (session only). */
const relaySkipUntil = new Map();

/** Relay base without trailing slashes, or '' when none. */
const relayBase = (url) => String(url || '').trim().replace(/\/+$/, '');

/**
 * Text search through the helper's public search relay (`GET {relay}/v1/search?q=&region=`, no Authorization).
 * One attempt with a 6 s timeout. Throws on any failure (network, non-200, unreadable JSON); a 401/404 (an older
 * helper without the relay) also skips this relay for 10 minutes. Products carry no serving sizes, so each Food is
 * marked `_partial: true` (opening one fetches the full product by barcode).
 */
async function relaySearch(base, q, region) {
  const url = `${base}/v1/search?q=${encodeURIComponent(q)}&region=${encodeURIComponent(String(region || 'world'))}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 404) {
    relaySkipUntil.set(base, Date.now() + RELAY_SKIP_MS);
    throw new Error(`search relay unavailable (HTTP ${res.status})`);
  }
  if (res.status !== 200) throw new Error(`search relay HTTP ${res.status}`);
  const d = await res.json();
  if (!d || !Array.isArray(d.products)) throw new Error('search relay: unexpected reply');
  const out = [];
  for (const p of d.products) {
    if (!p || !(p.product_name || p.product_name_en)) continue;
    const f = foodFromOFF(p);
    if (!f) continue;
    if (p.partial !== false) f._partial = true;
    out.push(f);
  }
  return out;
}

/**
 * Open Food Facts text search. With a relay address (the AI helper's, see aiUrl) the helper's search relay is
 * asked first; on ANY failure of it, or without a relay, the legacy cgi search runs (retried once on a network
 * error or 429/503). Resolves to Foods.
 */
async function offSearch(q, region, retryDelayMs, relayUrl = '') {
  const base = relayBase(relayUrl);
  if (base && !((relaySkipUntil.get(base) || 0) > Date.now())) {
    try {
      return await relaySearch(base, q, region);
    } catch {
      // Fall through to the legacy search.
    }
  }
  const url = `${offSearchBase(region)}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&sort_by=unique_scans_n&fields=${OFF_FIELDS}`;
  const d = await fetchJSON(url, 'Open Food Facts', { retries: 1, retryDelayMs });
  return (d?.products || []).filter((p) => p && (p.product_name || p.product_name_en)).map(foodFromOFF).filter(Boolean);
}

/** USDA FoodData Central search (Foundation, SR Legacy, Branded). Resolves to Foods. */
function usdaSearch(q, key) {
  return fetchJSON(
    `${USDA_BASE}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=25&dataType=${encodeURIComponent('Foundation,SR Legacy,Branded')}`,
    'USDA FoodData Central'
  ).then((d) => (d?.foods || []).map(foodFromUSDA).filter(Boolean));
}

async function searchFoodsUncached(q, { key, region, retryDelayMs, onPartial, relayUrl }) {
  const offP = offSearch(q, region, retryDelayMs, relayUrl);
  const usdaP = key ? usdaSearch(q, key) : Promise.resolve([]);
  if (onPartial && key) {
    // Whichever source settles first: report it if it succeeded (the other is still pending).
    let first = true;
    const report = (source) => [
      (foods) => { if (first) { first = false; onPartial(foods, { source }); } },
      () => { first = false; }
    ];
    offP.then(...report('off'));
    usdaP.then(...report('usda'));
  }
  const [off, usda] = await Promise.allSettled([offP, usdaP]);
  const failed = [];
  if (off.status === 'rejected') failed.push('off');
  if (usda.status === 'rejected') failed.push('usda');
  const seen = new Map();
  const add = (list) => { for (const f of list) if (!seen.has(f.id)) seen.set(f.id, f); };
  add(off.status === 'fulfilled' ? off.value : []);
  add(usda.status === 'fulfilled' ? usda.value : []);
  let complete = !failed.length;
  let fix = null;
  if (key && usda.status === 'fulfilled') {
    fix = await secondChance(q, [...seen.values()], { key, region, retryDelayMs, relayUrl });
    if (fix) {
      add(fix.foods);
      if (!fix.complete) complete = false;
    }
  }
  if (failed.length && !seen.size) {
    const err = asError(off.status === 'rejected' ? off.reason : usda.reason);
    if (!key) err.message += ' Barcode scanning still works, and a free USDA key in Settings adds a second search source.';
    throw err;
  }
  const hasFix = !!(fix && fix.corrected);
  return {
    foods: [...seen.values()],
    complete,
    failed,
    corrected: hasFix ? fix.corrected : null,
    correctedQuery: hasFix ? fix.correctedQuery : null,
    fuzzy: hasFix ? fix.fuzzy : null
  };
}

/** Lowercase words of a text with apostrophes dropped, unstemmed (tokenize without the stemming). */
function plainWords(s) {
  if (s === null || s === undefined) return [];
  return String(s).toLowerCase().replace(/['’`]/g, '').match(TOKEN_RE) || [];
}

/**
 * The spelling second chance of searchFoodsUncached. Returns null when it does not apply (no request made),
 * else { foods, corrected, correctedQuery, fuzzy, complete } (corrected null when nothing close was found).
 */
async function secondChance(q, found, { key, region, retryDelayMs, relayUrl }) {
  const words = plainWords(q);
  const toks = words.map(stem);
  if (!toks.length || found.some((f) => fullyMatches(q, f))) return null;
  let idx = -1;
  toks.forEach((t, i) => {
    if (t.length < 5 || /\p{N}/u.test(t) || (idx >= 0 && toks[idx].length >= t.length)) return;
    if (!found.some((f) => { const ft = foodTokens(f); return tokenHits(t, ft.name, ft.brand, null); })) idx = i;
  });
  if (idx < 0) return null;
  const tok = toks[idx];
  const withWord = (w) => words.map((x, i) => (i === idx ? w : x)).join(' ');
  let usdaFoods;
  try {
    usdaFoods = await usdaSearch(withWord(`${tok.slice(0, 4)}*`), key);
  } catch {
    return { foods: [], corrected: null, correctedQuery: null, fuzzy: null, complete: false };
  }
  const limit = fuzzyLimit(tok.length);
  const counts = new Map(); // word → [number of kept foods containing it, distance]
  const stems = new Set();
  const kept = usdaFoods.filter((f) => {
    let ok = false;
    for (const w of new Set([...plainWords(f.name), ...plainWords(f.brand)])) {
      const s = stem(w);
      if (s[0] !== tok[0] || /\p{N}/u.test(s)) continue;
      const d = editDistance(tok, s, limit);
      if (d > limit) continue;
      ok = true;
      stems.add(s);
      const c = counts.get(w);
      if (c) c[0]++;
      else counts.set(w, [1, d]);
    }
    return ok;
  });
  if (!kept.length) return { foods: [], corrected: null, correctedQuery: null, fuzzy: null, complete: true };
  // Most frequent; ties → closer, then first seen.
  let corrected = null;
  let best = null;
  for (const [w, c] of counts) {
    if (!best || c[0] > best[0] || (c[0] === best[0] && c[1] < best[1])) { corrected = w; best = c; }
  }
  const correctedQuery = withWord(corrected);
  let complete = true;
  let offFoods = [];
  try {
    offFoods = await offSearch(correctedQuery, region, retryDelayMs, relayUrl);
  } catch {
    complete = false; // ignored, but then not cached, so the next search can fill it in
  }
  return { foods: [...kept, ...offFoods], corrected, correctedQuery, fuzzy: { [tok]: [...stems] }, complete };
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

/** A token: letters/digits, optionally continued by ".<digits>" (3.25) or "&<letters/digits>" (a&w, m&ms), optionally ending in % (2%, 93%). */
const TOKEN_RE = /[\p{L}\p{N}]+(?:\.\p{N}+|&[\p{L}\p{N}]+)*%?/gu;

/**
 * Tokenize for matching: lowercase, drop apostrophes ("Bob's" → "bobs"), then take runs of letters/digits
 * as tokens. A number keeps its decimal point and a trailing % ("3.25%", "2%"), and & joins letters as in
 * "a&w" / "m&ms"; all other punctuation (and a lone "&" or "%") separates. Light plural stemming is applied
 * to each token. Never throws (null → []).
 * @param {*} s
 * @returns {string[]}
 */
export function tokenize(s) {
  if (s === null || s === undefined) return [];
  return (String(s).toLowerCase().replace(/['’`]/g, '').match(TOKEN_RE) || []).map(stem);
}

/**
 * Query-word synonyms (stemmed form → stemmed alternatives) bridging everyday names and USDA naming.
 * Null prototype, so a query word like "constructor" or "toString" is not mistaken for an entry.
 */
const SYNONYMS = Object.assign(Object.create(null), {
  oatmeal: ['oat'], porridge: ['oat'], yoghurt: ['yogurt'], chickpea: ['garbanzo'], garbanzo: ['chickpea'],
  cilantro: ['coriander'], scallion: ['onion'], zucchini: ['squash'], courgette: ['squash', 'zucchini'],
  aubergine: ['eggplant'], prawn: ['shrimp'], mince: ['ground'], minced: ['ground'], soda: ['carbonated'],
  pop: ['carbonated'], hamburger: ['beef', 'ground'], steak: ['beef'], bacon: ['pork'], ham: ['pork'],
  turkey: ['turkey'], pb: ['peanut'], oj: ['orange'], rotissery: ['chicken', 'roasted'], crispy: ['krispy']
});

/** Stemmed synonyms of a query token (see SYNONYMS); [] when none. */
export function synonymsOf(tok) { return SYNONYMS[tok] || []; }

/* ------------------------------------------------------------------ */
/* Typo tolerance                                                      */
/* ------------------------------------------------------------------ */

/**
 * Damerau-Levenshtein distance (optimal string alignment: insert, delete, substitute, or swap two
 * adjacent letters, each costing 1). Stops early once every alignment costs more than `max`.
 * @param {string} a
 * @param {string} b
 * @param {number} [max] cap; default Infinity
 * @returns {number} the distance when ≤ max, else max + 1
 */
export function editDistance(a, b, max = Infinity) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  const cap = Number.isFinite(Number(max)) ? Math.max(0, Number(max)) : Infinity;
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  if (!m || !n) return Math.max(m, n) > cap ? cap + 1 : Math.max(m, n);
  let prev2 = null;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1);
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every later cell costs at least the smallest cell of this row (a swap reaches back two rows, but
    // that cell is never cheaper than the substitution path through this row), so stop here.
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n] > cap ? cap + 1 : prev[n];
}

/**
 * Typos forgiven in a (stemmed) query word of `len` letters: none up to 3 letters, 1 for 4–5, 2 for 6+.
 * @param {number} len
 * @returns {number}
 */
export function fuzzyLimit(len) {
  const n = Number(len) || 0;
  if (n <= 3) return 0;
  return n <= 5 ? 1 : 2;
}

/** Fuzzy alternatives of query token t0 in a fuzzy map ({ token: [alternative tokens] }), or null. */
function fuzzyAlts(fuzzy, t0) {
  if (!fuzzy || typeof fuzzy !== 'object' || !Object.prototype.hasOwnProperty.call(fuzzy, t0)) return null;
  const alts = fuzzy[t0];
  return Array.isArray(alts) && alts.length ? alts : null;
}

/** Light plural stemming so "bananas" and "banana" (or "eggs"/"egg", "oats"/"oat") compare equal. */
function stem(w) {
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  // "-ie" singulars share the stem of their plural: "krispie"/"krispies", "cookie"/"cookies", "brownie"/"brownies".
  if (w.length > 3 && w.endsWith('ie')) return `${w.slice(0, -2)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** One-entry memo for the query's tokens: a search scores every one of ~17k foods against the same query. */
let lastQuery = null;
let lastQueryTokens = [];
function queryTokens(query) {
  if (query !== lastQuery) {
    lastQuery = query;
    lastQueryTokens = tokenize(query);
  }
  return lastQueryTokens;
}

/**
 * One-entry memo of the strings a fuzzy-scored query can match at all: its tokens, their synonyms, their fuzzy
 * alternatives and the alternatives' synonyms. A food whose token text contains none of them scores 0, so the
 * typo pass over ~40k foods rejects most of them with a few substring tests.
 */
let lastNeedles = { query: null, fuzzy: null, list: [] };
function fuzzyNeedles(query, q, fuzzy) {
  if (lastNeedles.query !== query || lastNeedles.fuzzy !== fuzzy) {
    const set = new Set();
    for (const t0 of q) {
      const fz = fuzzyAlts(fuzzy, t0) || [];
      for (const t of [t0, ...fz]) {
        set.add(t);
        for (const syn of SYNONYMS[t] || []) set.add(syn);
      }
    }
    lastNeedles = { query, fuzzy, list: [...set] };
  }
  return lastNeedles.list;
}

/** Per-food token cache (keyed by object; food objects are not mutated while listed). */
const tokenCache = new WeakMap();

function foodTokens(food) {
  let t = tokenCache.get(food);
  if (!t) {
    const name = tokenize(food.name);
    const brand = tokenize(food.brand);
    // text: every match rule below is a substring test on a name or brand token, so a query word that is
    // not a substring of this string cannot match at all (fast reject for the ~17k foods scored per search).
    t = { name, brand, text: ` ${name.join(' ')} ${brand.join(' ')} ` };
    tokenCache.set(food, t);
  }
  return t;
}

/**
 * Score how well a food matches a query. 0 means no match; any positive number is a match (higher is better).
 *
 * With name = tokenize(food.name), brand = tokenize(food.brand), q = tokenize(query):
 * - Empty q → 0.
 * - Coverage, per query token: +3 when some name token starts with it (prefix); else +1.5 when a brand
 *   token starts with it; else +0.5 when it appears inside a name token (substring); else it is a miss.
 *   When no query token matches at all the food is not a match (0).
 * - Phrase: +4 when food.name lowercased contains the whole trimmed lowercased query; +3 more when the
 *   name starts with it.
 * - Head word: +1 when the first name token starts with the first query token, or equals any query token.
 * - Completeness: −3 when per100 cal, p, c and f are all 0; −1 when cal is 0 (an all-zero food gets both).
 * - Length: −0.05 per name token beyond 6, so long USDA descriptions rank below short names at equal match.
 * - Popularity: +0.8 × log10(1 + food.pop) (Open Food Facts scan count); +1.5 for built-in and
 *   food-pack foods (curated); +3 for library foods (id in localIds), +2 more for favorites, +1 more for recents.
 *   (Current values: +2 curated for built-in and restaurant-pack foods, which skip the −0.5 per unmatched name word
 *   that live results pay; product-pack foods (`food.product`) get +2 with that cost capped at 1.5.)
 * - Partial match (some query tokens missed): the total is multiplied by 0.25, so a typo in one word
 *   still surfaces the food, well below full matches.
 * - Fuzzy (only with opts.fuzzy, a map query token → alternative tokens, see fuzzyMap): a query token with
 *   alternatives is swapped for the first one the food contains (a whole name token, else a whole brand token) and
 *   the food is scored as if the query were spelt that way, minus 0.75 per swapped word.
 *   Without a fuzzy map, scores are exactly as described above.
 * A matched food whose penalties take the total to ≤ 0 scores 0.01, so 0 always means "no match".
 * @param {string} query
 * @param {object} food
 * @param {{localIds?: Set<string>, favoriteIds?: Set<string>, recentIds?: Set<string>, fuzzy?: object|null}} [opts]
 * @returns {number}
 */
export function scoreFood(query, food, { localIds = new Set(), favoriteIds = new Set(), recentIds = new Set(), fuzzy = null } = {}) {
  let q = queryTokens(query);
  if (!q.length || !food || typeof food !== 'object') return 0;
  const { name, brand, text } = foodTokens(food);
  // Typo alternatives: a misspelt query word is swapped for the alternative this food actually contains (a whole
  // name word first, else a brand word), and the food is then scored as if the query had been spelt that way,
  // minus a small cost per corrected word. So "chiken brest" ranks foods in the same order as "chicken breast".
  let corrected = 0;
  if (fuzzy) {
    // Fast reject (same result as the check below, before the per-word swaps).
    const needles = fuzzyNeedles(query, q, fuzzy);
    let any = false;
    for (let i = 0; i < needles.length; i++) if (text.includes(needles[i])) { any = true; break; }
    if (!any) return 0;
    q = q.map((t0) => {
      const fz = fuzzyAlts(fuzzy, t0);
      if (!fz) return t0;
      const alt = fz.find((t) => name.includes(t)) || fz.find((t) => brand.includes(t));
      if (!alt) return t0;
      corrected++;
      return alt;
    });
  }
  if (!q.some((t0) => text.includes(t0) || (SYNONYMS[t0] || []).some((t) => text.includes(t)))) return 0;
  let score = 0;
  let matched = 0;
  let early = true; // every query word found within the first q.length + 1 name words
  const window = name.slice(0, q.length + 1);
  for (const t0 of q) {
    // A query word also matches its synonyms ("oatmeal" finds USDA's "Cereals, oats, …").
    const alts = [t0, ...(SYNONYMS[t0] || [])];
    const hit = (test) => alts.some(test);
    if (hit((t) => name.includes(t))) score += 3.5; // whole word ("egg" in "Egg, whole") beats a prefix ("egg" in "Eggnog")
    else if (hit((t) => name.some((w) => w.startsWith(t)))) score += 3;
    else if (hit((t) => brand.some((w) => w.startsWith(t)))) score += 1.5;
    else if (hit((t) => name.some((w) => w.includes(t)))) score += 0.5;
    else continue;
    matched++;
    if (!hit((t) => window.some((w) => w === t || w.startsWith(t)))) early = false;
  }
  if (!matched) return 0;
  // Whole-word phrase match on token-joined names, so USDA's comma style ("Chicken, breast, skinless")
  // counts as "chicken breast". Worth more at the start of the name than buried in it
  // ("Oil, olive" should not lose to "Mayonnaise, with olive oil").
  const joined = ` ${name.join(' ')} `;
  const phrase = ` ${q.join(' ')} `;
  if (joined.startsWith(phrase)) score += 5.5;
  else if (joined.includes(phrase)) score += 2;
  if (early && matched === q.length) score += 2;
  // Head word: USDA names lead with the food ("Milk, …", "Cheese, …"), so a query naming it wins over one that merely contains it.
  if (name.length && (name[0].startsWith(q[0]) || q.includes(name[0]))) score += 1;
  const n = food.per100 || {};
  const cal = Number(n.cal) || 0;
  if (!cal && !(Number(n.p) || 0) && !(Number(n.c) || 0) && !(Number(n.f) || 0)) score -= 3;
  if (!cal) score -= 1;
  // Shorter names win ties: each name word beyond the query's length costs a little.
  if (name.length > q.length) score -= 0.15 * (name.length - q.length);
  // Live results: each name word the query did not touch costs a little ("chicken breast sandwich"
  // ranks under "chicken breast"). Built-in USDA names carry structured descriptors, so they are exempt
  // and get a flat curated bonus instead (restaurant pack menus too).
  // Packaged products from a `kind: 'products'` pack (food.product) are real branded items whose names carry
  // flavour / size / line words the query rarely repeats: they get the curated bonus too, and the per-word cost is
  // capped at 1.5 so a long product name is not buried, while "chicken breast" still beats "chicken breast bites".
  if (food.source === 'builtin' || (food.source === 'pack' && !food.product)) {
    score += 2;
  } else {
    const unmatched = name.filter((w) => !q.some((t) => w.startsWith(t) || w.includes(t))).length;
    if (food.source === 'pack') score += 2 - Math.min(1.5, 0.5 * unmatched);
    else score -= 0.5 * unmatched;
  }
  const pop = Number(food.pop);
  if (pop > 0) score += Math.log10(1 + pop) * 0.6;
  // A search that is just a brand ("siggis", "fairlife"): products OF that brand are what is wanted, whatever
  // they are called ("Vanilla" by siggi's), ahead of entries that merely have the brand as their name.
  if (brand.length && q.every((t) => brand.includes(t))) score += 6;
  // Relay results are unreviewed database rows without a serving: a sparse one (no brand) ranks lower still.
  if (food._partial) score -= brand.length ? 1.5 : 3;
  if (localIds.has(food.id)) score += 3;
  if (favoriteIds.has(food.id)) score += 2;
  if (recentIds.has(food.id)) score += 1;
  score -= 0.75 * corrected;
  if (matched < q.length) score *= 0.25;
  return score > 0 ? score : 0.01;
}

/** De-duplication key: the barcode (digits, leading zeros ignored) when present, else "name tokens|brand tokens". */
function dedupKey(food) {
  const bc = stripZeros(food.barcode);
  if (bc) return `#${bc}`;
  const { name, brand } = foodTokens(food);
  return `${name.join(' ')}|${brand.join(' ')}`;
}

/**
 * Which copy of one product (same barcode) to keep: the library's, then a pack's or the built-in list's, then a
 * full live result, then a `_partial` live result (search relay, no servings yet).
 */
function copyRank(food, localIds) {
  if (food._partial) return 0; // never the library's copy (saveFood strips the flag), even when it shares its id
  if (localIds.has(food.id)) return 3;
  return food.source === 'pack' || food.source === 'builtin' ? 2 : 1;
}

/**
 * Rank and de-duplicate a mixed list of foods (library, built-in, USDA, Open Food Facts) for a query.
 * Sorted by scoreFood, best first (ties keep input order). Foods sharing an id or a de-duplication key
 * (barcode, else normalized name + brand) keep only the higher-scored one, except that among copies of one
 * barcode the library copy, then a pack copy, then a full live copy wins over a `_partial` one (it takes the
 * best-scored copy's place). Foods scoring 0 are kept, sorted last, because live sources also match on fields
 * we do not see. Never throws on odd input.
 * @param {string} query
 * @param {object[]} foods
 * @param {{limit?: number, localIds?: Set<string>, favoriteIds?: Set<string>, recentIds?: Set<string>, fuzzy?: object|null}} [opts]
 *   fuzzy: typo alternatives passed through to scoreFood (fuzzyMap, or searchFoodsDetailed's `fuzzy`)
 * @returns {object[]} Foods, at most `limit`
 */
export function rankFoods(query, foods, { limit = 40, localIds, favoriteIds, recentIds, fuzzy = null, plainFirst = false } = {}) {
  const opts = { localIds: localIds || new Set(), favoriteIds: favoriteIds || new Set(), recentIds: recentIds || new Set(), fuzzy };
  const scored = (Array.isArray(foods) ? foods : [])
    .filter((f) => f && typeof f === 'object' && f.id)
    .map((food, i) => ({ food, i, score: scoreFood(query, food, opts) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  // Preferred copy per barcode (see copyRank); ties keep the better score.
  const keys = scored.map(({ food }) => dedupKey(food));
  const best = new Map();
  scored.forEach(({ food }, i) => {
    const key = keys[i];
    if (key[0] !== '#') return;
    const cur = best.get(key);
    if (!cur || copyRank(food, opts.localIds) > copyRank(cur, opts.localIds)) best.set(key, food);
  });
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];
  for (let i = 0; i < scored.length; i++) {
    const key = keys[i];
    const food = best.get(key) || scored[i].food;
    if (seenIds.has(scored[i].food.id) || seenIds.has(food.id) || seenKeys.has(key)) continue;
    seenIds.add(scored[i].food.id);
    seenIds.add(food.id);
    seenKeys.add(key);
    out.push(food);
    if (!plainFirst && out.length >= limit) break;
  }
  return plainFirst ? plainFoodsFirst(query, out, opts).slice(0, limit) : out;
}

const STAPLE_PLUS = new Set(['raw', 'whole', 'fresh', 'cooked', 'plain', 'fluid', 'regular', 'large', 'boiled', 'roasted']);
const STAPLE_MINUS = new Set([
  'dried', 'dry', 'powder', 'substitute', 'flour', 'dehydrated', 'babyfood', 'frozen', 'mix', 'glutinous', 'bran',
  'noodle', 'imitation', 'human', 'goat', 'sheep', 'buffalo', 'duck', 'goose', 'quail', 'buttermilk', 'filled',
  'sodium', 'stabilized', 'parboiled', 'instant', 'precooked', 'canned', 'shake', 'flake', 'breaded', 'roll',
  'tender', 'overripe', 'restaurant', 'reduced', 'unenriched'
]);

/** How everyday a built-in food's form is, from its name words (words the query itself names are neutral). */
function stapleScore(name, queryWords) {
  let plus = 0;
  let minus = 0;
  for (const w of name) {
    if (queryWords.has(w)) continue;
    if (STAPLE_PLUS.has(w)) plus++;
    else if (STAPLE_MINUS.has(w)) minus++;
  }
  return Math.min(plus, 2) * 2 - minus * 3 - name.length * 0.2;
}

/**
 * Generic searches ("egg", "white rice", "milk") should lead with the plain food, not with a dozen store brands
 * and restaurant items of the same name. After the user's own foods at the top, up to three built-in (USDA
 * generic) foods that match every query word AND are named for the food (their first name word is a query word, whole:
 * "Rice, white, …", "Egg, whole, …") are moved up and alternated with the best other results. A built-in food
 * that merely mentions the words ("Candies, …, with rice cereal") is left where it ranked.
 */
function plainFoodsFirst(query, ranked, opts) {
  const q = tokenize(query);
  if (!q.length) return ranked;
  let lead = 0;
  while (lead < ranked.length && opts.localIds.has(ranked[lead].id)) lead++;
  const rest = ranked.slice(lead);
  const heads = new Set(q);
  for (const t of q) {
    for (const s of SYNONYMS[t] || []) heads.add(s);
    for (const a of (opts.fuzzy && fuzzyAlts(opts.fuzzy, t)) || []) heads.add(a);
  }
  const cands = [];
  for (const f of rest) {
    if (f.source !== 'builtin') continue;
    const name = foodTokens(f).name;
    if (!name.length || !heads.has(name[0])) continue;
    if (!fullyMatches(query, f, { fuzzy: opts.fuzzy })) continue;
    cands.push({ f, i: cands.length, staple: scoreFood(query, f, opts) + stapleScore(name, heads) });
    if (cands.length >= 60) break;
  }
  if (!cands.length) return ranked;
  // Among them prefer the everyday form ("Egg, whole, raw, fresh") over the specialised ("Egg, white, dried").
  const plain = cands.sort((x, y) => y.staple - x.staple || x.i - y.i).slice(0, 3).map((c) => c.f);
  const picked = new Set(plain);
  const others = rest.filter((f) => !picked.has(f));
  const merged = [];
  for (let i = 0; i < plain.length; i++) {
    merged.push(plain[i]);
    if (i < others.length) merged.push(others[i]);
  }
  return [...ranked.slice(0, lead), ...merged, ...others.slice(plain.length)];
}

/**
 * Search the user's library and the built-in list synchronously (no network). Only matching foods
 * (score > 0) are returned, ranked by rankFoods with the library / favorite / recent boosts.
 * Typos: when no result matches every query word, words that match no food at all get fuzzyMap
 * alternatives and the list is scored again with them (exact matches still rank as before).
 * Never throws on odd input (empty or punctuation-only query → []).
 * @param {string} query
 * @param {{library?: object|object[], builtin?: object[], recents?: string[], favorites?: string[], limit?: number}} sources
 *   library: state.foods (id → Food map) or an array of Foods; recents/favorites: food ids
 * @returns {object[]} Foods
 */
export function searchLocal(query, { library = {}, builtin = [], recents = [], favorites = [], limit = 40, plainFirst = false } = {}) {
  if (!tokenize(query).length) return [];
  const lib = (Array.isArray(library) ? library : Object.values(library || {}))
    .filter((f) => f && typeof f === 'object' && f.id);
  const opts = {
    localIds: new Set(lib.map((f) => f.id)),
    favoriteIds: new Set(Array.isArray(favorites) ? favorites : []),
    recentIds: new Set(Array.isArray(recents) ? recents : [])
  };
  const pool = [...lib, ...(Array.isArray(builtin) ? builtin : [])]
    .filter((f) => f && typeof f === 'object' && f.id);
  const exact = pool.filter((f) => scoreFood(query, f, opts) > 0);
  const ranked = rankFoods(query, exact, { ...opts, limit, plainFirst });
  // Typo fallback: only when no result matches every query word, and only for words that match nothing.
  if (ranked.some((f) => fullyMatches(query, f))) return ranked;
  const fuzzy = fuzzyMap(query, { library: lib, builtin });
  if (!fuzzy) return ranked;
  const fopts = { ...opts, fuzzy };
  return rankFoods(query, pool.filter((f) => scoreFood(query, f, fopts) > 0), { ...fopts, limit, plainFirst });
}

/** Whether query token t0 matches a food's name/brand tokens by scoreFood's rules (synonyms and fuzzy alternatives included). */
function tokenHits(t0, name, brand, fuzzy) {
  const alts = [t0, ...(SYNONYMS[t0] || [])];
  if (alts.some((t) => name.some((w) => w.includes(t)) || brand.some((w) => w.startsWith(t)))) return true;
  const fz = fuzzy && fuzzyAlts(fuzzy, t0);
  return !!fz && fz.some((t) => name.includes(t) || brand.includes(t));
}

/**
 * Whether every query word matches the food under scoreFood's rules (whole word, prefix, brand prefix,
 * substring of a name word, synonyms, and opts.fuzzy alternatives when given), i.e. scoreFood would not
 * apply its partial-match factor.
 * @param {string} query
 * @param {object} food
 * @param {{fuzzy?: object|null}} [opts]
 * @returns {boolean}
 */
export function fullyMatches(query, food, { fuzzy = null } = {}) {
  const q = queryTokens(query);
  if (!q.length || !food || typeof food !== 'object') return false;
  const { name, brand } = foodTokens(food);
  return q.every((t0) => tokenHits(t0, name, brand, fuzzy));
}

/**
 * Vocabulary of a food list: distinct name and brand tokens, and token → number of foods, bucketed by first
 * letter (tokens with digits left out). Cached per array object: callers pass the same array until the list
 * changes (food.js memoizes built-in + pack foods), so a new list means a new array and a fresh vocabulary.
 */
const vocabCache = new WeakMap();
function vocabOf(foods, cache = true) {
  let v = cache ? vocabCache.get(foods) : null;
  if (v) return v;
  // token → { n: foods containing it, last: index of the last food counted, name/brand: where it occurs }
  const counts = new Map();
  let i = 0;
  for (const f of foods) {
    i++;
    if (!f || typeof f !== 'object' || !f.id) continue;
    const t = foodTokens(f);
    for (let k = 0; k < 2; k++) {
      const list = k ? t.brand : t.name;
      for (let j = 0; j < list.length; j++) {
        const w = list[j];
        let c = counts.get(w);
        if (!c) counts.set(w, (c = { n: 0, last: 0, name: false, brand: false }));
        if (c.last !== i) { c.n++; c.last = i; }
        if (k) c.brand = true;
        else c.name = true;
      }
    }
  }
  const names = new Set();
  const brandList = [];
  const byFirst = new Map();
  for (const [w, c] of counts) {
    if (c.name) names.add(w);
    if (c.brand) brandList.push(w);
    if (/\p{N}/u.test(w)) continue;
    let bucket = byFirst.get(w[0]);
    if (!bucket) byFirst.set(w[0], (bucket = []));
    bucket.push([w, c.n]);
  }
  v = { names, nameList: [...names], brandList, byFirst };
  if (cache) vocabCache.set(foods, v);
  return v;
}

/**
 * Build and cache the typo vocabulary of a food list ahead of time (same per-array cache as fuzzyMap and
 * searchLocal), so the first misspelt search does not pay for it. The add-food sheet calls this when the browser is
 * idle after the first local results, when every food's tokens are already cached (then it costs ~35–60 ms for
 * ~40k foods on a desktop). No-op when the list's vocabulary is already cached.
 * @param {object[]} foods the same array later passed as `builtin`
 * @returns {boolean} true when it was built now
 */
export function warmSearchVocabulary(foods) {
  if (!Array.isArray(foods) || !foods.length || vocabCache.has(foods)) return false;
  vocabOf(foods);
  return true;
}

/** Whether token t (or a synonym) matches any food of a vocabulary by scoreFood's rules. */
function vocabHits(v, t0) {
  return [t0, ...(SYNONYMS[t0] || [])].some((t) =>
    v.names.has(t) || v.nameList.some((w) => w.includes(t)) || v.brandList.some((w) => w.startsWith(t)));
}

/**
 * Typo alternatives for a local search: for each query word (4+ letters, no digits) that matches no food
 * in library + builtin at all, the closest name/brand tokens of those foods within fuzzyLimit (same first
 * letter), closest first, then most common; at most 5 per word. Pass the result to scoreFood/rankFoods as
 * opts.fuzzy. The built-in vocabulary is cached per `builtin` array (pass the same array while unchanged);
 * the library's is rebuilt per call (it is small).
 * @param {string} query
 * @param {{library?: object|object[], builtin?: object[]}} sources as for searchLocal
 * @returns {object|null} { queryToken: [alternative tokens] }, or null when no word needs (or has) one
 */
export function fuzzyMap(query, { library = {}, builtin = [] } = {}) {
  const q = tokenize(query).filter((t) => fuzzyLimit(t.length) > 0 && !/\p{N}/u.test(t));
  if (!q.length) return null;
  const lib = (Array.isArray(library) ? library : Object.values(library || {}))
    .filter((f) => f && typeof f === 'object' && f.id);
  const vocabs = [vocabOf(lib, false)];
  if (Array.isArray(builtin) && builtin.length) vocabs.push(vocabOf(builtin));
  let out = null;
  for (const t0 of new Set(q)) {
    if (vocabs.some((v) => vocabHits(v, t0))) continue;
    const limit = fuzzyLimit(t0.length);
    const found = new Map(); // token → [distance, count]
    for (const v of vocabs) {
      for (const [w, n] of v.byFirst.get(t0[0]) || []) {
        if (Math.abs(w.length - t0.length) > limit) continue;
        const d = editDistance(t0, w, limit);
        if (d > limit) continue;
        const prev = found.get(w);
        if (prev) prev[1] += n;
        else found.set(w, [d, n]);
      }
    }
    if (!found.size) continue;
    const alts = [...found].sort((a, b) => a[1][0] - b[1][0] || b[1][1] - a[1][1]).slice(0, 5).map(([w]) => w);
    (out || (out = {}))[t0] = alts;
  }
  return out;
}

/**
 * Scale per-100 g nutrients to an amount in grams (unrounded).
 * @param {object} food
 * @param {number} grams
 * @returns {{cal:number, p:number, c:number, f:number, fiber:number}}
 */
export function nutrientsFor(food, grams) {
  const k = (Number(grams) || 0) / 100;
  const n = food?.per100 || {};
  return {
    cal: (Number(n.cal) || 0) * k,
    p: (Number(n.p) || 0) * k,
    c: (Number(n.c) || 0) * k,
    f: (Number(n.f) || 0) * k,
    fiber: (Number(n.fiber) || 0) * k
  };
}

/**
 * All unit options for a food: its servings, then g and oz. A servingOnly food offers only its servings.
 * @param {object} food
 * @returns {{label:string, grams:number}[]}
 */
export function unitOptions(food) {
  const servings = (food?.servings || []).map((s) => ({ label: s.label, grams: s.grams }));
  if (food?.servingOnly) return servings;
  return [...servings, { ...UNIT_G }, { ...UNIT_OZ }];
}

/**
 * Build an Entry (without id/meal) from a food, quantity and unit. Nutrient snapshot rounded to 2 decimals.
 * Carries `servingOnly: true` when the food has it (so the diary never shows its nominal grams).
 * @param {object} food
 * @param {number} qty
 * @param {{label:string, grams:number}} unit
 * @returns {object}
 */
export function buildEntry(food, qty, unit) {
  const q = Number(qty) || 0;
  const grams = q * (Number(unit?.grams) || 0);
  const n = nutrientsFor(food, grams);
  const entry = {
    foodId: food.id,
    name: food.name,
    brand: food.brand || '',
    qty: q,
    unit: { label: unit.label, grams: Number(unit.grams) },
    grams: r2(grams),
    cal: r2(n.cal),
    p: r2(n.p),
    c: r2(n.c),
    f: r2(n.f),
    fiber: r2(n.fiber)
  };
  if (food.servingOnly) entry.servingOnly = true;
  return entry;
}

/**
 * Make a custom Food. per === 'serving' means the numbers are for `servingGrams` grams;
 * per === '100g' means they are per 100 g. Pass an existing id to keep it when editing.
 * per === 'serving' with no serving grams (null / undefined / blank) makes a `servingOnly` food: the
 * numbers are for one serving of unknown weight (label from servingLabel, else "1 serving").
 * origin: the source a food was edited from, so an edited scanned/built-in food is shown as 'Edited' and still
 * carries its original id and barcode ('off', 'usda', 'builtin', 'pack'; a non-empty string sets `origin`, else
 * the food has no `origin` key).
 * @param {object} o
 * @returns {object} Food
 * @throws {Error} when per === 'serving' and servingGrams is given but not a positive number
 */
export function makeCustomFood({ id = null, name, brand = '', barcode = null, per, servingGrams, servingLabel: sLabel = '1 serving', cal, p, c, f, fiber = 0, origin = null }) {
  const blank = servingGrams === null || servingGrams === undefined || String(servingGrams).trim() === '';
  const servingOnly = per === 'serving' && blank;
  const sg = blank ? null : num(servingGrams);
  if (per === 'serving' && !servingOnly && !(sg > 0)) throw new Error('Enter the serving size in grams.');
  const k = per === 'serving' && !servingOnly ? 100 / sg : 1;
  const v = (x) => r2((num(x) ?? 0) * k);
  const base = String(sLabel || '1 serving').replace(/\s*\(\s*[\d.,]+\s*g\s*\)\s*$/i, '').trim() || '1 serving';
  const servings = [];
  if (servingOnly) servings.push({ label: base, grams: 100 });
  else if (sg > 0) servings.push({ label: `${base} (${fmtG(sg)} g)`, grams: sg });
  const bc = barcode === null || barcode === undefined ? '' : String(barcode).trim();
  const food = {
    id: id || `custom:${uid()}`,
    source: 'custom',
    barcode: bc || null,
    name: String(name || '').trim() || 'Custom food',
    brand: String(brand || '').trim(),
    per100: { cal: v(cal), p: v(p), c: v(c), f: v(f), fiber: v(fiber) },
    servings,
    defaultGrams: !servingOnly && sg > 0 ? sg : 100
  };
  if (servingOnly) food.servingOnly = true;
  if (typeof origin === 'string' && origin) food.origin = origin;
  return food;
}

/**
 * Why a food's nutrition looks wrong, or null. Per 100 g (per serving for servingOnly foods):
 * kcal more than max(25 %, 20 kcal) away from 4p + 4c + 9f; macros over 105 g per 100 g; over 920 kcal per 100 g
 * (pure fat is 884–900); every value zero. The gram checks are skipped for servingOnly foods (unknown weight).
 * @param {object} food
 * @returns {string|null} short reason for the user, e.g. "calories don't match the macros (540 listed, about 320 from the macros)"
 */
export function nutritionLooksOff(food) {
  const per = (food && food.per100) || {};
  const cal = Number(per.cal) || 0;
  const p = Number(per.p) || 0;
  const c = Number(per.c) || 0;
  const f = Number(per.f) || 0;
  const servingOnly = !!(food && food.servingOnly);
  if (!cal && !p && !c && !f) return 'no nutrition values';
  if (!servingOnly && p + c + f > 105) return 'more than 100 g of protein, carbs and fat per 100 g';
  if (!servingOnly && cal > 920) return 'over 900 kcal per 100 g';
  const est = 4 * p + 4 * c + 9 * f;
  if (cal > 0 && est > 0 && Math.abs(cal - est) > Math.max(0.25 * Math.max(cal, est), 20)) {
    return `calories don't match the macros (${Math.round(cal)} listed, about ${Math.round(est)} from the macros)`;
  }
  return null;
}
