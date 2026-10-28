// MacroTally logic tests. Run from the project root: node tools/test_calc.mjs
import assert from 'node:assert/strict';

// Tiny in-memory localStorage shim (must exist before store.js is imported).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear()
};

const store = await import('../js/store.js');
const calc = await import('../js/calc.js');
const foods = await import('../js/foods.js');
const charts = await import('../js/charts.js');
const builtin = await import('../js/builtin.js');
const packs = await import('../js/packs.js');
const { config } = await import('../js/config.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

// ---------- store: dates ----------
test('todayStr uses local date parts', () => {
  assert.equal(store.todayStr(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(store.todayStr(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
});
test('parseDate is local midnight', () => {
  const d = store.parseDate('2026-03-08');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 8);
  assert.equal(d.getHours(), 0);
});
test('addDays across month/year/DST boundaries', () => {
  assert.equal(store.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(store.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(store.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(store.addDays('2026-03-07', 2), '2026-03-09');
  assert.equal(store.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(store.addDays('2026-10-28', 0), '2026-10-28');
});
test('daysBetween is integer b - a', () => {
  assert.equal(store.daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(store.daysBetween('2026-04-01', '2026-03-01'), -31);
  assert.equal(store.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(store.daysBetween('2026-10-28', '2026-10-28'), 0);
});
test('units + fmtWeight', () => {
  near(store.toKg(100, 'imperial'), 45.359237, 1e-9);
  assert.equal(store.toKg(80, 'metric'), 80);
  assert.equal(store.fmtWeight(82.7, 'metric'), '82.7 kg');
  assert.equal(store.fmtWeight(store.toKg(182.4, 'imperial'), 'imperial'), '182.4 lb');
  assert.equal(store.fmtWeight(null, 'metric'), '–');
  assert.equal(store.weightUnit('imperial'), 'lb');
});
test('state live binding, addWeight sort/replace, import/export', () => {
  const before = store.state;
  store.resetAll();
  assert.notEqual(store.state, before);
  store.addWeight('2026-01-03', 80);
  store.addWeight('2026-01-01', 81);
  store.addWeight('2026-01-03', 79.5);
  assert.deepEqual(store.state.weights.map((w) => w.date), ['2026-01-01', '2026-01-03']);
  assert.equal(store.state.weights[1].kg, 79.5);
  store.addEntry('2026-01-01', { foodId: 'custom:x', name: 'X', cal: 100, p: 1, c: 2, f: 3, fiber: 0 });
  assert.equal(store.state.recents[0], 'custom:x');
  const json = store.exportJSON();
  store.resetAll();
  assert.equal(store.state.weights.length, 0);
  store.importJSON(json);
  assert.equal(store.state.weights.length, 2);
  assert.equal(store.state.diary['2026-01-01'].entries.length, 1);
  assert.ok(JSON.parse(mem.get(store.STORAGE_KEY)).weights.length === 2, 'saved to localStorage');
  assert.throws(() => store.importJSON('{"foo":1}'), /Not a MacroTally backup/);
  assert.throws(() => store.importJSON('not json'), /Not a MacroTally backup/);
  assert.equal(store.toggleFavorite('custom:x'), true);
  assert.equal(store.toggleFavorite('custom:x'), false);
});
test('save() swallows quota errors', () => {
  const orig = globalThis.localStorage.setItem;
  const warn = console.warn;
  console.warn = () => {};
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    assert.doesNotThrow(() => store.save());
  } finally {
    globalThis.localStorage.setItem = orig;
    console.warn = warn;
  }
});

// ---------- calc: trend ----------
test('trendSeries: first point equals weight, daily alpha 0.1', () => {
  const s = calc.trendSeries([{ date: '2026-01-01', kg: 80 }, { date: '2026-01-02', kg: 81 }]);
  assert.equal(s[0].trend, 80);
  near(s[1].trend, 80.1, 1e-9);
});
test('trendSeries: gap-aware alpha = 1-(1-a)^gap', () => {
  const s = calc.trendSeries([{ date: '2026-01-01', kg: 80 }, { date: '2026-01-08', kg: 78 }]);
  const a = 1 - Math.pow(0.9, 7);
  near(s[1].trend, 80 + a * (78 - 80), 1e-9);
  assert.equal(calc.latestTrend([]), null);
});

// ---------- calc: expenditure ----------
function seeded(endDate, { intake = 2000, lossPerWeek = 0.5, days = 21, history = 60 } = {}) {
  const st = store.defaults();
  for (let i = history; i >= 0; i--) {
    const date = store.addDays(endDate, -i);
    st.weights.push({ date, kg: 90 - (lossPerWeek / 7) * (history - i) });
  }
  for (let i = 0; i < days; i++) {
    st.diary[store.addDays(endDate, -i)] = { entries: [{ id: 'e' + i, cal: intake, p: 150, c: 200, f: 60, fiber: 20 }] };
  }
  return st;
}
test('estimateExpenditure: 2000 kcal, -0.5 kg/wk → ~2550', () => {
  const est = calc.estimateExpenditure(seeded('2026-03-31'), '2026-03-31');
  assert.ok(est, 'estimate returned');
  near(est.kcal, 2550, 15, 'kcal');
  assert.equal(est.avgIntake, 2000);
  assert.equal(est.loggedDays, 21);
  assert.equal(est.spanDays, 20);
  assert.ok(est.deltaKg < 0);
});
test('estimateExpenditure ignores unlogged days and needs ≥7 logged', () => {
  const st = seeded('2026-03-31');
  for (let i = 0; i < 21; i += 2) delete st.diary[store.addDays('2026-03-31', -i)];
  const est = calc.estimateExpenditure(st, '2026-03-31');
  assert.equal(est.loggedDays, 10);
  assert.equal(est.avgIntake, 2000);
  near(est.kcal, 2550, 15);
  const st2 = seeded('2026-03-31', { days: 6 });
  assert.equal(calc.estimateExpenditure(st2, '2026-03-31'), null);
  const st3 = seeded('2026-03-31');
  st3.weights = [{ date: '2026-03-30', kg: 80 }, { date: '2026-03-31', kg: 80 }];
  assert.equal(calc.estimateExpenditure(st3, '2026-03-31'), null, 'span < 7');
});
test('refreshExpenditure: formula init, then 50/50 blend + clamp', () => {
  const today = store.todayStr();
  const st = seeded(store.addDays(today, -1));
  st.profile = { ...st.profile, sex: 'male', birthYear: 1990, heightCm: 180, activity: 1.4 };
  assert.equal(calc.refreshExpenditure(st), true);
  assert.equal(st.expenditure.method, 'formula');
  const lt = calc.latestTrend(st.weights).trend;
  assert.equal(st.expenditure.kcal, calc.initialExpenditure(st.profile, lt));
  assert.equal(calc.refreshExpenditure(st), false, 'not due yet');
  st.expenditure.kcal = 2300;
  assert.equal(calc.refreshExpenditure(st, { force: true }), true);
  const est = calc.estimateExpenditure(st, store.addDays(today, -1));
  assert.equal(st.expenditure.kcal, Math.round(0.5 * 2300 + 0.5 * est.kcal));
  assert.equal(st.expenditure.method, 'adaptive');
  assert.equal(st.expenditure.updatedAt, today);
  assert.deepEqual(st.expenditure.detail, est);
  st.expenditure.kcal = 9000;
  st.expenditure.updatedAt = store.addDays(today, -8);
  calc.refreshExpenditure(st);
  assert.ok(st.expenditure.kcal <= 6000, 'clamped');
});
test('bmr Mifflin-St Jeor', () => {
  assert.equal(calc.bmr({ sex: 'male', kg: 80, cm: 180, age: 30 }), 800 + 1125 - 150 + 5);
  assert.equal(calc.bmr({ sex: 'female', kg: 60, cm: 165, age: 30 }), 600 + 1031.25 - 150 - 161);
});

// ---------- calc: targets / projection ----------
function targetState({ kcal, mode = 'lose', rate = 0.45, sex = 'male', kg = 80, proteinPerKg = 1.8, fatPct = 0.28 }) {
  const st = store.defaults();
  st.profile.sex = sex;
  st.goal = { ...st.goal, mode, rateKgPerWeek: rate, proteinPerKg, fatPct };
  st.expenditure.kcal = kcal;
  st.weights = [{ date: '2026-01-01', kg }];
  return st;
}
test('targets: rounds to nearest 10, macros', () => {
  const t = calc.targets(targetState({ kcal: 2347 }));
  assert.equal(t.cal, 1850); // 2347 - 0.45*7700/7 = 1852 → 1850
  assert.equal(t.p, 144);
  assert.equal(t.f, Math.round(0.28 * 1850 / 9));
  assert.equal(t.c, Math.round((1850 - 4 * 144 - 9 * t.f) / 4));
  assert.equal(t.floored, false);
  assert.equal(t.source, 'auto');
});
test('targets: calorie floor', () => {
  const m = calc.targets(targetState({ kcal: 1600, rate: 1 }));
  assert.equal(m.cal, 1500);
  assert.equal(m.floored, true);
  const f = calc.targets(targetState({ kcal: 1300, rate: 1, sex: 'female', kg: 55 }));
  assert.equal(f.cal, 1200);
  assert.equal(f.floored, true);
});
test('targets: negative-carbs guard', () => {
  const t = calc.targets(targetState({ kcal: 1500, mode: 'maintain', kg: 100, proteinPerKg: 3.3, fatPct: 0.3 }));
  assert.equal(t.cal, 1500);
  assert.equal(t.p, 330);
  assert.equal(t.c, 0);
  assert.equal(t.f, Math.round((1500 - 4 * 330) / 9));
});
test('targets: manual mode', () => {
  const st = targetState({ kcal: 2000 });
  st.goal.macroMode = 'manual';
  st.goal.manual = { cal: 2100, p: 160, c: 220, f: 70 };
  const t = calc.targets(st);
  assert.equal(t.cal, 2100);
  assert.equal(t.source, 'manual');
});
test('projection', () => {
  const st = targetState({ kcal: 2500, rate: 0.5, kg: 90 });
  st.goal.targetWeightKg = 85;
  const p = calc.projection(st);
  assert.equal(p.weeks, 10);
  assert.equal(p.date, store.addDays(store.todayStr(), 70));
  st.goal.targetWeightKg = 95;
  assert.equal(calc.projection(st), null, 'already past target');
  st.goal.mode = 'maintain';
  assert.equal(calc.projection(st), null);
  assert.equal(calc.signedRate({ mode: 'gain', rateKgPerWeek: -0.3 }), 0.3);
});
test('intakeSeries', () => {
  const st = store.defaults();
  st.diary[store.todayStr()] = { entries: [{ cal: 500 }, { cal: 250 }] };
  const s = calc.intakeSeries(st, 14);
  assert.equal(s.length, 14);
  assert.equal(s[13].date, store.todayStr());
  assert.equal(s[13].cal, 750);
  assert.equal(s[13].logged, true);
  assert.equal(s[0].logged, false);
  assert.deepEqual(calc.dayTotals(undefined), { cal: 0, p: 0, c: 0, f: 0, fiber: 0 });
});

// ---------- foods ----------
test('parseServingGrams', () => {
  assert.equal(foods.parseServingGrams('30 g', null), 30);
  assert.equal(foods.parseServingGrams('30g', undefined), 30);
  assert.equal(foods.parseServingGrams('1 cup (240 ml)', null), 240);
  near(foods.parseServingGrams('2 oz', null), 56.7, 0.05);
  assert.equal(foods.parseServingGrams(null, null), null);
  assert.equal(foods.parseServingGrams('1 large egg', null), null);
  assert.equal(foods.parseServingGrams('anything', '45'), 45);
  assert.equal(foods.parseServingGrams('30 g', 28), 28);
});
test('foodFromOFF: string nutriments, kJ only', () => {
  const f = foods.foodFromOFF({
    code: '123', product_name: 'Oats', brands: 'Acme, Other',
    serving_size: '40 g', serving_quantity: '40',
    nutriments: { energy_100g: '1569', proteins_100g: '13', carbohydrates_100g: '60', fat_100g: '7', fiber_100g: 'abc' }
  });
  assert.equal(f.id, 'off:123');
  assert.equal(f.brand, 'Acme');
  near(f.per100.cal, 375, 0.1);
  assert.equal(f.per100.fiber, 0);
  assert.equal(f.defaultGrams, 40);
  assert.equal(f.servings[0].label, '1 serving (40 g)');
});
test('foodFromOFF: per-serving only + no nutrients → null', () => {
  const f = foods.foodFromOFF({
    code: '456', product_name: 'Bar', serving_size: '50 g',
    nutriments: { 'energy-kcal_serving': 200, proteins_serving: '10', carbohydrates_serving: 25, fat_serving: 5 }
  });
  assert.equal(f.per100.cal, 400);
  assert.equal(f.per100.p, 20);
  assert.equal(foods.foodFromOFF({ code: '789', product_name: 'Nada', nutriments: {} }), null);
});
test('nutrientsFor is unrounded; buildEntry', () => {
  const food = { id: 'x', name: 'X', brand: '', per100: { cal: 333, p: 10, c: 50, f: 9, fiber: 3 }, servings: [] };
  const n = foods.nutrientsFor(food, 33);
  assert.equal(n.cal, 333 * 0.33);
  const e = foods.buildEntry(food, 2, foods.UNIT_OZ);
  near(e.grams, 56.699, 0.01);
  assert.equal(e.unit.label, 'oz');
  assert.equal(foods.unitOptions(food).length, 2);
});
test('makeCustomFood per-serving → per-100g', () => {
  const f = foods.makeCustomFood({ name: 'Bar', per: 'serving', servingGrams: 30, cal: 120, p: 6, c: 15, f: 3 });
  assert.equal(f.per100.cal, 400);
  assert.equal(f.per100.p, 20);
  assert.equal(f.per100.c, 50);
  assert.equal(f.per100.f, 10);
  assert.equal(f.source, 'custom');
  assert.ok(f.id.startsWith('custom:'));
  assert.equal(f.defaultGrams, 30);
  assert.equal(f.servings[0].label, '1 serving (30 g)');
  const g = foods.makeCustomFood({ id: f.id, name: 'Bar', per: '100g', servingGrams: 30, servingLabel: '1 serving (30 g)', cal: 400, p: 20, c: 50, f: 10 });
  assert.equal(g.id, f.id);
  assert.equal(g.per100.cal, 400);
  assert.equal(g.servings[0].label, '1 serving (30 g)');
  assert.throws(() => foods.makeCustomFood({ name: 'X', per: 'serving', servingGrams: 0, cal: 1, p: 0, c: 0, f: 0 }));
});

// ---------- food packs / servingOnly foods ----------
const TB = { id: 'taco-bell', name: 'Taco Bell', brand: 'Taco Bell' };
const packText = (extra = {}) => JSON.stringify({
  format: 'macrotally-pack/1', id: 'test-pack', name: 'Test Diner', brand: 'Test Diner',
  source: 'https://example.com', generated: '2026-10-28',
  foods: [
    { id: '1', n: 'Big Burger', cat: 'Burgers', s: ['1 burger', null], v: [600, 30, 45, 32, 2] },
    { id: 2, n: 'Side Salad', s: ['1 salad', 120], v: [60, 2, 8, 3] },
    { id: '3', n: 'Bad', s: ['1 x', null], v: [1, 2, 'x', 4] },
    { id: '4', n: 'Negative', v: [1, -2, 3, 4] },
    { n: 'No id', v: [1, 2, 3, 4] },
    { id: '1', n: 'Duplicate', v: [1, 2, 3, 4] }
  ],
  ...extra
});

test('packFoodToFood: null grams → servingOnly (per100 = one serving); grams → per 100 g', () => {
  const f = packs.packFoodToFood(TB, { id: '166727', n: 'Burrito Supreme - Beef', cat: 'Burritos', s: ['1 burrito', null], v: [390, 16, 52, 14, 8] });
  assert.deepEqual(f, {
    id: 'pack:taco-bell:166727', source: 'pack', packId: 'taco-bell', barcode: null,
    name: 'Burrito Supreme - Beef', brand: 'Taco Bell', category: 'Burritos', servingOnly: true,
    per100: { cal: 390, p: 16, c: 52, f: 14, fiber: 8 },
    servings: [{ label: '1 burrito', grams: 100 }], defaultGrams: 100
  });
  const g = packs.packFoodToFood(TB, { id: '9', n: 'Nachos', s: ['1 order', 150], v: [390, 16, 52, 14, 8] });
  assert.equal(g.servingOnly, undefined);
  assert.deepEqual(g.per100, { cal: 260, p: 10.67, c: 34.67, f: 9.33, fiber: 5.33 });
  assert.deepEqual(g.servings, [{ label: '1 order (150 g)', grams: 150 }]);
  assert.equal(g.defaultGrams, 150);
  assert.equal(g.category, '');
  const h = packs.packFoodToFood(TB, { id: '10', n: 'No serving', v: [100, 1, 2, 3] });
  assert.deepEqual(h.servings, [{ label: '1 serving', grams: 100 }]);
  assert.equal(h.per100.fiber, 0);
  assert.equal(packs.packFoodToFood(TB, { id: '11', n: 'Bad', v: [1, 2, 3] }), null);
  assert.equal(packs.packFoodToFood(TB, { n: 'No id', v: [1, 2, 3, 4] }), null);
});

test('unitOptions / buildEntry for servingOnly foods: servings only, entry carries servingOnly', () => {
  const f = packs.packFoodToFood(TB, { id: '1', n: 'Crunchy Taco', s: ['1 taco', null], v: [170, 8, 13, 10, 3] });
  const units = foods.unitOptions(f);
  assert.deepEqual(units, [{ label: '1 taco', grams: 100 }]);
  assert.ok(!units.some((u) => u.label === 'g' || u.label === 'oz'));
  const e = foods.buildEntry(f, 2, units[0]);
  assert.equal(e.servingOnly, true);
  assert.equal(e.cal, 340);
  assert.equal(e.p, 16);
  assert.equal(e.grams, 200);
  const normal = { id: 'x', name: 'X', per100: { cal: 100, p: 1, c: 1, f: 1, fiber: 0 }, servings: [{ label: '1 cup (40 g)', grams: 40 }] };
  assert.equal(foods.buildEntry(normal, 1, normal.servings[0]).servingOnly, undefined);
  assert.deepEqual(foods.unitOptions(normal).map((u) => u.label), ['1 cup (40 g)', 'g', 'oz']);
});

test('makeCustomFood per serving without grams → servingOnly food', () => {
  const f = foods.makeCustomFood({ name: 'Diner pancakes', per: 'serving', servingGrams: null, servingLabel: '1 stack', cal: 520, p: 12, c: 80, f: 16, fiber: 2 });
  assert.equal(f.servingOnly, true);
  assert.deepEqual(f.per100, { cal: 520, p: 12, c: 80, f: 16, fiber: 2 });
  assert.deepEqual(f.servings, [{ label: '1 stack', grams: 100 }]);
  assert.equal(f.defaultGrams, 100);
  assert.equal(f.source, 'custom');
  const g = foods.makeCustomFood({ name: 'Mystery', per: 'serving', servingGrams: '', servingLabel: '', cal: 100, p: 0, c: 0, f: 0 });
  assert.equal(g.servingOnly, true);
  assert.equal(g.servings[0].label, '1 serving');
  assert.deepEqual(foods.unitOptions(g), [{ label: '1 serving', grams: 100 }]);
  // per 100 g without grams is unchanged: a normal food with no servings.
  const h = foods.makeCustomFood({ name: 'Flour', per: '100g', cal: 364, p: 10, c: 76, f: 1 });
  assert.equal(h.servingOnly, undefined);
  assert.deepEqual(h.servings, []);
  assert.equal(h.per100.cal, 364);
  assert.throws(() => foods.makeCustomFood({ name: 'X', per: 'serving', servingGrams: -5, cal: 1, p: 0, c: 0, f: 0 }));
});

test('importPack: rejects bad input, stores a good pack (valid foods only), removePack', () => {
  store.resetAll();
  assert.throws(() => packs.importPack('not json'), /not valid JSON/);
  assert.throws(() => packs.importPack(packText({ format: 'macrotally-pack/2' })), /Not a MacroTally food pack/);
  assert.throws(() => packs.importPack(JSON.stringify([1, 2])), /Not a MacroTally food pack/);
  assert.throws(() => packs.importPack(packText({ name: '' })), /no id or name/);
  assert.throws(() => packs.importPack(packText({ id: 'Bad Id!' })), /lowercase/);
  assert.throws(() => packs.importPack(packText({ foods: 'nope' })), /no foods/);
  assert.throws(() => packs.importPack(packText({ foods: [{ id: '1', n: 'X', v: [1, 2] }] })), /no valid foods/);
  assert.deepEqual(store.state.packs, {}, 'nothing stored on failure');
  const r = packs.importPack(packText());
  assert.deepEqual(r, { id: 'test-pack', name: 'Test Diner', count: 2 });
  assert.equal(store.state.packs['test-pack'].foods.length, 2);
  const saved = JSON.parse(globalThis.localStorage.getItem(store.STORAGE_KEY));
  assert.equal(saved.packs['test-pack'].name, 'Test Diner', 'saved to storage');
  const pf = packs.packFoods();
  assert.deepEqual(pf.map((f) => f.id), ['pack:test-pack:1', 'pack:test-pack:2']);
  assert.equal(pf[0].servingOnly, true);
  assert.equal(pf[1].per100.cal, 50);
  assert.deepEqual(packs.listPacks(), [{ id: 'test-pack', name: 'Test Diner', count: 2, generated: '2026-10-28', bundled: false }]);
  // Re-import replaces the older copy.
  packs.importPack(packText({ name: 'Test Diner v2', foods: [{ id: '7', n: 'Shake', s: ['1 shake', null], v: [500, 10, 70, 20, 0] }] }));
  assert.deepEqual(packs.packFoods().map((f) => f.id), ['pack:test-pack:7']);
  assert.equal(packs.listPacks()[0].name, 'Test Diner v2');
  // Pack foods are found by brand + name.
  const hits = foods.searchLocal('test diner shake', { library: {}, builtin: packs.packFoods() });
  assert.deepEqual(hits.map((f) => f.id), ['pack:test-pack:7']);
  assert.equal(packs.removePack('test-pack'), true);
  assert.equal(packs.removePack('test-pack'), false);
  assert.deepEqual(packs.packFoods(), []);
  assert.deepEqual(packs.listPacks(), []);
});

test('scoreFood: pack foods get the same curated bonus as built-in foods', () => {
  const base = { name: 'Burrito Supreme', brand: 'Taco Bell', per100: { cal: 390, p: 16, c: 52, f: 14 } };
  const pack = foods.scoreFood('taco bell burrito', { ...base, id: 'pack:a:1', source: 'pack' });
  const off = foods.scoreFood('taco bell burrito', { ...base, id: 'off:1', source: 'off' });
  const bi = foods.scoreFood('burrito', { ...base, id: 'b', source: 'builtin' });
  assert.ok(pack > off, `${pack} > ${off}`);
  assert.equal(foods.scoreFood('burrito', { ...base, id: 'pack:a:1', source: 'pack' }), bi);
});

test('store: packs default + merge; backup restore takes packs from the backup, else keeps them', () => {
  store.resetAll();
  assert.deepEqual(store.state.packs, {});
  store.replaceState({ packs: 'junk' });
  assert.deepEqual(store.state.packs, {});
  packs.importPack(packText());
  const backup = store.exportJSON();
  assert.ok(JSON.parse(backup).packs['test-pack'], 'backups carry user packs');
  store.resetAll();
  assert.deepEqual(packs.packFoods(), [], 'state swap is picked up');
  store.importJSON(backup);
  assert.equal(packs.packFoods().length, 2);
  // An old backup without packs keeps this device's packs.
  store.importJSON(JSON.stringify({ version: 1, diary: {} }));
  assert.ok(store.state.packs['test-pack']);
  // A backup with an empty packs object restores exactly that.
  store.importJSON(JSON.stringify({ version: 1, diary: {}, packs: {} }));
  assert.deepEqual(store.state.packs, {});
  store.resetAll();
});

// ---------- search: ranking ----------
test('tokenize', () => {
  assert.deepEqual(foods.tokenize('Chicken, breast (raw)!'), ['chicken', 'breast', 'raw']);
  // Light plural stemming: trailing s dropped, "ies" → "y".
  assert.deepEqual(foods.tokenize("Bob's Red-Mill  OATS"), ['bob', 'red', 'mill', 'oat']);
  assert.deepEqual(foods.tokenize('Strawberries, hummus, glass'), ['strawberry', 'hummus', 'glass']);
  assert.deepEqual(foods.tokenize('  '), []);
  assert.deepEqual(foods.tokenize('!!!'), []);
  assert.deepEqual(foods.tokenize(null), []);
  assert.deepEqual(foods.tokenize(undefined), []);
  assert.deepEqual(foods.tokenize(42), ['42']);
});

const mk = (id, name, extra = {}) => ({
  id, source: 'off', barcode: null, name, brand: '',
  per100: { cal: 100, p: 10, c: 10, f: 1, fiber: 0 }, servings: [], defaultGrams: 100, ...extra
});

test('scoreFood ordering: phrase match, length, partial factor, no match', () => {
  const generic = mk('usda:171077', 'Chicken, breast, skinless, boneless, raw', { source: 'builtin' });
  const sandwich = mk('off:1', 'Chicken breast sandwich');
  const pork = mk('usda:2', 'Pork chop', { source: 'builtin' });
  const q = 'chicken breast';
  const sG = foods.scoreFood(q, generic);
  const sS = foods.scoreFood(q, sandwich);
  // Both match every token; the generic (phrase match on tokens, curated bonus) beats the one with an extra word.
  assert.ok(sS > 0 && sG > sS, `generic ${sG} > sandwich ${sS}`);
  assert.equal(foods.scoreFood(q, pork), 0);
  assert.ok(sG > foods.scoreFood(q, pork));
  // One misspelled token: still surfaces (x 0.25), far below a full match.
  const typo = foods.scoreFood('chicken brest', generic);
  assert.ok(typo > 0 && typo < sG / 2, `typo ${typo}`);
  // Equal match: the long description loses to the short name (-0.05 per token beyond 6).
  const short = mk('off:2', 'Rolled oats');
  const long = mk('off:3', 'Rolled oats old fashioned whole grain thick cut organic');
  assert.ok(foods.scoreFood('rolled oats', short) > foods.scoreFood('rolled oats', long));
  // Brand-only prefix counts less than a name prefix.
  assert.ok(foods.scoreFood('quaker', mk('off:4', 'Quaker oats')) > foods.scoreFood('quaker', mk('off:5', 'Oats', { brand: 'Quaker' })));
  // Popularity and completeness.
  assert.ok(foods.scoreFood('oats', mk('off:6', 'Oats', { pop: 5000 })) > foods.scoreFood('oats', mk('off:7', 'Oats')));
  const empty = mk('off:8', 'Oats', { per100: { cal: 0, p: 0, c: 0, f: 0, fiber: 0 } });
  near(foods.scoreFood('oats', mk('off:9', 'Oats')) - foods.scoreFood('oats', empty), 4, 1e-9, 'all-zero penalty');
  assert.equal(foods.scoreFood('', generic), 0);
  assert.equal(foods.scoreFood('%%', generic), 0);
});

test('scoreFood: library boost beats built-in boost at equal match; favorites/recents add more', () => {
  const builtinFood = mk('usda:1', 'Banana, raw', { source: 'builtin' });
  const lib = mk('off:10', 'Banana, raw');
  const localIds = new Set(['off:10']);
  const sB = foods.scoreFood('banana', builtinFood, { localIds });
  const sL = foods.scoreFood('banana', lib, { localIds });
  assert.ok(sL > sB, `library ${sL} > builtin ${sB}`);
  const sFav = foods.scoreFood('banana', lib, { localIds, favoriteIds: new Set(['off:10']), recentIds: new Set(['off:10']) });
  near(sFav - sL, 3, 1e-9, 'favorite +2, recent +1');
  // Same name + brand: de-duplicated, keeping the library copy.
  const ranked = foods.rankFoods('banana', [builtinFood, lib], { localIds });
  assert.deepEqual(ranked.map((f) => f.id), ['off:10']);
});

test('rankFoods: de-duplication by barcode (leading zeros ignored), id, limit, odd input', () => {
  const a = mk('off:0041196910759', 'Progresso soup', { barcode: '0041196910759', pop: 100 });
  const b = mk('usda:555', 'PROGRESSO CHICKEN NOODLE SOUP', { barcode: '041196910759', source: 'usda' });
  const c = mk('off:0041196910759', 'Progresso soup copy', { barcode: null });
  const r = foods.rankFoods('progresso soup', [b, a, c]);
  assert.equal(r.length, 1);
  assert.equal(r[0], a, 'higher-scored barcode twin kept');
  const many = Array.from({ length: 50 }, (_, i) => mk(`off:x${i}`, `Apple ${i}`));
  assert.equal(foods.rankFoods('apple', many).length, 40);
  assert.equal(foods.rankFoods('apple', many, { limit: 5 }).length, 5);
  assert.deepEqual(foods.rankFoods('apple', null), []);
  assert.deepEqual(foods.rankFoods(null, [null, {}, mk('off:z', 'Zed')]).map((f) => f.id), ['off:z']);
});

test('foodFromOFF keeps pop from unique_scans_n', () => {
  const base = { code: '111', product_name: 'Oats', nutriments: { 'energy-kcal_100g': 380, proteins_100g: 13 } };
  assert.equal(foods.foodFromOFF({ ...base, unique_scans_n: 1234 }).pop, 1234);
  assert.equal(foods.foodFromOFF({ ...base, unique_scans_n: '56' }).pop, 56);
  assert.equal(foods.foodFromOFF(base).pop, 0);
});

test('searchLocal: tiny built-in list + library, ranked; odd input never throws', () => {
  const list = [
    mk('usda:1', 'Chicken, breast, skinless, boneless, raw', { source: 'builtin' }),
    mk('usda:2', 'Chicken, thigh, raw', { source: 'builtin' }),
    mk('usda:3', 'Pork, chop, raw', { source: 'builtin' }),
    mk('usda:4', 'Oats', { source: 'builtin' })
  ];
  const library = { 'custom:a': mk('custom:a', 'Chicken breast meal prep', { source: 'custom' }) };
  const r = foods.searchLocal('chicken breast', { library, builtin: list, recents: [], favorites: [] });
  assert.deepEqual(r.map((f) => f.id), ['custom:a', 'usda:1', 'usda:2']);
  assert.ok(!r.some((f) => f.id === 'usda:3'), 'non-matching food excluded');
  assert.deepEqual(foods.searchLocal('oat', { library: [], builtin: list }).map((f) => f.id), ['usda:4']);
  for (const q of ['', ' ', '!!!', '%%%', '((', '"<script>', null, undefined, 123, '\u{1F34C}']) {
    assert.ok(Array.isArray(foods.searchLocal(q, { library, builtin: list, recents: null, favorites: undefined })), `query ${String(q)}`);
  }
  assert.deepEqual(foods.searchLocal('!!!', { library, builtin: list }), []);
  assert.deepEqual(foods.searchLocal('chicken', {}), []);
  assert.deepEqual(foods.searchLocal('chicken'), []);
});

test('effectiveUsdaKey: own key (trimmed) overrides the shared one', () => {
  assert.equal(foods.effectiveUsdaKey({ usdaKey: '  mine  ' }), 'mine');
  assert.equal(foods.effectiveUsdaKey({ usdaKey: '   ' }), String(config.usdaApiKey || '').trim());
  assert.equal(foods.effectiveUsdaKey({}), String(config.usdaApiKey || '').trim());
});

// ---------- network paths with a stubbed fetch (no real requests) ----------
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}
const realFetch = globalThis.fetch;
const jsonRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const usdaItem = (fdcId, description, extra = {}) => ({
  fdcId, description,
  foodNutrients: [{ nutrientNumber: '208', value: 165 }, { nutrientNumber: '203', value: 31 }, { nutrientNumber: '204', value: 3.6 }],
  ...extra
});

await testAsync('loadBuiltinFoods: [] on failure (retries later), converts records, fetches once', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('offline'); };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await builtin.loadBuiltinFoods(), []);
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(builtin.builtinFoods(), []);
  const fixture = {
    version: 1, source: 'test', generated: '2026-10-28',
    foods: [
      { id: 'usda:171077', n: 'Chicken, breast, skinless, boneless, raw', c: 'Poultry', p100: [120, 22.5, 0, 2.6, 0], s: [['1 breast', 174], ['1 oz', 28.35]] },
      { id: 'usda:9', n: 'Water, tap', c: 'Beverages', p100: [0, 0, 0, 0, 0], s: [] },
      { n: 'no id' }
    ]
  };
  let url = '';
  globalThis.fetch = async (u) => { calls++; url = String(u); return jsonRes(fixture); };
  const list = await builtin.loadBuiltinFoods();
  assert.ok(url.endsWith('/data/foods.json'), url);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    id: 'usda:171077', source: 'builtin', barcode: null, name: 'Chicken, breast, skinless, boneless, raw', brand: '',
    category: 'Poultry', per100: { cal: 120, p: 22.5, c: 0, f: 2.6, fiber: 0 },
    servings: [{ label: '1 breast (174 g)', grams: 174 }, { label: '1 oz (28.35 g)', grams: 28.35 }], defaultGrams: 174
  });
  assert.equal(list[1].defaultGrams, 100);
  await builtin.loadBuiltinFoods();
  builtin.preloadBuiltinFoods();
  assert.equal(calls, 2, 'one failed + one successful fetch');
  assert.equal(builtin.builtinFoods(), list);
});

await testAsync('lookupBarcode: USDA Branded fallback matches gtinUpc ignoring leading zeros', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).includes('openfoodfacts')) return jsonRes({ status: 0 }, 404);
    return jsonRes({ foods: [usdaItem(1, 'OTHER', { gtinUpc: '999' }), usdaItem(2, 'RICE NOODLES', { gtinUpc: '00737628064502', brandOwner: 'Thai Kitchen' })] });
  };
  const f = await foods.lookupBarcode('737628064502', { usdaKey: 'k' });
  assert.equal(f.id, 'usda:2');
  assert.equal(f.brand, 'Thai Kitchen');
  const usdaUrl = urls.find((u) => u.includes('api.nal.usda.gov'));
  assert.ok(usdaUrl.includes('dataType=Branded') && usdaUrl.includes('pageSize=5') && usdaUrl.includes('query=737628064502'), usdaUrl);
  urls.length = 0;
  assert.equal(await foods.lookupBarcode('737628064502'), null, 'no key: OFF only');
  assert.ok(urls.every((u) => u.includes('openfoodfacts')));
  // OFF unreachable but USDA has it: found. Neither: the OFF error is thrown.
  globalThis.fetch = async (u) => {
    if (String(u).includes('openfoodfacts')) throw new TypeError('blocked');
    return jsonRes({ foods: [usdaItem(3, 'SOUP', { gtinUpc: '41196910759' })] });
  };
  assert.equal((await foods.lookupBarcode('0041196910759', { usdaKey: 'k' })).id, 'usda:3');
  globalThis.fetch = async (u) => {
    if (String(u).includes('openfoodfacts')) throw new TypeError('blocked');
    return jsonRes({ foods: [] });
  };
  await assert.rejects(foods.lookupBarcode('0041196910759', { usdaKey: 'k' }), /Open Food Facts/);
});

