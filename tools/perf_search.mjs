// MacroTally local search timing: searchLocal over the real built-in list + bundled packs (read from data/) plus
// ~12,000 generated packaged-product foods (the size of data/packs/off-popular-us.json), as the add-food sheet
// searches them. No network. Run from the project root: node tools/perf_search.mjs [--products 12000]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
// fetch of file: URLs (builtin.js / packs.js load data/ relative to their own module URL).
globalThis.fetch = async (u) => {
  try {
    const text = readFileSync(fileURLToPath(String(u)), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(text) };
  } catch {
    return { ok: false, status: 404, json: async () => null };
  }
};
const origWarn = console.warn;
console.warn = () => {};

const foods = await import('../js/foods.js');
const { loadBuiltinFoods } = await import('../js/builtin.js');
const packs = await import('../js/packs.js');

const arg = process.argv.indexOf('--products');
const N = arg > 0 && Number.isFinite(Number(process.argv[arg + 1])) ? Number(process.argv[arg + 1]) : 12000;

const builtin = await loadBuiltinFoods();
const packFoods = await packs.loadPacks();
console.warn = origWarn;
const realPopular = packFoods.filter((f) => f.packId === 'off-popular-us').length;

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A products pack of n plausible US grocery items (brand, flavour words, food words, size words). */
function productFixture(n) {
  const r = rng(42);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const brands = ['Kellogg\'s', 'General Mills', 'Kraft', 'Heinz', 'Tyson', 'Perdue', 'Oscar Mayer', 'Great Value', 'Kirkland Signature', 'Trader Joe\'s',
    'Nature Valley', 'Quaker', 'Chobani', 'Dannon', 'Yoplait', 'Frito-Lay', 'Lay\'s', 'Doritos', 'Pepperidge Farm', 'Nabisco', 'Hershey\'s',
    'Ben & Jerry\'s', 'Häagen-Dazs', 'Barilla', 'Ragu', 'Prego', 'Campbell\'s', 'Progresso', 'Hormel', 'Hillshire Farm', 'Sara Lee', 'Pillsbury',
    'Betty Crocker', 'Annie\'s', 'Kind', 'Clif', 'Quest', 'Premier Protein', 'Fairlife', 'Horizon', 'Tillamook', 'Cabot', 'Sargento', 'Kraft Heinz',
    'Stouffer\'s', 'Lean Cuisine', 'Healthy Choice', 'Amy\'s', 'Birds Eye', 'Green Giant', 'Del Monte', 'Dole', 'Bush\'s', 'Goya', 'Old El Paso',
    'Tostitos', 'Pace', 'Hidden Valley', 'Ken\'s', 'Skippy', 'Jif', 'Smucker\'s', 'Nutella', 'Planters', 'Blue Diamond', 'Wonderful', 'Simply',
    'Tropicana', 'Minute Maid', 'Coca-Cola', 'Pepsi', 'Gatorade', 'Celsius', 'Monster', 'Starbucks', 'Folgers', 'Lipton', 'Arizona'];
  const flavours = ['Original', 'Honey', 'Chocolate', 'Vanilla', 'Strawberry', 'Sea Salt', 'BBQ', 'Spicy', 'Lightly Salted', 'Organic', 'Low Fat',
    'Reduced Sodium', 'Whole Grain', 'Cinnamon', 'Peanut Butter', 'Maple', 'Garlic', 'Cheddar', 'Ranch', 'Lemon', 'Blueberry', 'Mixed Berry',
    'Greek', 'Plain', 'Unsweetened', 'Zero Sugar', 'Classic', 'Homestyle', 'Roasted', 'Smoked', 'Grilled', 'Crispy', 'Frosted', 'Toasted'];
  const items = ['Chicken Breast', 'Chicken Strips', 'Chicken Nuggets', 'Turkey Breast', 'Ham', 'Bacon', 'Sausage', 'Hot Dogs', 'Ground Beef',
    'Cereal', 'Oatmeal', 'Granola', 'Granola Bars', 'Protein Bar', 'Yogurt', 'Milk', 'Cheese', 'Shredded Cheese', 'Cream Cheese', 'Butter',
    'Bread', 'Bagels', 'Tortillas', 'Crackers', 'Cookies', 'Potato Chips', 'Tortilla Chips', 'Pretzels', 'Popcorn', 'Ice Cream', 'Frozen Pizza',
    'Pasta', 'Pasta Sauce', 'Soup', 'Chili', 'Beans', 'Rice', 'Peanut Butter', 'Jelly', 'Salad Dressing', 'Salsa', 'Ketchup', 'Mayonnaise',
    'Orange Juice', 'Apple Juice', 'Soda', 'Sports Drink', 'Energy Drink', 'Coffee', 'Tea', 'Almonds', 'Trail Mix', 'Frozen Vegetables',
    'Mac & Cheese', 'Waffles', 'Pancake Mix', 'Muffins', 'Brownies', 'Candy Bar', 'Gummies', 'Fruit Snacks', 'Applesauce', 'Hummus'];
  const extras = ['', '', '', 'Family Size', 'Snack Pack', 'Value Pack', 'Single Serve', '12 oz', '16 oz', 'Boneless Skinless', 'Thin Sliced', 'Bites', 'Minis'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const words = [pick(flavours), pick(items), pick(extras)].filter(Boolean);
    if (r() < 0.3) words.unshift(pick(flavours));
    const grams = [28, 30, 39, 40, 55, 85, 100, 113, 150, 240][Math.floor(r() * 10)];
    out.push({
      id: String(100000000000 + i), n: words.join(' '), b: pick(brands), bc: String(100000000000 + i),
      s: grams === 100 ? ['100 g', 100] : [`1 serving (${grams} g)`, grams],
      v: [Math.round(r() * 500), Math.round(r() * 30), Math.round(r() * 60), Math.round(r() * 30), Math.round(r() * 8)]
    });
  }
  return { format: 'macrotally-pack/1', id: 'perf-products', name: 'Perf products', brand: 'Open Food Facts', kind: 'products', foods: out };
}

