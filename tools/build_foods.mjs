// Builds data/foods.json, MacroTally's built-in generic food list, from USDA FoodData Central
// (Foundation + SR Legacy, public domain). Node 18+, no dependencies.
//
// Usage (from the project root):
//   USDA_API_KEY=... node tools/build_foods.mjs            (bash)
//   $env:USDA_API_KEY='...'; node tools/build_foods.mjs     (PowerShell)
// Add --dry to enumerate and filter only (no portion requests, nothing written).
//
// API responses are treated as untrusted data: they are only JSON-parsed and copied field by field.

import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.nal.usda.gov/fdc/v1';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'foods.json');
const PAGE_SIZE = 200;
const BATCH = 20;
const DELAY_MS = 250;
const MAX_FOODS = 3500;
const MAX_BYTES = 400 * 1024;
const DRY = process.argv.includes('--dry');

const KEY = process.env.USDA_API_KEY;
if (!KEY) {
  console.error('USDA_API_KEY is not set. Get a free key at https://fdc.nal.usda.gov/api-key-signup and run:');
  console.error("  USDA_API_KEY=... node tools/build_foods.mjs   (PowerShell: $env:USDA_API_KEY='...'; node tools/build_foods.mjs)");
  process.exit(1);
}

// ---------- HTTP ----------

let requests = 0;

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON to the FDC API (key sent as a header so it never appears in logged URLs).
 * Sleeps between requests; retries once on 429 after 30 s and up to twice on 5xx/network errors.
 * @param {string} path
 * @param {object} body
 * @returns {Promise<any>}
 */
async function post(path, body) {
  let tried429 = false;
  for (let attempt = 0; ; attempt++) {
    await sleep(DELAY_MS);
    requests++;
    if (requests % 20 === 0) console.log(`  ... ${requests} requests`);
    let res;
    try {
      res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
        body: JSON.stringify(body)
      });
    } catch (err) {
      if (attempt < 2) { console.warn(`  network error on ${path} (${err.message}), retrying`); await sleep(5000); continue; }
      throw err;
    }
    if (res.ok) return JSON.parse(await res.text());
    if (res.status === 429 && !tried429) {
      tried429 = true;
      console.warn('  429 rate limited, waiting 30 s');
      await sleep(30000);
      continue;
    }
    if (res.status >= 500 && attempt < 2) { console.warn(`  HTTP ${res.status} on ${path}, retrying`); await sleep(5000); continue; }
    throw new Error(`HTTP ${res.status} on ${path}`);
  }
}

// ---------- Enumeration ----------

/**
 * Page through /foods/search for one data type. (/foods/list omits foodCategory, so search is used.)
 * @param {string} dataType
 * @returns {Promise<any[]>}
 */
async function enumerate(dataType) {
  const all = [];
  for (let page = 1; ; page++) {
    const j = await post('/foods/search', {
      query: '', dataType: [dataType], pageSize: PAGE_SIZE, pageNumber: page, sortBy: 'fdcId', sortOrder: 'asc'
    });
    const foods = Array.isArray(j.foods) ? j.foods : [];
    all.push(...foods);
    if (page === 1) console.log(`${dataType}: ${j.totalHits} foods, ${j.totalPages} pages`);
    if (!foods.length || page >= (j.totalPages || 0)) break;
  }
  return all;
}

// ---------- Nutrients ----------

/**
 * Per-100 g [kcal, protein, carbs, fat, fiber] from search-style foodNutrients, or null if empty.
 * @param {any[]} nutrients
 * @returns {number[]|null}
 */
function per100(nutrients) {
  /** @type {Record<string, number>} */
  const v = {};
  for (const n of Array.isArray(nutrients) ? nutrients : []) {
    const num = String(n.nutrientNumber ?? n.number ?? '');
    const val = Number(n.value ?? n.amount);
    if (num && Number.isFinite(val) && !(num in v)) v[num] = val;
  }
  const kcal = v['208'] ?? v['957'] ?? v['958'];
  const macros = ['203', '205', '204'].map((k) => v[k]);
  if (kcal === undefined && macros.every((m) => m === undefined)) return null;
  return [kcal, ...macros, v['291']].map((x) => round1(Math.max(0, x ?? 0)));
}

