/**
 * MacroTally — food lookup (Open Food Facts, optional USDA FoodData Central) and portion scaling.
 * Food nutrients are always normalized to per 100 g.
 */
import { uid } from './store.js';

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
const OFF_FIELDS = 'code,product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,quantity';
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
    defaultGrams: servingGrams || 100
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
 * Look up a barcode on Open Food Facts. Tries the code as-is, then without a leading 0 (EAN-13 → UPC-A),
 * then with a leading 0 (UPC-A → EAN-13).
 * @param {string} code
 * @returns {Promise<object|null>} Food or null when not found
 */
export async function lookupBarcode(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (!clean) throw new Error('Enter a valid barcode (digits only).');
  const candidates = [clean];
  if (clean.length === 13 && clean.startsWith('0')) candidates.push(clean.slice(1));
  if (clean.length === 12) candidates.push('0' + clean);
  for (const c of candidates) {
    const data = await fetchJSON(`${OFF_BASE}/api/v2/product/${c}.json?fields=${OFF_FIELDS}`, 'Open Food Facts');
    if (data && data.product && (data.status === 1 || data.status === undefined || data.status === 'success')) {
      const food = foodFromOFF({ ...data.product, code: data.product.code || c });
      if (food) return food;
    }
  }
  return null;
}

/**
 * Search Open Food Facts (and USDA when usdaKey is given). USDA failures are swallowed;
 * an OFF failure is thrown only if USDA produced nothing. Results are de-duplicated by id.
 * Results come from the region's Open Food Facts site, ranked by scan popularity.
 * @param {string} query
 * @param {{usdaKey?:string, region?:string}} [opts]
 * @returns {Promise<object[]>} Foods
 */
export async function searchFoods(query, { usdaKey = '', region = 'world' } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const cacheKey = `${region}|${usdaKey ? 'u' : '-'}|${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;
  const results = await searchFoodsUncached(q, { usdaKey, region });
  if (searchCache.size >= 60) searchCache.delete(searchCache.keys().next().value);
  searchCache.set(cacheKey, results);
  return results;
}

/** Session cache of search results, keyed by region + query, so retyping a query costs no request. */
const searchCache = new Map();

async function searchFoodsUncached(q, { usdaKey, region }) {
  const offUrl = `${offSearchBase(region)}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=25&sort_by=unique_scans_n&fields=${OFF_FIELDS}`;
  const offP = fetchJSON(offUrl, 'Open Food Facts').then((d) =>
    (d?.products || []).filter((p) => p && (p.product_name || p.product_name_en)).map(foodFromOFF).filter(Boolean)
  );
  const key = String(usdaKey || '').trim();
  const usdaP = key
    ? fetchJSON(
      `${USDA_BASE}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}&pageSize=20&dataType=${encodeURIComponent('Foundation,SR Legacy,Branded')}`,
      'USDA FoodData Central'
    ).then((d) => (d?.foods || []).map(foodFromUSDA).filter(Boolean)).catch(() => [])
    : Promise.resolve([]);
  const [off, usda] = await Promise.allSettled([offP, usdaP]);
  const usdaFoods = usda.status === 'fulfilled' ? usda.value : [];
  if (off.status === 'rejected' && !usdaFoods.length) throw off.reason;
  const all = [...(off.status === 'fulfilled' ? off.value : []), ...usdaFoods];
  const seen = new Map();
  for (const f of all) if (!seen.has(f.id)) seen.set(f.id, f);
  return [...seen.values()];
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
 * All unit options for a food: its servings, then g and oz.
 * @param {object} food
 * @returns {{label:string, grams:number}[]}
 */
export function unitOptions(food) {
  return [...(food?.servings || []).map((s) => ({ label: s.label, grams: s.grams })), { ...UNIT_G }, { ...UNIT_OZ }];
}

/**
 * Build an Entry (without id/meal) from a food, quantity and unit. Nutrient snapshot rounded to 2 decimals.
 * @param {object} food
 * @param {number} qty
 * @param {{label:string, grams:number}} unit
 * @returns {object}
 */
export function buildEntry(food, qty, unit) {
  const q = Number(qty) || 0;
  const grams = q * (Number(unit?.grams) || 0);
  const n = nutrientsFor(food, grams);
  return {
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
}

/**
 * Make a custom Food. per === 'serving' means the numbers are for `servingGrams` grams;
 * per === '100g' means they are per 100 g. Pass an existing id to keep it when editing.
 * @param {object} o
 * @returns {object} Food
 * @throws {Error} when per === 'serving' and servingGrams is not a positive number
 */
export function makeCustomFood({ id = null, name, brand = '', barcode = null, per, servingGrams, servingLabel: sLabel = '1 serving', cal, p, c, f, fiber = 0 }) {
  const sg = num(servingGrams);
  if (per === 'serving' && !(sg > 0)) throw new Error('Enter the serving size in grams.');
  const k = per === 'serving' ? 100 / sg : 1;
  const v = (x) => r2((num(x) ?? 0) * k);
  const servings = [];
  if (sg > 0) {
    const base = String(sLabel || '1 serving').replace(/\s*\(\s*[\d.,]+\s*g\s*\)\s*$/i, '').trim() || '1 serving';
    servings.push({ label: `${base} (${fmtG(sg)} g)`, grams: sg });
  }
  const bc = barcode === null || barcode === undefined ? '' : String(barcode).trim();
  return {
    id: id || `custom:${uid()}`,
    source: 'custom',
    barcode: bc || null,
    name: String(name || '').trim() || 'Custom food',
    brand: String(brand || '').trim(),
    per100: { cal: v(cal), p: v(p), c: v(c), f: v(f), fiber: v(fiber) },
    servings,
    defaultGrams: sg > 0 ? sg : 100
  };
}