function makePool() {
  const fixture = productFixture(N);
  const products = fixture.foods.map((f) => packs.packFoodToFood(fixture, f)).filter(Boolean);
  // Fresh copies of every food: the token caches are keyed by object, so new objects measure a cold first call.
  return [...builtin, ...packFoods, ...products].map((f) => ({ ...f }));
}

const library = {};
const time = (fn) => {
  const t0 = performance.now();
  const out = fn();
  return [performance.now() - t0, out];
};
const ms = (x) => `${x.toFixed(1)} ms`;
const run = (pool, q) => foods.searchLocal(q, { library, builtin: pool, limit: 25 });

console.log(`Pool: ${builtin.length} built-in + ${packFoods.length} bundled pack foods (${realPopular} from off-popular-us.json) + ${N} generated products`);

// Scenario A: the first search of the session is exact (tokenizes every food), then the typo search builds the vocabulary.
let pool = makePool();
console.log(`Total foods searched: ${pool.length}`);
let [t1] = time(() => run(pool, 'chicken breast'));
let [t2, r2] = time(() => run(pool, 'chicken breast'));
let [t3, r3] = time(() => run(pool, 'chiken brest'));
let [t4] = time(() => run(pool, 'chiken brest'));
console.log(`A  exact "chicken breast"  first ${ms(t1)}  warm ${ms(t2)}  (${r2.length} results, top: ${r2[0] && r2[0].name})`);
console.log(`A  typo  "chiken brest"    first ${ms(t3)} (vocabulary build)  warm ${ms(t4)}  (top: ${r3[0] && r3[0].name})`);

// Scenario D (what the add-food sheet does): exact search, then the vocabulary is built while the browser is idle
// (warmSearchVocabulary), then the first typo search.
pool = makePool();
[t1] = time(() => run(pool, 'chicken breast'));
const [tw] = time(() => foods.warmSearchVocabulary(pool));
[t3] = time(() => run(pool, 'chiken brest'));
[t4] = time(() => run(pool, 'chiken brest'));
console.log(`D  exact first ${ms(t1)}, idle vocabulary build ${ms(tw)}, then typo "chiken brest" first ${ms(t3)}  warm ${ms(t4)}`);

// Scenario B: the first search of the session is the typo (cold tokens AND vocabulary).
pool = makePool();
[t3] = time(() => run(pool, 'chiken brest'));
[t4] = time(() => run(pool, 'chiken brest'));
console.log(`B  typo  "chiken brest"    first ${ms(t3)} (cold tokens + vocabulary)  warm ${ms(t4)}`);

// Scenario C: the pool array changes (a pack switched or the helper's pack arrives): same foods, new array.
pool = [...pool];
[t3] = time(() => run(pool, 'chiken brest'));
console.log(`C  typo  "chiken brest"    first after a pool change ${ms(t3)} (vocabulary rebuild, tokens cached)`);
