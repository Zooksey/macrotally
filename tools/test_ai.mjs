// MacroTally AI add tests (app side, js/ai.js). Run from the project root: node tools/test_ai.mjs
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
const foods = await import('../js/foods.js');
const ai = await import('../js/ai.js');
const { packFoodToFood } = await import('../js/packs.js');

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
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ±${tol}, got ${a}`);

const item = (o = {}) => ({
  name: "Dot's Homestyle Pretzels, Original",
  brand: "Dot's Pretzels",
  per: 'serving',
  servingGrams: 28,
  servingLabel: '1 oz (28 g)',
  cal: 130,
  p: 2,
  c: 18,
  f: 6,
  fiber: 0.5,
  grams: 71,
  servings: null,
  confidence: 'label',
  source: 'dotspretzels.com',
  notes: '',
  ...o
});

// ---------- state ----------
test('ai defaults and repair', () => {
  store.resetAll();
  assert.deepEqual(store.state.ai, { url: '', secret: '', lastOk: null, lastError: null });
  store.replaceState({ version: 1, diary: {}, ai: { url: 5, secret: 'abc', lastOk: 7, lastError: 'x' } });
  assert.deepEqual(store.state.ai, { url: '', secret: 'abc', lastOk: null, lastError: 'x' });
  store.replaceState({ version: 1, diary: {}, ai: 'nope' });
  assert.deepEqual(store.state.ai, { url: '', secret: '', lastOk: null, lastError: null });
  assert.equal(ai.aiConfigured(store.state), false);
  store.state.ai.url = 'https://ai.example.com';
  assert.equal(ai.aiConfigured(store.state), false);
  store.state.ai.secret = 's3cret-s3cret-s3cret';
  assert.equal(ai.aiConfigured(store.state), true);
  store.resetAll();
});

// ---------- foodFromAiItem ----------
test('foodFromAiItem: per serving with grams scales to per 100 g', () => {
  const f = ai.foodFromAiItem(item());
  assert.equal(f.source, 'custom');
  assert.ok(f.id.startsWith('custom:'));
  assert.equal(f.name, "Dot's Homestyle Pretzels, Original");
  assert.equal(f.brand, "Dot's Pretzels");
  near(f.per100.cal, 464.29, 0.01);
  near(f.per100.f, 21.43, 0.01);
  assert.deepEqual(f.servings, [{ label: '1 oz (28 g)', grams: 28 }]);
  assert.equal(f.defaultGrams, 28);
  assert.equal(f.servingOnly, undefined);
});
test('foodFromAiItem: per serving without grams is servingOnly', () => {
  const f = ai.foodFromAiItem(item({ name: 'Chicken burrito', brand: '', servingGrams: null, servingLabel: '1 burrito', cal: 980, p: 50, c: 100, f: 38, fiber: 12 }));
  assert.equal(f.servingOnly, true);
  assert.deepEqual(f.per100, { cal: 980, p: 50, c: 100, f: 38, fiber: 12 });
  assert.deepEqual(f.servings, [{ label: '1 burrito', grams: 100 }]);
  // A zero serving weight also means unknown (makeCustomFood would throw on 0).
  assert.equal(ai.foodFromAiItem(item({ servingGrams: 0 })).servingOnly, true);
});
test('foodFromAiItem: per 100 g keeps numbers and labels the serving', () => {
  const f = ai.foodFromAiItem(item({ name: 'Banana', brand: '', per: '100g', servingGrams: 118, servingLabel: '1 medium', cal: 89, p: 1.1, c: 22.8, f: 0.3, fiber: 2.6 }));
  assert.deepEqual(f.per100, { cal: 89, p: 1.1, c: 22.8, f: 0.3, fiber: 2.6 });
  assert.deepEqual(f.servings, [{ label: '1 medium (118 g)', grams: 118 }]);
  const bare = ai.foodFromAiItem(item({ per: '100g', servingGrams: null, cal: 50 }));
  assert.deepEqual(bare.servings, []);
  assert.equal(bare.servingOnly, undefined);
  assert.equal(bare.per100.cal, 50);
});

// ---------- amountFromAiItem ----------
test('amountFromAiItem: grams, servings, neither, per-100g without serving', () => {
  const f = ai.foodFromAiItem(item());
  assert.deepEqual(ai.amountFromAiItem(item(), f), { qty: 71, unit: { label: 'g', grams: 1 } });
  const two = ai.amountFromAiItem(item({ grams: null, servings: 2 }), f);
  assert.deepEqual(two, { qty: 2, unit: { label: '1 oz (28 g)', grams: 28 } });
  assert.deepEqual(ai.amountFromAiItem(item({ grams: null, servings: null }), f), { qty: 1, unit: { label: '1 oz (28 g)', grams: 28 } });
  const bare = ai.foodFromAiItem(item({ per: '100g', servingGrams: null }));
  assert.deepEqual(ai.amountFromAiItem(item({ grams: null, servings: null }), bare), { qty: 100, unit: { label: 'g', grams: 1 } });
  // servingOnly: grams are ignored, servings used.
  const so = ai.foodFromAiItem(item({ servingGrams: null, servingLabel: '1 burrito' }));
  assert.deepEqual(ai.amountFromAiItem(item({ grams: 300, servings: 1.5 }), so), { qty: 1.5, unit: { label: '1 burrito', grams: 100 } });
  assert.deepEqual(ai.amountFromAiItem(item({ grams: 300, servings: null }), so), { qty: 1, unit: { label: '1 burrito', grams: 100 } });
  // The entry built from it matches the amount eaten.
  const e = foods.buildEntry(f, 71, { label: 'g', grams: 1 });
  near(e.cal, 329.64, 0.01);
});
test('amountFromAiItem: servings of Claude\'s serving onto a stored food with other servings', () => {
  // Claude: 1 medium banana (118 g). Stored food's first serving is a 225 g cup: use grams, not the cup.
  const stored = { id: 'fdc:b', source: 'builtin', name: 'Bananas, raw', brand: '', per100: { cal: 89, p: 1.1, c: 22.8, f: 0.3, fiber: 2.6 }, servings: [{ label: '1 cup, mashed (225 g)', grams: 225 }, { label: '1 medium (118 g)', grams: 118 }], defaultGrams: 100 };
  const banana = item({ name: 'Banana', brand: '', per: '100g', servingGrams: 118, servingLabel: '1 medium (118 g)', grams: null, servings: 1 });
  assert.deepEqual(ai.amountFromAiItem(banana, stored), { qty: 1, unit: { label: '1 medium (118 g)', grams: 118 } });
  // No stored serving of that weight: grams.
  const cupOnly = { ...stored, servings: [stored.servings[0]] };
  assert.deepEqual(ai.amountFromAiItem({ ...banana, servings: 1.5 }, cupOnly), { qty: 177, unit: { label: 'g', grams: 1 } });
  // Claude's own food keeps its serving unit.
  const own = ai.foodFromAiItem(banana);
  assert.deepEqual(ai.amountFromAiItem(banana, own), { qty: 1, unit: { label: '1 medium (118 g)', grams: 118 } });
});

// ---------- normalizeUrl / confidenceLabel ----------
test('normalizeUrl accepts https and local http', () => {
  assert.equal(ai.normalizeUrl('  https://ai.example.com/  '), 'https://ai.example.com');
  assert.equal(ai.normalizeUrl('https://example.com/macrotally-ai//'), 'https://example.com/macrotally-ai');
  assert.equal(ai.normalizeUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(ai.normalizeUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
});
test('normalizeUrl rejects the rest', () => {
  for (const bad of ['', '   ', 'ai.example.com', 'http://ai.example.com', 'ftp://x.com', 'http://192.168.1.5:8787', 'https://ai.example.com/?x=1', 'javascript:alert(1)']) {
    assert.throws(() => ai.normalizeUrl(bad), Error, bad);
  }
});
test('confidenceLabel', () => {
  assert.equal(ai.confidenceLabel('label'), 'Label');
  assert.equal(ai.confidenceLabel('web'), 'Web');
  assert.equal(ai.confidenceLabel('estimate'), 'Estimate');
  assert.equal(ai.confidenceLabel('???'), 'Estimate');
});
test('aiErrorMessage maps statuses', () => {
  assert.equal(ai.aiErrorMessage(401), 'The helper rejected the secret');
  assert.equal(ai.aiErrorMessage(429), 'The helper is busy, try again in a minute');
  assert.equal(ai.aiErrorMessage(504), 'The helper took too long');
  assert.equal(ai.aiErrorMessage(502), "Claude didn't return a food");
  assert.match(ai.aiErrorMessage(500), /HTTP 500/);
});

// ---------- compareNutrients ----------
const custom = (o) => foods.makeCustomFood({ name: 'X', per: '100g', cal: 400, p: 10, c: 60, f: 12, fiber: 3, ...o });
test('compareNutrients: same within the band', () => {
  const a = custom({ cal: 430, p: 11.4, c: 52, f: 13.5, fiber: 9 }); // kcal +7.5 %, p +1.4 g, c −13 %, f +12.5 %
  const r = ai.compareNutrients(a, custom());
  assert.equal(r.comparable, true);
  assert.equal(r.basis, '100g');
  assert.equal(r.same, true);
  // Fiber is reported but does not break "same".
  assert.deepEqual(r.diffs.map((d) => d.key), ['fiber']);
});
test('compareNutrients: kcal 12 % off is flagged', () => {
  const r = ai.compareNutrients(custom({ cal: 448 }), custom());
  assert.equal(r.same, false);
  assert.deepEqual(r.diffs, [{ key: 'cal', ai: 448, existing: 400 }]);
  // Small macros use the 2 g floor: 1 g vs 2.9 g protein is fine, 1 g vs 3.5 g is not.
  assert.equal(ai.compareNutrients(custom({ p: 1 }), custom({ p: 2.9 })).same, true);
  assert.equal(ai.compareNutrients(custom({ p: 1 }), custom({ p: 3.5 })).same, false);
});
test('compareNutrients: servingOnly vs weighed', () => {
  const so = foods.makeCustomFood({ name: 'Burrito', per: 'serving', servingGrams: null, servingLabel: '1 burrito', cal: 980, p: 50, c: 100, f: 38 });
  // Weighed per-100 g food with no serving: nothing to compare against.
  assert.deepEqual(ai.compareNutrients(so, custom()), { comparable: false });
  assert.deepEqual(ai.compareNutrients(custom(), so), { comparable: false });
  // With a serving, compare one serving of each.
  const withServing = foods.makeCustomFood({ name: 'Burrito', per: 'serving', servingGrams: 400, servingLabel: '1 burrito', cal: 1000, p: 51, c: 99, f: 37 });
  const r = ai.compareNutrients(so, withServing);
  assert.equal(r.comparable, true);
  assert.equal(r.basis, 'serving');
  assert.equal(r.same, true);
  // Both servingOnly: per serving directly.
  const so2 = foods.makeCustomFood({ name: 'Burrito', per: 'serving', servingGrams: null, cal: 700, p: 50, c: 100, f: 38 });
  assert.equal(ai.compareNutrients(so, so2).same, false);
});

// ---------- findExisting ----------
const pack = { id: 'dots', brand: "Dot's Pretzels", name: "Dot's Pretzels" };
const packPretzel = packFoodToFood(pack, { id: 1, n: 'Homestyle Pretzels Original', s: ['1 oz', 28], v: [130, 2, 18, 6, 0.5] });
const libPretzel = foods.makeCustomFood({ name: "Dot's Pretzels, Original (Homestyle Seasoned Pretzel Twists)", brand: "Dot's Pretzels", per: 'serving', servingGrams: 28, servingLabel: '1 oz', cal: 140, p: 2, c: 19, f: 6, fiber: 1 });
const otherBrand = foods.makeCustomFood({ name: 'Homestyle Pretzels Original', brand: 'Snyders', per: 'serving', servingGrams: 28, cal: 110, p: 3, c: 23, f: 1 });
const banana = { id: 'fdc:1', source: 'builtin', name: 'Bananas, raw', brand: '', per100: { cal: 89, p: 1.1, c: 22.8, f: 0.3, fiber: 2.6 }, servings: [], defaultGrams: 100 };

test('findExisting: library match beats pack match', () => {
  const it = item();
  const f = ai.foodFromAiItem(it);
  const r = ai.findExisting(it, f, [packPretzel, libPretzel, banana], { localIds: new Set([libPretzel.id]) });
  assert.ok(r, 'expected a match');
  assert.equal(r.food.id, libPretzel.id);
  assert.equal(r.cmp.comparable, true);
  assert.equal(r.cmp.same, true); // 130 vs 140 kcal per serving is within 10 %
  // Without the library food, the pack food is found.
  const r2 = ai.findExisting(it, f, [packPretzel, banana], { localIds: new Set() });
  assert.equal(r2.food.id, packPretzel.id);
});
test('findExisting: brand mismatch rejected', () => {
  const it = item();
  const r = ai.findExisting(it, ai.foodFromAiItem(it), [otherBrand], { localIds: new Set([otherBrand.id]) });
  assert.equal(r, null);
  // A candidate without a brand is not rejected for it (generic foods).
  const gen = item({ name: 'Banana', brand: '', per: '100g', servingGrams: 118, cal: 89, p: 1.1, c: 22.8, f: 0.3, fiber: 2.6 });
  const rb = ai.findExisting(gen, ai.foodFromAiItem(gen), [banana], { localIds: new Set() });
  assert.equal(rb.food.id, banana.id);
  assert.equal(rb.cmp.same, true);
  // A generic item never matches a branded food from a pack or the built-in list (a Five Guys "Banana" is a
  // milkshake), but it does match a branded food the user saved themselves.
  const fiveGuys = packFoodToFood({ id: 'five-guys', brand: 'Five Guys', name: 'Five Guys' }, { id: 9, n: 'Banana', s: ['1 serving', 100], v: [160, 1, 51, 0.5] });
  assert.equal(ai.findExisting(gen, ai.foodFromAiItem(gen), [fiveGuys], { localIds: new Set() }), null);
  assert.equal(ai.findExisting(gen, ai.foodFromAiItem(gen), [fiveGuys], { localIds: new Set([fiveGuys.id]) }).food.id, fiveGuys.id);
  // With both in the pool, the generic built-in food is found.
  assert.equal(ai.findExisting(gen, ai.foodFromAiItem(gen), [fiveGuys, banana], { localIds: new Set() }).food.id, banana.id);
});
test('findExisting: 60 % token rule', () => {
  // Brand words are dropped from the item's name first. Item: homestyle, original, seasoned, mini, twist;
  // the candidate covers homestyle, original, seasoned = 60 % → match.
  const cand = packFoodToFood(pack, { id: 2, n: 'Homestyle Pretzels Original Seasoned', s: ['1 oz', 28], v: [130, 2, 18, 6, 0.5] });
  const it = item({ name: "Dot's Homestyle Original Seasoned Mini Twists" });
  const r = ai.findExisting(it, ai.foodFromAiItem(it), [cand], { localIds: new Set() });
  assert.ok(r, 'expected a 60 % match');
  // One more unmatched word: 3 of 6 = 50 % → no match.
  const it2 = item({ name: 'Homestyle Original Seasoned Mini Garlic Twists' });
  assert.equal(ai.findExisting(it2, ai.foodFromAiItem(it2), [cand], { localIds: new Set() }), null);
  // Nothing in the pool, or nothing matching at all.
  assert.equal(ai.findExisting(it, ai.foodFromAiItem(it), [], { localIds: new Set() }), null);
  const pizza = item({ name: 'Pepperoni pizza', brand: '' });
  assert.equal(ai.findExisting(pizza, ai.foodFromAiItem(pizza), [packPretzel, banana], { localIds: new Set() }), null);
});
test('findExisting: differences are reported', () => {
  const it = item({ cal: 170 }); // 30 % more kcal than the stored food
  const r = ai.findExisting(it, ai.foodFromAiItem(it), [libPretzel], { localIds: new Set([libPretzel.id]) });
  assert.equal(r.cmp.same, false);
  assert.ok(r.cmp.diffs.some((d) => d.key === 'cal'));
});

const builtin = (id, name, [cal, p, c, f, fiber]) => ({ id, source: 'builtin', name, brand: '', per100: { cal, p, c, f, fiber }, servings: [], defaultGrams: 100 });
const ai100 = (name, cal, p, c, f, o = {}) => ({ name, brand: '', per: '100g', cal, p, c, f, fiber: 0, confidence: 'estimate', ...o });
const find = (it, pool, localIds = new Set()) => ai.findExisting(it, ai.foodFromAiItem(it), pool, { localIds });

test('compareNutrients: far', () => {
  const grapes = builtin('fdc:g', 'Grapes', [69, 0.7, 18.1, 0.2, 0.9]);
  const leaves = builtin('fdc:gl', 'Grape leaves, canned', [69, 4.3, 11.7, 2, 9.9]);
  const r = ai.compareNutrients(grapes, leaves);
  assert.equal(r.far, true); // carb share 0.94 vs 0.57
  assert.equal(r.same, false);
  const raw = builtin('fdc:cr', 'Chicken raw', [106, 22.5, 0, 1.9, 0]);
  const roasted = builtin('fdc:cro', 'Chicken roasted', [165, 31, 0, 3.6, 0]);
  assert.equal(ai.compareNutrients(raw, roasted).far, true); // kcal 36 %
  const musc = builtin('fdc:gm', 'Grapes, muscadine, raw', [57, 0.8, 13.9, 0.5, 3.9]);
  const m = ai.compareNutrients(musc, grapes);
  assert.equal(m.far, false);
  assert.equal(m.same, false);
  const p130 = custom({ cal: 130 });
  const p140 = custom({ cal: 140 });
  assert.equal(ai.compareNutrients(p130, p140).far, false);
});
test('findExisting: head words must be the item\'s', () => {
  const pool = [
    builtin('fdc:gl1', 'Grape leaves, canned', [69, 4.3, 11.7, 2, 9.9]),
    builtin('fdc:gl2', 'Grape leaves, raw', [93, 5.6, 17.3, 2.1, 11]),
    builtin('fdc:gm', 'Grapes, muscadine, raw', [57, 0.8, 13.9, 0.5, 3.9]),
    builtin('fdc:grg', 'Grapes, red or green (European type, such as Thompson seedless), raw', [69, 0.7, 18.1, 0.2, 0.9]),
    builtin('fdc:gj', 'Grape juice, purple, with added vitamin C', [66.1, 0.3, 15.6, 0.3, 0])
  ];
  const r = find(ai100('Grapes', 69, 0.7, 18, 0.2, { fiber: 0.9 }), pool);
  assert.ok(r, 'expected a match');
  assert.equal(r.food.id, 'fdc:grg');
  assert.equal(r.cmp.same, true);
  assert.equal(find(ai100('Grapes', 57, 0.8, 14, 0.5), pool).food.id, 'fdc:gm');
  assert.equal(find(ai100('Grapes', 69, 0.7, 18, 0.2), pool.slice(0, 2)), null);
});
test('findExisting: numbers pick the variant', () => {
  const pool = [
    builtin('fdc:ct', 'Chicken breast tenders, breaded, uncooked', [263, 14.7, 15, 15.8, 0]),
    builtin('fdc:cr', 'Chicken, breast, boneless, skinless, raw', [106, 22.5, 0, 1.9, 0]),
    builtin('fdc:cro', 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', [165, 31, 0, 3.6, 0])
  ];
  const it = ai100('Grilled chicken breast', 165, 31, 0, 3.6);
  const r = find(it, pool);
  assert.equal(r.food.id, 'fdc:cro');
  assert.equal(r.cmp.same, true);
  // Without the roasted food: the raw one (tier 1 beats rejection), flagged far so the UI defaults to Claude's.
  const r2 = find(it, pool.slice(0, 2));
  assert.equal(r2.food.id, 'fdc:cr');
  assert.equal(r2.cmp.far, true);
});
test('findExisting: same numbers forgive a category head word', () => {
  const butter = builtin('fdc:ab', 'Almond butter, creamy', [645, 20.8, 21.2, 53, 10]);
  const nuts = builtin('fdc:na', 'Nuts, almonds', [579, 21.2, 21.6, 49.9, 12.5]);
  const it = ai100('Almonds', 579, 21, 22, 50);
  assert.equal(find(it, [butter, nuts]).food.id, 'fdc:na');
  assert.equal(find(it, [butter]), null);
});
test('findExisting: library food with descriptor words', () => {
  const kirk = foods.makeCustomFood({ name: 'Kirkland Signature Organic Peanut Butter Creamy 28 oz', brand: 'Kirkland Signature', per: '100g', cal: 596, p: 25, c: 21, f: 50 });
  const it = ai100('Kirkland organic peanut butter', 520, 25, 20, 48, { brand: 'Kirkland Signature', confidence: 'web' });
  const r = find(it, [kirk], new Set([kirk.id]));
  assert.ok(r, 'expected the library food (tier 3)');
  assert.equal(r.food.id, kirk.id);
  assert.equal(r.cmp.same, false);
  assert.equal(r.cmp.far, false);
  // Not the user's food: descriptor words and different numbers → no match.
  assert.equal(find(it, [kirk], new Set()), null);
  // A library "Banana bread" is far from a banana.
  const bread = foods.makeCustomFood({ name: 'Banana bread', per: '100g', cal: 326, p: 4.3, c: 54.6, f: 10.5 });
  assert.equal(find(ai100('Banana', 89, 1.1, 22.8, 0.3), [bread], new Set([bread.id])), null);
});

// ---------- askAi / testAi (fetch stubbed) ----------
const realFetch = globalThis.fetch;
await testAsync('askAi posts with the secret, records lastOk / lastError', async () => {
  store.resetAll();
  Object.assign(store.state.ai, { url: 'https://ai.example.com', secret: 'secret-secret-123' });
  const calls = [];
  let reply = () => new Response(JSON.stringify({ items: [item()], model: 'sonnet', seconds: 19.4 }), { status: 200 });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return reply();
  };
  const data = await ai.askAi({ text: "Dot's pretzels, 71g", image: { base64: 'AAAA', mime: 'image/jpeg' } });
  assert.equal(data.items.length, 1);
  assert.equal(calls[0].url, 'https://ai.example.com/v1/food');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer secret-secret-123');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { text: "Dot's pretzels, 71g", image: 'AAAA', mime: 'image/jpeg' });
  assert.ok(store.state.ai.lastOk);
  assert.equal(store.state.ai.lastError, null);

  // Several photos go as images: [{data, mime}]; none at all sends no image fields.
  await ai.askAi({ text: '71g', images: [{ base64: 'AAAA', mime: 'image/jpeg' }, { base64: 'BBBB', mime: 'image/png' }] });
  assert.deepEqual(JSON.parse(calls[1].opts.body), {
    text: '71g',
    images: [{ data: 'AAAA', mime: 'image/jpeg' }, { data: 'BBBB', mime: 'image/png' }]
  });
  await ai.askAi({ text: 'a banana', images: [] });
  assert.deepEqual(JSON.parse(calls[2].opts.body), { text: 'a banana' });
  const five = Array.from({ length: 5 }, () => ({ base64: 'AAAA' }));
  await ai.askAi({ text: '', images: five });
  assert.equal(JSON.parse(calls[3].opts.body).images.length, ai.MAX_AI_PHOTOS);
  assert.equal(JSON.parse(calls[3].opts.body).images[0].mime, 'image/jpeg');

  reply = () => new Response(JSON.stringify({ error: 'bad secret' }), { status: 401 });
  await assert.rejects(ai.askAi({ text: 'x' }), /rejected the secret/);
  assert.equal(store.state.ai.lastError, 'The helper rejected the secret');
  reply = () => new Response(JSON.stringify({ error: 'busy' }), { status: 429 });
  await assert.rejects(ai.askAi({ text: 'x' }), /busy/);
  reply = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(ai.askAi({ text: 'x' }), /Can't reach the helper/);

  // A caller abort is not recorded as an error.
  store.state.ai.lastError = null;
  const ctrl = new AbortController();
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const p = ai.askAi({ text: 'x', signal: ctrl.signal });
  ctrl.abort();
  await assert.rejects(p, (e) => e.cancelled === true);
  assert.equal(store.state.ai.lastError, null);

  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, version: '1.6.0', model: 'sonnet' }), { status: 200 });
  assert.deepEqual(await ai.testAi(), { version: '1.6.0', model: 'sonnet' });
  store.resetAll();
  await assert.rejects(ai.testAi(), /Set up the AI helper/);
});
globalThis.fetch = realFetch;

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