/** @param {number} x */
const round1 = (x) => Math.round(x * 10) / 10;

// ---------- Inclusion filter ----------

const SKIP_WORDS = /usda commodity|formulated|babyfood|infant|school lunch|industrial/i;
const FDP = /\s*\(includes foods for usda's food distribution program\)/i;
// SR Legacy writes brand names in capitals ("OCEAN SPRAY", "LAY'S"); branded items come from live sources instead.
const BRAND = /\b[A-Z][A-Z'&]{2,}\b/;
const MEAT = new Set(['Beef Products', 'Pork Products', 'Lamb, Veal, and Game Products', 'Poultry Products']);
const KEEP_ALL = new Set([
  'Dairy and Egg Products', 'Fats and Oils', 'Poultry Products', 'Sausages and Luncheon Meats',
  'Fruits and Fruit Juices', 'Pork Products', 'Vegetables and Vegetable Products', 'Nut and Seed Products',
  'Beef Products', 'Finfish and Shellfish Products', 'Legumes and Legume Products',
  'Lamb, Veal, and Game Products', 'Cereal Grains and Pasta'
]);

// Size control. The spec's rule (meats <= 7 comma parts, no select/choice grade, no 1/8" or 1/4" trim)
// gave ~4,350 foods and ~560 KB, over both targets (3,500 foods, 400 KB). Counting raw comma parts
// also drops key foods ("Chicken, broilers or fryers, breast, meat only, cooked, roasted" has 6), so
// SR Legacy foods are instead scored by "specific" parts: comma parts that are not plain preparation
// or cut-trim words, plus a penalty for frozen/canned-in-syrup/dehydrated variants. Foods scoring
// above MAX_SCORE are skipped, and if the file is still over MAX_BYTES the highest-scoring (most
// specific) SR Legacy foods are dropped until it fits. Meats additionally skip prime grade, separable
// fat, skin, giblets, back, neck, imported and stewing/roasting-hen cuts, organ meats other than liver
// and uncommon game.
const MAX_SCORE = 3;
const MEAT_SKIP = /trimmed to 1\/8|trimmed to 1\/4|\bselect\b|\bchoice\b|\bprime\b|separable fat|external fat|subcutaneous fat|skin only|giblets|, back\b|, neck\b|\bimported\b|\bcapons\b|chicken, stewing|chicken, roasting|variety meats and by-products, (?!liver)|^game meat, (?!bison|deer|elk|rabbit|goat|boar|buffalo)/;
const PREP = new Set([
  'raw', 'cooked', 'boiled', 'drained', 'without salt', 'dry heat', 'moist heat', 'roasted', 'baked', 'broiled',
  'grilled', 'braised', 'fried', 'pan-fried', 'stewed', 'simmered', 'steamed', 'meat only', 'separable lean only',
  'separable lean and fat', 'all grades', 'trimmed to 0" fat', 'enriched', 'unenriched', 'regular', 'mature seeds',
  'fluid', 'boneless', 'bone-in', 'whole', 'plain', 'unprepared', 'cooked with water', 'drained solids', 'fresh',
  'meat and skin', 'lean only', 'all varieties', 'all classes', 'broilers or fryers', 'in water', 'uncooked', 'dry',
  'prepared'
]);
// Leading class words that SR Legacy puts before the actual food name ("Fish, salmon, ...").
const CLASS_PREFIX = new Set(['fish', 'mollusks', 'crustaceans', 'cereals']);
// Commonly logged staples whose SR Legacy names are long: always kept (score 0), never size-trimmed.
const STAPLES = new RegExp('^(' + [
  'beef, ground, ', 'beef, top sirloin, steak, separable lean only', 'beef, round, eye of round',
  'fish, salmon, ', 'fish, tuna, ', 'fish, cod, ', 'fish, tilapia, ', 'fish, halibut, ', 'fish, trout, ',
  'crustaceans, shrimp, ', 'rice, (white|brown), (long|medium)-grain', 'cereals, oats, ', 'pasta, ', 'spaghetti, ',
  'noodles, egg, ', 'chicken, broilers or fryers, (breast|thigh|drumstick|wing|leg), meat only',
  'turkey, (whole|retail parts|all classes), breast', 'turkey, ground, ', 'pork, fresh, loin, (tenderloin|center)',
  'pork, ground, ', 'pork, cured, bacon, ', 'egg, (whole|white|yolk), ', 'milk, (whole|reduced fat|lowfat|nonfat), ',
  'yogurt, ', 'cheese, (cheddar|mozzarella|parmesan|swiss|cottage|cream|feta)',
  'beans, (black|kidney|pinto|navy), mature seeds, cooked', 'chickpeas \\(garbanzo beans', 'lentils, ',
  'potatoes, (baked|boiled|mashed)', 'sweet potato, cooked'
].join('|') + ')');

/**
 * Specificity score of an SR Legacy description (lower = more generic).
 * @param {string} d lowercased description
 * @returns {number}
 */
function score(d) {
  const parts = d.replace(/\([^)]*\)/g, '').split(',').map((s) => s.trim()).filter((s) => s && !PREP.has(s));
  if (CLASS_PREFIX.has(parts[0])) parts.shift();
  return parts.length + (/frozen/.test(d) ? 1 : 0) + (/dehydrated|freeze-dried/.test(d) ? 1 : 0) +
    (/solids and liquids|heavy syrup|light syrup/.test(d) ? 2 : 0);
}

// Most common spices and herbs, in priority order; at most 40 SR Legacy entries are kept.
const SPICES = [
  'salt, table', 'spices, pepper, black', 'spices, cinnamon', 'spices, garlic powder', 'spices, onion powder',
  'spices, paprika', 'spices, cumin', 'spices, chili powder', 'spices, oregano', 'spices, basil',
  'spices, thyme', 'spices, rosemary', 'spices, parsley', 'spices, dill weed', 'spices, ginger',
  'spices, nutmeg', 'spices, cloves', 'spices, turmeric', 'spices, curry powder', 'spices, pepper, red or cayenne',
  'spices, bay leaf', 'spices, coriander', 'spices, cardamom', 'spices, allspice', 'spices, mustard seed',
  'spices, fennel seed', 'spices, sage', 'spices, marjoram', 'spices, tarragon', 'spices, poppy seed',
  'spices, celery seed', 'spices, caraway seed', 'spices, saffron', 'vanilla extract', 'spices, pumpkin pie spice',
  'spices, poultry seasoning', 'chives', 'spearmint', 'peppermint', 'basil, fresh', 'dill weed, fresh',
  'rosemary, fresh', 'thyme, fresh', 'spices, pepper, white', 'spices, anise seed'
];
const spiceRank = (d) => SPICES.findIndex((s) => d.startsWith(s));

/** Allow-list predicates for SR Legacy categories kept only partially (lowercased description). */
const PARTIAL = {
  'Beverages': (d) => /^(beverages|alcoholic beverages?), (coffee|tea|water|beer|wine|distilled|almond milk|rice milk|soy milk|oat milk|coconut milk|milk|[a-z ]*juice\b)/.test(d) &&
    d.split(',').length <= 4 && !/drink|powder|cocktail|liqueur|fortified|with added|vitamin|diet|flavored/.test(d),
  'Baked Products': (d) => /^(bread|breads|bagels?|tortillas?|english muffins?|pita)\b/.test(d) &&
    !/crumbs|stuffing|dry mix|croutons/.test(d),
  'Sweets': (d) => /^(sugars?|honey|syrups?|jams|jellies|preserves|marmalade|baking chocolate|cocoa|chocolate)\b/.test(d) ||
    /^candies, (milk|semisweet|sweet|dark|white) chocolate/.test(d),
  'Snacks': (d) => /^snacks, (popcorn|pretzels|potato chips|tortilla chips|corn-based, extruded, chips|pita chips)/.test(d)
};

/**
 * Whether an SR Legacy food passes the inclusion filter.
 * @param {string} desc
 * @param {string} cat
 * @param {Set<string>} names all lowercased SR Legacy and Foundation descriptions
 * @returns {boolean}
 */
function keepSr(desc, cat, names) {
  const d = desc.toLowerCase();
  if (SKIP_WORDS.test(d) || BRAND.test(desc.replace(FDP, ''))) return false;
  // Twins: drop "with salt" when "without salt" exists, and the "(Includes foods for USDA's Food
  // Distribution Program)" copy when the plain one exists.
  if (d.includes('with salt') && names.has(d.replace('with salt', 'without salt'))) return false;
  if (FDP.test(d) && names.has(d.replace(FDP, ''))) return false;
  if (MEAT.has(cat) && MEAT_SKIP.test(d)) return false;
  if (KEEP_ALL.has(cat)) return STAPLES.test(d) || score(d) <= MAX_SCORE;
  if (cat === 'Spices and Herbs') return spiceRank(d) >= 0;
  const pred = PARTIAL[cat];
  return pred ? pred(d) : false;
}

// ---------- Portions ----------

/** @param {number} x */
const fmtAmount = (x) => (Number.isFinite(x) && x > 0 ? String(Math.round(x * 100) / 100) : '');

/**
 * Up to 4 household portions [label, grams] from a full-format food's foodPortions.
 * @param {any[]} portions
 * @returns {Array<[string, number]>}
 */
function servings(portions) {
  const out = [];
  const seen = new Set();
  const list = (Array.isArray(portions) ? portions : []).slice()
    .sort((a, b) => (Number(a.sequenceNumber) || 0) - (Number(b.sequenceNumber) || 0));
  for (const p of list) {
    const grams = round1(Number(p.gramWeight));
    if (!Number.isFinite(grams) || grams <= 0) continue;
    let label = typeof p.portionDescription === 'string' ? p.portionDescription.trim() : '';
    if (!label || /quantity not specified/i.test(label)) {
      const unit = p.measureUnit && typeof p.measureUnit.name === 'string' && p.measureUnit.name !== 'undetermined'
        ? p.measureUnit.name : '';
      const mod = typeof p.modifier === 'string' ? p.modifier.trim() : '';
      label = [fmtAmount(Number(p.amount)), unit, /^\d+$/.test(mod) ? '' : mod].filter(Boolean).join(' ');
    }
    if (/quantity not specified|\bRACC\b/i.test(label)) continue; // RACC is a labeling reference, not a household measure
    // Keep labels short: drop long parentheticals ("(yield from 1 lb raw meat)"), keep short ones ("(10 oz)").
    label = label.replace(/\s*\([^)]{13,}\)/g, '').replace(/\s+/g, ' ').trim();
    if (label.length > 30 && label.includes(',')) label = label.slice(0, label.indexOf(',')).trim();
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push([label, grams]);
    if (out.length === 4) break;
  }
  return out;
}