await testAsync('searchFoods: parallel sources, built-in duplicates dropped, failure handling', async () => {
  const off = { products: [{ code: '123', product_name: 'Chicken breast strips', unique_scans_n: 40, nutriments: { 'energy-kcal_100g': 110, proteins_100g: 23 } }] };
  const usda = { foods: [usdaItem(171077, 'Chicken, breast, skinless, boneless, raw'), usdaItem(777, 'Chicken breast, grilled')] };
  let urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    return String(u).includes('openfoodfacts') ? jsonRes(off) : jsonRes(usda);
  };
  const r = await foods.searchFoods('chicken breast', { usdaKey: 'k', region: 'us' });
  assert.deepEqual(r.map((f) => f.id).sort(), ['off:123', 'usda:777'], 'usda:171077 duplicates a built-in food');
  assert.equal(r.find((f) => f.id === 'off:123').pop, 40);
  const uUrl = urls.find((u) => u.includes('api.nal.usda.gov'));
  assert.ok(uUrl.includes('pageSize=25') && uUrl.includes(encodeURIComponent('Foundation,SR Legacy,Branded')), uUrl);
  assert.ok(urls.some((u) => u.startsWith('https://us.openfoodfacts.org/') && u.includes('unique_scans_n')));
  urls = [];
  await foods.searchFoods('chicken breast', { usdaKey: 'k', region: 'us' });
  assert.equal(urls.length, 0, 'session cache');
  // OFF down, USDA works: USDA results, no throw (and not cached, so the next call retries).
  globalThis.fetch = async (u) => {
    if (String(u).includes('openfoodfacts')) return jsonRes({}, 503);
    return jsonRes(usda);
  };
  assert.deepEqual((await foods.searchFoods('grilled chicken', { usdaKey: 'k' })).map((f) => f.id), ['usda:777']);
  urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({}, 503); };
  await assert.rejects(foods.searchFoods('grilled chicken', { usdaKey: 'k' }), /busy or rate-limiting/);
  assert.equal(urls.length, 2, 'partial result was not cached');
  // No key: only OFF; its failure carries the scanning tip.
  urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new TypeError('offline'); };
  await assert.rejects(foods.searchFoods('bananas', {}), /Barcode scanning still works/);
  assert.equal(urls.length, 1);
});
await testAsync('loadPacks: failures never throw (and retry), 404 → zero bundled foods, bundled + user override', async () => {
  store.resetAll();
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    assert.deepEqual(await packs.loadPacks(), []);
    assert.equal(packs.packsLoaded(), false, 'failed load can retry');
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes(null, 404); };
    assert.deepEqual(await packs.loadPacks(), []);
    assert.equal(packs.packsLoaded(), true);
    assert.ok(urls[0].endsWith('/data/packs/index.json'), urls[0]);
    assert.deepEqual(packs.listPacks(), []);
    // The index lists a pack that is present and one that is missing (404).
    const tb = {
      format: 'macrotally-pack/1', id: 'taco-bell', name: 'Taco Bell', brand: 'Taco Bell', generated: '2026-10-28',
      foods: [{ id: '166727', n: 'Burrito Supreme - Beef', cat: 'Burritos', s: ['1 burrito', null], v: [390, 16, 52, 14, 8] }, { id: 'x', n: 'Broken' }]
    };
    urls.length = 0;
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      if (String(u).endsWith('/index.json')) return jsonRes({ packs: ['taco-bell.json', 'missing.json'] });
      if (String(u).endsWith('/taco-bell.json')) return jsonRes(tb);
      return jsonRes(null, 404);
    };
    const list = await packs.loadPacks({ reload: true });
    assert.ok(urls.some((u) => u.endsWith('/data/packs/taco-bell.json')), urls.join(' '));
    assert.deepEqual(list.map((f) => f.id), ['pack:taco-bell:166727']);
    assert.equal(packs.packFoods(), list);
    assert.deepEqual(packs.listPacks(), [{ id: 'taco-bell', name: 'Taco Bell', count: 1, generated: '2026-10-28', bundled: true }]);
    await packs.loadPacks();
    packs.preloadPacks();
    assert.equal(urls.length, 3, 'loads once');
    // A user pack with the same id overrides the bundled one; removing it brings the bundled one back.
    packs.importPack(packText({ id: 'taco-bell', name: 'My Taco Bell' }));
    assert.deepEqual(packs.listPacks().map((p) => [p.name, p.bundled]), [['My Taco Bell', false]]);
    assert.deepEqual(packs.packFoods().map((f) => f.id), ['pack:taco-bell:1', 'pack:taco-bell:2']);
    packs.removePack('taco-bell');
    assert.deepEqual(packs.packFoods().map((f) => f.id), ['pack:taco-bell:166727']);
  } finally {
    console.warn = origWarn;
    store.resetAll();
  }
});
globalThis.fetch = realFetch;

// ---------- charts ----------
test('charts', () => {
  assert.equal(charts.lineChart({ series: [{ points: [], color: 'red' }] }), '<div class="chart-empty">No data yet</div>');
  const svg = charts.lineChart({ series: [{ points: [{ x: 0, y: 80 }, { x: 1, y: 81 }], color: 'var(--p)', dots: true }], xLabels: [{ x: 0, label: 'Jan 1' }] });
  assert.ok(svg.startsWith('<svg class="chart"') && svg.includes('class="grid"') && svg.includes('class="tick"'));
  const bars = charts.barChart({ bars: [{ label: 'M', value: 2000, color: 'var(--accent)' }, { label: 'T', value: 0, color: 'x', muted: true }], line: { value: 1800, color: 'var(--f)', label: 'Target' } });
  assert.ok(bars.includes('<rect') && bars.includes('Target'));
  assert.equal(charts.barChart({ bars: [] }), '<div class="chart-empty">No data yet</div>');
  assert.deepEqual(charts.niceTicks(0, 100), [0, 50, 100]);
  const t = charts.niceTicks(78.3, 82.9);
  assert.ok(t[0] <= 78.3 && t[t.length - 1] >= 82.9);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
