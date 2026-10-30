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

/**
 * fetch JSON with a 12 s timeout and friendly errors. Returns null on HTTP 404.
 * @param {string} url
 * @param {string} what human name of the service, for messages
 */
async function fetchJSON(url, what) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`${what} took too long to respond. Try again.`);
    // A TypeError is either offline or a blocked response (Open Food Facts answers rate-limited
    // searches with a 503 page that carries no CORS headers, which the browser reports the same way).
    if (e instanceof TypeError) throw new Error(`Could not reach ${what}. You may be offline, or it is busy right now. Wait a moment and try again.`);
    throw new Error(`Could not reach ${what}.`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error(`${what} rejected the request (check your API key).`);
  if (res.status === 429 || res.status === 503) throw new Error(`${what} is busy or rate-limiting (about 10 searches a minute). Wait a moment and try again.`);
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
 * Search Open Food Facts and, when usdaKey is given, USDA FoodData Central in parallel.
 * A source's failure is swallowed as long as the other produced results. When a source failed and
 * nothing was found, the Open Food Facts error is thrown if it failed (else the USDA one).
 * Live USDA results that duplicate a loaded built-in food (same `usda:<fdcId>` id) are dropped.
 * Open Food Facts results come from the region's site, sorted there by scan popularity; callers re-rank
 * with rankFoods. Searches where every source answered are cached for the session.
 * @param {string} query
 * @param {{usdaKey?:string, region?:string}} [opts] usdaKey: pass effectiveUsdaKey()
 * @returns {Promise<object[]>} Foods, de-duplicated by id
 */
export async function searchFoods(query, { usdaKey = '', region = 'world' } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const key = String(usdaKey || '').trim();
  const cacheKey = `${region}|${key ? 'u' : '-'}|${q.toLowerCase()}`;
  let results = searchCache.get(cacheKey);
  if (!results) {
    const r = await searchFoodsUncached(q, { key, region });
    results = r.foods;
    if (r.complete) {
      if (searchCache.size >= 60) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(cacheKey, results);
    }
  }
  const builtinIds = new Set(builtinFoods().map((f) => f.id));
  return results.filter((f) => f.source !== 'usda' || !builtinIds.has(f.id));
}

/** Session cache of search results, keyed by region + key presence + query, so retyping costs no request. */
const searchCache = new Map();

const asError = (e) => (e instanceof Error ? e : new Error(String(e)));

async function searchFoodsUncached(q, { key, region }) {
  const offUrl = `${offSearchBase(region)}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&sort_by=unique_scans_n&fields=${OFF_FIELDS}`;
  const offP = fetchJSON(offUrl, 'Open Food Facts').then((d) =>
    (d?.products || []).filter((p) => p && (p.product_name || p.product_name_en)).map(foodFromOFF).filter(Boolean)
  );
  const usdaP = key
    ? fetchJSON(
      `${USDA_BASE}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=25&dataType=${encodeURIComponent('Foundation,SR Legacy,Branded')}`,
      'USDA FoodData Central'
    ).then((d) => (d?.foods || []).map(foodFromUSDA).filter(Boolean))
    : Promise.resolve([]);
  const [off, usda] = await Promise.allSettled([offP, usdaP]);
  const offFoods = off.status === 'fulfilled' ? off.value : [];
  const usdaFoods = usda.status === 'fulfilled' ? usda.value : [];
  const failed = off.status === 'rejected' || usda.status === 'rejected';
  if (failed && !offFoods.length && !usdaFoods.length) {
    const err = asError(off.status === 'rejected' ? off.reason : usda.reason);
    if (!key) err.message += ' Barcode scanning still works, and a free USDA key in Settings adds a second search source.';
    throw err;
  }
  const seen = new Map();
  for (const f of [...offFoods, ...usdaFoods]) if (!seen.has(f.id)) seen.set(f.id, f);
  return { foods: [...seen.values()], complete: !failed };
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

/** Light plural stemming so "bananas" and "banana" (or "eggs"/"egg", "oats"/"oat") compare equal. */
/** Query-word synonyms (stemmed form → stemmed alternatives) bridging everyday names and USDA naming. */
const SYNONYMS = {
  oatmeal: ['oat'], porridge: ['oat'], yoghurt: ['yogurt'], chickpea: ['garbanzo'], garbanzo: ['chickpea'],
  cilantro: ['coriander'], scallion: ['onion'], zucchini: ['squash'], courgette: ['squash', 'zucchini'],
  aubergine: ['eggplant'], prawn: ['shrimp'], mince: ['ground'], minced: ['ground'], soda: ['carbonated'],
  pop: ['carbonated'], hamburger: ['beef', 'ground'], steak: ['beef'], bacon: ['pork'], ham: ['pork'],
  turkey: ['turkey'], pb: ['peanut'], oj: ['orange'], rotisserie: ['chicken', 'roasted']
};

/** Stemmed synonyms of a query token (see SYNONYMS); [] when none. */
export function synonymsOf(tok) { return SYNONYMS[tok] || []; }

function stem(w) {
  if (w.length > 3 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
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
 * - Partial match (some query tokens missed): the total is multiplied by 0.25, so a typo in one word
 *   still surfaces the food, well below full matches.
 * A matched food whose penalties take the total to ≤ 0 scores 0.01, so 0 always means "no match".
 * @param {string} query
 * @param {object} food
 * @param {{localIds?: Set<string>, favoriteIds?: Set<string>, recentIds?: Set<string>}} [opts]
 * @returns {number}
 */
export function scoreFood(query, food, { localIds = new Set(), favoriteIds = new Set(), recentIds = new Set() } = {}) {
  const q = queryTokens(query);
  if (!q.length || !food || typeof food !== 'object') return 0;
  const { name, brand, text } = foodTokens(food);
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
  if (food.source === 'builtin' || food.source === 'pack') {
    score += 2;
  } else {
    const unmatched = name.filter((w) => !q.some((t) => w.startsWith(t) || w.includes(t))).length;
    score -= 0.5 * unmatched;
  }
  const pop = Number(food.pop);
  if (pop > 0) score += Math.log10(1 + pop) * 0.6;
  if (localIds.has(food.id)) score += 3;
  if (favoriteIds.has(food.id)) score += 2;
  if (recentIds.has(food.id)) score += 1;
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
 * Rank and de-duplicate a mixed list of foods (library, built-in, USDA, Open Food Facts) for a query.
 * Sorted by scoreFood, best first (ties keep input order). Foods sharing an id or a de-duplication key
 * (barcode, else normalized name + brand) keep only the higher-scored one. Foods scoring 0 are kept,
 * sorted last, because live sources also match on fields we do not see. Never throws on odd input.
 * @param {string} query
 * @param {object[]} foods
 * @param {{limit?: number, localIds?: Set<string>, favoriteIds?: Set<string>, recentIds?: Set<string>}} [opts]
 * @returns {object[]} Foods, at most `limit`
 */
export function rankFoods(query, foods, { limit = 40, localIds, favoriteIds, recentIds } = {}) {
  const opts = { localIds: localIds || new Set(), favoriteIds: favoriteIds || new Set(), recentIds: recentIds || new Set() };
  const scored = (Array.isArray(foods) ? foods : [])
    .filter((f) => f && typeof f === 'object' && f.id)
    .map((food, i) => ({ food, i, score: scoreFood(query, food, opts) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const seenIds = new Set();
  const seenKeys = new Set();
  const out = [];
  for (const { food } of scored) {
    const key = dedupKey(food);
    if (seenIds.has(food.id) || seenKeys.has(key)) continue;
    seenIds.add(food.id);
    seenKeys.add(key);
    out.push(food);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Search the user's library and the built-in list synchronously (no network). Only matching foods
 * (score > 0) are returned, ranked by rankFoods with the library / favorite / recent boosts.
 * Never throws on odd input (empty or punctuation-only query → []).
 * @param {string} query
 * @param {{library?: object|object[], builtin?: object[], recents?: string[], favorites?: string[], limit?: number}} sources
 *   library: state.foods (id → Food map) or an array of Foods; recents/favorites: food ids
 * @returns {object[]} Foods
 */
export function searchLocal(query, { library = {}, builtin = [], recents = [], favorites = [], limit = 40 } = {}) {
  if (!tokenize(query).length) return [];
  const lib = (Array.isArray(library) ? library : Object.values(library || {}))
    .filter((f) => f && typeof f === 'object' && f.id);
  const opts = {
    localIds: new Set(lib.map((f) => f.id)),
    favoriteIds: new Set(Array.isArray(favorites) ? favorites : []),
    recentIds: new Set(Array.isArray(recents) ? recents : [])
  };
  const pool = [...lib, ...(Array.isArray(builtin) ? builtin : [])]
    .filter((f) => f && typeof f === 'object' && f.id && scoreFood(query, f, opts) > 0);
  return rankFoods(query, pool, { ...opts, limit });
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
 * @param {object} o
 * @returns {object} Food
 * @throws {Error} when per === 'serving' and servingGrams is given but not a positive number
 */
export function makeCustomFood({ id = null, name, brand = '', barcode = null, per, servingGrams, servingLabel: sLabel = '1 serving', cal, p, c, f, fiber = 0 }) {
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
  return food;
}