// ---------- Main ----------

const t0 = Date.now();
const foundation = await enumerate('Foundation');
const sr = await enumerate('SR Legacy');

/** @typedef {{id:number, n:string, c:string, p100:number[], sr:boolean, score:number}} Picked */
/** @type {Map<string, Picked>} */
const byName = new Map();
const names = new Set([...foundation, ...sr].map((f) => String(f.description ?? '').trim().toLowerCase()));
let noNutrients = 0;
/** @type {Picked[]} */
const spicesKept = [];
for (const [list, isSr] of [[foundation, false], [sr, true]]) {
  for (const f of list) {
    const desc = typeof f.description === 'string' ? f.description.trim() : '';
    const cat = typeof f.foodCategory === 'string' ? f.foodCategory : (f.foodCategory?.description ?? '');
    const id = Number(f.fdcId);
    if (!desc || !Number.isInteger(id)) continue;
    if (isSr && !keepSr(desc, cat, names)) continue;
    const p = per100(f.foodNutrients);
    if (!p) { noNutrients++; continue; }
    const key = desc.toLowerCase();
    if (byName.has(key)) continue; // Foundation comes first, so it wins
    const entry = { id, n: desc, c: cat || 'Other', p100: p, sr: isSr, score: isSr && !STAPLES.test(key) ? score(key) : 0 };
    if (isSr && cat === 'Spices and Herbs') { spicesKept.push(entry); continue; }
    byName.set(key, entry);
  }
}
spicesKept.sort((a, b) => spiceRank(a.n.toLowerCase()) - spiceRank(b.n.toLowerCase()));
for (const e of spicesKept.slice(0, 40)) byName.set(e.n.toLowerCase(), e);

