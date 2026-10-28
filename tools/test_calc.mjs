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