const picked = [...byName.values()];
console.log(`Kept ${picked.length} foods (skipped ${noNutrients} without energy or macros).`);
if (picked.length > MAX_FOODS) console.warn(`WARNING: ${picked.length} foods exceeds the ${MAX_FOODS} target.`);

/** @param {Array<{c:string}>} list */
function printCounts(list) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const f of list) counts[f.c] = (counts[f.c] || 0) + 1;
  for (const [c, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${c}`);
}

if (DRY) {
  printCounts(picked);
  console.log(`Dry run: ${requests} requests, ${((Date.now() - t0) / 1000).toFixed(1)} s. Nothing written.`);
  process.exit(0);
}

// Portions, 20 ids per request, full format.
console.log(`Fetching portions in ${Math.ceil(picked.length / BATCH)} batches ...`);
/** @type {Map<number, Array<[string, number]>>} */
const portionsById = new Map();
for (let i = 0; i < picked.length; i += BATCH) {
  const ids = picked.slice(i, i + BATCH).map((f) => f.id);
  const j = await post('/foods', { fdcIds: ids, format: 'full' });
  for (const f of Array.isArray(j) ? j : []) portionsById.set(Number(f.fdcId), servings(f.foodPortions));
}
const missing = picked.filter((f) => !portionsById.has(f.id)).length;
if (missing) console.warn(`  ${missing} foods missing from /foods responses (kept with no portions).`);

let entries = picked.map((f) => {
  const food = { id: `usda:${f.id}`, n: f.n, c: f.c, p100: f.p100, s: portionsById.get(f.id) || [] };
  return { food, sr: f.sr, score: f.score, bytes: Buffer.byteLength(JSON.stringify(food)) + 1 };
});

// Fit the size budget: drop the most specific SR Legacy foods first (highest score, then longest name).
// Foundation foods and staples (score 0) are never dropped.
const HEADER_BYTES = 200;
let total = HEADER_BYTES + entries.reduce((sum, e) => sum + e.bytes, 0);
if (total > MAX_BYTES) {
  const order = entries.filter((e) => e.sr && e.score > 0)
    .sort((a, b) => b.score - a.score || b.food.n.length - a.food.n.length || a.food.n.localeCompare(b.food.n, 'en'));
  const drop = new Set();
  for (const e of order) {
    if (total <= MAX_BYTES) break;
    drop.add(e);
    total -= e.bytes;
  }
  entries = entries.filter((e) => !drop.has(e));
  console.log(`Dropped ${drop.size} of the most specific SR Legacy foods to stay under ${MAX_BYTES / 1024} KB.`);
}

const foods = entries.map((e) => e.food).sort((a, b) => a.n.localeCompare(b.n, 'en'));

// Validate before writing.
for (const f of foods) {
  const ok = typeof f.id === 'string' && /^usda:\d+$/.test(f.id) && typeof f.n === 'string' && f.n &&
    typeof f.c === 'string' && Array.isArray(f.p100) && f.p100.length === 5 && f.p100.every(Number.isFinite) &&
    Array.isArray(f.s) && f.s.every((s) => Array.isArray(s) && s.length === 2 && typeof s[0] === 'string' && Number.isFinite(s[1]));
  if (!ok) throw new Error(`Invalid food entry: ${JSON.stringify(f)}`);
}

const doc = {
  version: 1,
  source: 'USDA FoodData Central, Foundation + SR Legacy (public domain)',
  generated: new Date().toISOString().slice(0, 10),
  foods
};
const json = JSON.stringify(doc);
JSON.parse(json);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, json);

const size = statSync(OUT).size;
console.log('Per category:');
printCounts(foods);
console.log(`Total: ${foods.length} foods, ${foods.filter((f) => f.s.length).length} with portions.`);
console.log(`Wrote ${OUT} (${(size / 1024).toFixed(1)} KB) in ${((Date.now() - t0) / 1000).toFixed(0)} s using ${requests} requests.`);
if (size > MAX_BYTES) console.warn(`WARNING: file is larger than ${MAX_BYTES / 1024} KB.`);
