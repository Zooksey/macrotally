// MacroTally search tests: typo tolerance, Open Food Facts retry, progressive results, spelling second chance,
// the AI helper's search relay, and product packs vs library / live copies in ranking.
// No network (fetch is stubbed). Run from the project root: node tools/test_search.mjs
import assert from 'node:assert/strict';

// Tiny in-memory localStorage shim (must exist before store.js is imported).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear()
};

const foods = await import('../js/foods.js');

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

const mk = (id, name, extra = {}) => ({
  id, source: 'builtin', barcode: null, name, brand: '',
  per100: { cal: 100, p: 10, c: 10, f: 1, fiber: 0 }, servings: [], defaultGrams: 100, ...extra
});

// ---------- edit distance ----------
test('editDistance: Damerau-Levenshtein (adjacent swap = 1) with early exit', () => {
  const d = foods.editDistance;
  assert.equal(d('kitten', 'sitting'), 3);
  assert.equal(d('abc', 'abc'), 0);
  assert.equal(d('', 'abc'), 3);
  assert.equal(d('abc', ''), 3);
  assert.equal(d('ab', 'ba'), 1, 'transposition');
  assert.equal(d('yogrut', 'yogurt'), 1, 'transposition inside a word');
  assert.equal(d('chiken', 'chicken'), 1, 'insertion');
  assert.equal(d('bananna', 'banana'), 1, 'deletion');
  assert.equal(d('brest', 'breast'), 1);
  assert.equal(d('vickey', 'vicky'), 1);
  assert.equal(d('cat', 'cut'), 1, 'substitution');
  // Over the cap: any number > max (max + 1), both by length difference and by the row minimum.
  assert.equal(d('kitten', 'sitting', 3), 3);
  assert.equal(d('kitten', 'sitting', 2), 3);
  assert.equal(d('a', 'abcdef', 2), 3, 'length difference alone exceeds the cap');
  assert.equal(d('abcdef', 'uvwxyz', 2), 3, 'early exit');
  assert.equal(d('abcdef', 'uvwxyz', 0), 1);
  assert.equal(d('same', 'same', 0), 0);
  assert.equal(d(null, undefined), 0);
});

test('fuzzyLimit: 0 up to 3 letters, 1 for 4-5, 2 for 6+', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 12].map(foods.fuzzyLimit), [0, 0, 0, 0, 1, 1, 2, 2, 2]);
  assert.equal(foods.fuzzyLimit(undefined), 0);
});

// ---------- local search with typos ----------
const pool = [
  mk('b:1', 'Bananas, raw'),
  mk('b:2', 'Banana chips'),
  mk('b:3', 'Chicken, breast, skinless, boneless, raw'),
  mk('b:4', 'Chicken, thigh, raw'),
  mk('b:5', 'Yogurt, plain, whole milk'),
  mk('b:6', 'Yogurt, Greek, plain, nonfat'),
  mk('b:7', 'Egg, whole, raw'),
  mk('b:8', 'Apple, raw'),
  mk('b:9', 'Bread, white'),
  mk('b:10', 'Chickpeas, canned'),
  mk('p:1', 'Grilled Chicken Breast', { source: 'pack', brand: 'Diner' })
];
const ids = (list) => list.map((f) => f.id);
/** The pre-typo-tolerance algorithm: score > 0, then rankFoods with no fuzzy map. */
const exactOnly = (q, list) => ids(foods.rankFoods(q, list.filter((f) => foods.scoreFood(q, f) > 0)));

test('searchLocal: typos find the food ("bananna", "chiken breast", "yogrt")', () => {
  const s = (q) => ids(foods.searchLocal(q, { builtin: pool }));
  const banana = s('bananna');
  assert.ok(['b:1', 'b:2'].includes(banana[0]), `bananna → ${banana}`);
  assert.ok(banana.includes('b:1') && banana.includes('b:2'));
  const cb = s('chiken breast');
  assert.ok(['b:3', 'p:1'].includes(cb[0]), `chiken breast → ${cb}`);
  assert.ok(cb.indexOf('b:3') < cb.indexOf('b:4'), 'breast above thigh');
  assert.ok(!cb.includes('b:10'), 'chickpeas is not a typo match for chiken');
  const yo = s('yogrt');
  assert.deepEqual(yo.slice().sort(), ['b:5', 'b:6']);
  // Without the fuzzy fallback none of these matched every word.
  assert.deepEqual(exactOnly('bananna', pool), []);
  assert.deepEqual(exactOnly('yogrt', pool), []);
});

test('searchLocal: exact queries rank exactly as before (fuzzy path not taken)', () => {
  for (const q of ['chicken', 'chicken breast', 'banana', 'yogurt', 'greek yogurt', 'egg', 'apple raw', 'bread', 'chick']) {
    assert.deepEqual(ids(foods.searchLocal(q, { builtin: pool })), exactOnly(q, pool), q);
  }
  // A fuzzy map for a word the query does not contain changes nothing.
  for (const f of pool) {
    assert.equal(foods.scoreFood('chicken breast', f, { fuzzy: { chiken: ['chicken'] } }), foods.scoreFood('chicken breast', f), f.name);
  }
  assert.equal(foods.fuzzyMap('chicken breast', { builtin: pool }), null, 'every word matches something');
});

test('searchLocal: 3-letter typos are not fuzzy-matched ("egs")', () => {
  assert.equal(foods.fuzzyMap('egs', { builtin: pool }), null);
  assert.deepEqual(ids(foods.searchLocal('egs', { builtin: pool })), []);
});

test('fuzzyMap: closest alternatives, same first letter, library included, new list → new vocabulary', () => {
  assert.deepEqual(foods.fuzzyMap('chiken brest', { builtin: pool }), { chiken: ['chicken'], brest: ['breast'] });
  assert.equal(foods.fuzzyMap('hicken', { builtin: pool }), null, 'first letter must match');
  const more = [...pool, mk('b:11', 'Quinoa, cooked')];
  assert.equal(foods.fuzzyMap('quinao', { builtin: pool }), null);
  assert.deepEqual(foods.fuzzyMap('quinao', { builtin: more }), { quinao: ['quinoa'] });
  const library = { 'custom:1': mk('custom:1', 'Overnight oats', { source: 'custom' }) };
  assert.deepEqual(foods.fuzzyMap('overnigt', { library, builtin: pool }), { overnigt: ['overnight'] });
  assert.deepEqual(ids(foods.searchLocal('overnigt', { library, builtin: pool })), ['custom:1']);
  // Prototype keys are ordinary words (used to throw in the synonym lookup).
  assert.deepEqual(foods.searchLocal('constructor', { builtin: pool }), []);
  assert.deepEqual(foods.searchLocal('toString hasOwnProperty', { builtin: pool }), []);
});

test('scoreFood with a fuzzy map: +2, counts as matched, no phrase bonus; fullyMatches', () => {
  const cb = pool[2];
  const thigh = pool[3];
  const fuzzy = { chiken: ['chicken'] };
  const typo = foods.scoreFood('chiken breast', cb, { fuzzy });
  const exact = foods.scoreFood('chicken breast', cb);
  const partial = foods.scoreFood('chiken breast', cb);
  assert.ok(typo > partial * 2, `full fuzzy ${typo} beats the 0.25 partial ${partial}`);
  assert.ok(typo < exact, `fuzzy ${typo} stays below the exact ${exact}`);
  assert.ok(typo > foods.scoreFood('chiken breast', thigh, { fuzzy }));
  assert.equal(foods.fullyMatches('chiken breast', cb), false);
  assert.equal(foods.fullyMatches('chiken breast', cb, { fuzzy }), true);
  assert.equal(foods.fullyMatches('chicken breast', cb), true);
  assert.equal(foods.fullyMatches('chicken breast', thigh), false);
  assert.equal(foods.fullyMatches('', cb), false);
  // rankFoods passes the map through.
  assert.equal(foods.rankFoods('chiken breast', [thigh, cb], { fuzzy })[0], cb);
  // Odd fuzzy maps are ignored.
  assert.equal(foods.scoreFood('chicken', cb, { fuzzy: { chicken: 'nope' } }), foods.scoreFood('chicken', cb));
});

// ---------- network: retry, progressive results, second chance (stubbed fetch) ----------
const realFetch = globalThis.fetch;
const jsonRes = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const nutr = [{ nutrientNumber: '208', value: 500 }, { nutrientNumber: '203', value: 6 }, { nutrientNumber: '204', value: 30 }, { nutrientNumber: '205', value: 55 }];
const usdaItem = (fdcId, description, extra = {}) => ({ fdcId, description, foodNutrients: nutr, ...extra });
const offProduct = (code, name, extra = {}) => ({ code, product_name: name, nutriments: { 'energy-kcal_100g': 500, proteins_100g: 6 }, ...extra });
const isOff = (u) => u.includes('openfoodfacts');
const param = (u, k) => new URL(u).searchParams.get(k);

await testAsync('OFF search retries once on a network TypeError, then succeeds', async () => {
  const urls = [];
  let n = 0;
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (n++ === 0) throw new TypeError('Failed to fetch');
    return jsonRes({ products: [offProduct('1', 'Apple pie')] });
  };
  const r = await foods.searchFoodsDetailed('apple pie', { retryDelayMs: 0 });
  assert.deepEqual(ids(r.foods), ['off:1']);
  assert.deepEqual(r.failed, []);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], urls[1], 'same request repeated');
});

await testAsync('OFF search retries once on 503 (and 429), after the delay', async () => {
  for (const status of [503, 429]) {
    const urls = [];
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      return urls.length === 1 ? jsonRes({}, status) : jsonRes({ products: [offProduct(`${status}`, 'Peach cobbler')] });
    };
    const t0 = Date.now();
    const r = await foods.searchFoods(`peach cobbler ${status}`, { retryDelayMs: 40 });
    assert.deepEqual(ids(r), [`off:${status}`]);
    assert.equal(urls.length, 2, `${status}: two calls`);
    assert.ok(Date.now() - t0 >= 35, 'waited before retrying');
  }
});

await testAsync('OFF search: no retry on timeout (AbortError) or other statuses; only one retry', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(foods.searchFoods('plum tart', { retryDelayMs: 0 }), /took too long/);
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => { calls++; return jsonRes({}, 500); };
  await assert.rejects(foods.searchFoods('plum tart', { retryDelayMs: 0 }), /HTTP 500/);
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => { calls++; return jsonRes({}, 503); };
  await assert.rejects(foods.searchFoods('plum tart', { retryDelayMs: 0 }), /busy or rate-limiting/);
  assert.equal(calls, 2, 'one retry, then the error');
});

await testAsync('USDA requests are not retried; barcode lookups are not retried', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    return isOff(String(u)) ? jsonRes({ products: [offProduct('9', 'Fig bar')] }) : jsonRes({}, 503);
  };
  const r = await foods.searchFoodsDetailed('fig bar', { usdaKey: 'k', retryDelayMs: 0 });
  assert.deepEqual(ids(r.foods), ['off:9']);
  assert.deepEqual(r.failed, ['usda']);
  assert.equal(urls.filter((u) => !isOff(u)).length, 1);
  urls.length = 0;
  globalThis.fetch = async (u) => { urls.push(String(u)); throw new TypeError('offline'); };
  await assert.rejects(foods.lookupBarcode('737628064502'), /Could not reach Open Food Facts/);
  assert.equal(urls.length, 1, 'one request: the error is not retried');
});

await testAsync('progressive: onPartial gets USDA foods while OFF is still pending; final list merges both', async () => {
  let releaseOff;
  const offGate = new Promise((resolve) => { releaseOff = resolve; });
  globalThis.fetch = async (u) => {
    if (isOff(String(u))) {
      await offGate;
      return jsonRes({ products: [offProduct('20', 'Oat bran cereal')] });
    }
    return jsonRes({ foods: [usdaItem(21, 'Oat bran, raw')] });
  };
  const partials = [];
  const done = foods.searchFoodsDetailed('oat bran', {
    usdaKey: 'k',
    onPartial: (list, info) => partials.push([ids(list), info.source])
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(partials, [[['usda:21'], 'usda']], 'USDA shown before OFF answered');
  releaseOff();
  const r = await done;
  assert.deepEqual(ids(r.foods), ['off:20', 'usda:21']);
  assert.deepEqual(r.failed, []);
  assert.equal(partials.length, 1, 'called once');
  // A failing first source is not reported; a throwing callback does not break the search.
  globalThis.fetch = async (u) => {
    if (!isOff(String(u))) throw new TypeError('offline');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return jsonRes({ products: [offProduct('22', 'Rice cake')] });
  };
  const seen = [];
  const r2 = await foods.searchFoodsDetailed('rice cake', { usdaKey: 'k', onPartial: (l, i) => { seen.push(i.source); throw new Error('render'); } });
  assert.deepEqual(seen, []);
  assert.deepEqual(r2.failed, ['usda']);
  globalThis.fetch = async (u) => (isOff(String(u))
    ? new Promise((resolve) => setTimeout(() => resolve(jsonRes({ products: [] })), 5))
    : jsonRes({ foods: [usdaItem(23, 'Corn cake')] }));
  const r3 = await foods.searchFoodsDetailed('corn cake', { usdaKey: 'k', onPartial: () => { throw new Error('render'); } });
  assert.deepEqual(ids(r3.foods), ['usda:23']);
});

await testAsync('second chance: "vickey" → USDA "vick*" → corrected "vickies" → OFF "vickies"; 4 calls; cached', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    if (isOff(s)) {
      return param(s, 'search_terms') === 'vickies'
        ? jsonRes({ products: [offProduct('0060410017563', "Miss Vickie's Original Recipe Kettle Cooked Potato Chips", { brands: "Miss Vickie's" })] })
        : jsonRes({ products: [] });
    }
    if (param(s, 'query') === 'vick*') {
      return jsonRes({
        foods: [
          usdaItem(31, "MISS VICKIE'S SEA SALT & VINEGAR KETTLE COOKED POTATO CHIPS", { brandOwner: 'Frito-Lay' }),
          usdaItem(32, "MISS VICKIE'S JALAPENO KETTLE COOKED POTATO CHIPS", { brandOwner: 'Frito-Lay' }),
          usdaItem(33, 'VICTORIA MARINARA SAUCE', { brandOwner: 'Victoria Fine Foods' })
        ]
      });
    }
    return jsonRes({ foods: [] });
  };
  const r = await foods.searchFoodsDetailed('vickey', { usdaKey: 'k', retryDelayMs: 0 });
  // Unstemmed, apostrophe dropped: "Vickie's" → "vickies", which tokenizes (stems) to "vicky" exactly like the
  // foods' own names do, so the fuzzy map { vickey: ['vicky'] } makes them full matches. "vickie" would stem to
  // "vickie" and match none of them.
  assert.equal(r.corrected, 'vickies');
  assert.equal(r.correctedQuery, 'vickies');
  assert.deepEqual(r.fuzzy, { vickey: ['vicky'] });
  assert.deepEqual(ids(r.foods).sort(), ['off:0060410017563', 'usda:31', 'usda:32'], 'Victoria dropped (too far from "vickey")');
  assert.equal(urls.length, 4);
  assert.deepEqual(urls.map((u) => (isOff(u) ? `off:${param(u, 'search_terms')}` : `usda:${param(u, 'query')}`)),
    ['off:vickey', 'usda:vickey', 'usda:vick*', 'off:vickies']);
  // The sheet's ranking with the returned map: all three are full matches.
  const ranked = foods.rankFoods('vickey', r.foods, { fuzzy: r.fuzzy });
  assert.equal(ranked.length, 3);
  assert.ok(ranked.every((f) => foods.fullyMatches('vickey', f, { fuzzy: r.fuzzy })));
  urls.length = 0;
  const again = await foods.searchFoodsDetailed('vickey', { usdaKey: 'k' });
  assert.equal(urls.length, 0, 'cached with its correction');
  assert.equal(again.corrected, 'vickies');
});

await testAsync('second chance: other words kept, longest unmatched word replaced; OFF failure ignored (not cached)', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    if (isOff(s)) return param(s, 'search_terms') === 'miss vickies chips' ? jsonRes({}, 503) : jsonRes({ products: [offProduct('41', 'Little Miss Muffin chips')] });
    if (param(s, 'query') === 'miss vick* chips') return jsonRes({ foods: [usdaItem(42, "MISS VICKIE'S SEA SALT POTATO CHIPS")] });
    return jsonRes({ foods: [] });
  };
  const r = await foods.searchFoodsDetailed('Miss Vickey chips', { usdaKey: 'k', retryDelayMs: 0 });
  assert.equal(r.corrected, 'vickies');
  assert.equal(r.correctedQuery, 'miss vickies chips');
  assert.deepEqual(ids(r.foods).sort(), ['off:41', 'usda:42']);
  assert.deepEqual(r.failed, [], 'the extra request is not a failed source');
  assert.equal(urls.length, 5, 'OFF, USDA, USDA wildcard, OFF corrected twice (one retry)');
  urls.length = 0;
  await foods.searchFoodsDetailed('Miss Vickey chips', { usdaKey: 'k', retryDelayMs: 0 });
  assert.equal(urls.length, 5, 'not cached after the failed extra request');
});

await testAsync('no second chance: a full match exists, no USDA key, short words, nothing close, or USDA failed', async () => {
  const urls = [];
  let usdaWild = [];
  let usdaFail = false;
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    if (isOff(s)) return jsonRes({ products: param(s, 'search_terms') === 'pretzel' ? [offProduct('51', 'Pretzel twists')] : [] });
    if (usdaFail) return jsonRes({}, 401);
    return jsonRes({ foods: String(param(s, 'query')).endsWith('*') ? usdaWild : [] });
  };
  let r = await foods.searchFoodsDetailed('pretzel', { usdaKey: 'k' });
  assert.equal(urls.length, 2, 'full match: no extra request');
  assert.equal(r.corrected, null);
  urls.length = 0;
  r = await foods.searchFoodsDetailed('vickey', {});
  assert.equal(urls.length, 1, 'no USDA key: OFF only');
  assert.deepEqual(r.foods, []);
  assert.equal(r.corrected, null);
  urls.length = 0;
  await foods.searchFoodsDetailed('vikc', { usdaKey: 'k' });
  assert.equal(urls.length, 2, 'words under 5 letters get no second chance');
  urls.length = 0;
  usdaWild = [usdaItem(61, 'PRETZELS, HARD')];
  r = await foods.searchFoodsDetailed('przzlex', { usdaKey: 'k' });
  assert.equal(urls.length, 3, 'wildcard tried, nothing close enough, so no OFF retry with a correction');
  assert.equal(r.corrected, null);
  assert.deepEqual(r.foods, []);
  urls.length = 0;
  usdaFail = true;
  await assert.rejects(foods.searchFoodsDetailed('vickeys', { usdaKey: 'k' }), /rejected the request/, 'nothing found and USDA failed: its error');
  assert.equal(urls.length, 2, 'USDA failed: no wildcard request');
});

test('stemming: "-ie" singulars match their plurals (krispie/krispies, cookie/cookies)', () => {
  assert.deepEqual(foods.tokenize('Rice Krispie'), foods.tokenize('rice krispies'));
  assert.deepEqual(foods.tokenize('cookie'), foods.tokenize('Cookies'));
  assert.deepEqual(foods.tokenize('pie'), ['pie'], 'short words are left alone');
  const rk = { id: 'off:1', source: 'off', name: 'Rice Krispies', brand: "Kellogg's", per100: { cal: 380, p: 6, c: 87, f: 1 } };
  const bran = { id: 'usda:2', source: 'builtin', name: 'Rice bran, crude', brand: '', per100: { cal: 316, p: 13, c: 50, f: 21 } };
  assert.equal(foods.fullyMatches('rice krispie', rk), true);
  assert.deepEqual(foods.rankFoods('rice krispie', [bran, rk]).map((f) => f.id), ['off:1', 'usda:2']);
});

test('brandAlias: brands typed by sound are searched under their real spelling', () => {
  assert.equal(foods.brandAlias('rice crispie').query, 'rice krispies');
  assert.equal(foods.brandAlias('Rice Crispy treats').query, 'rice krispies treats');
  assert.equal(foods.brandAlias('rice krispy').query, 'rice krispies');
  assert.equal(foods.brandAlias('cheese its').query, 'cheez it');
  assert.equal(foods.brandAlias('fruit loops').query, 'froot loops');
  assert.equal(foods.brandAlias('rice krispies'), null, 'already spelt right');
  assert.equal(foods.brandAlias('crispy chicken'), null);
  assert.equal(foods.brandAlias('rice'), null);
  const a = foods.brandAlias('rice crispie');
  const rk = { id: 'off:1', source: 'off', name: 'Rice Krispies', brand: "Kellogg's", per100: { cal: 380, p: 6, c: 87, f: 1 } };
  const bar = { id: 'off:2', source: 'off', name: 'Caramelized Crisped Rice Bar', brand: '', per100: { cal: 400, p: 5, c: 70, f: 10 } };
  assert.deepEqual(foods.rankFoods('rice crispie', [bar, rk], { fuzzy: a.fuzzy }).map((f) => f.id), ['off:1', 'off:2']);
});

// ---------- search relay (the AI helper's GET /v1/search), stubbed fetch ----------
const { packFoodToFood } = await import('../js/packs.js');
const RELAY = 'https://relay.example';
const isRelay = (u) => u.startsWith('https://relay') || u.startsWith('https://old');
const relayProduct = (code, name, extra = {}) => ({
  code, product_name: name, brands: 'Acme, Acme Foods',
  nutriments: { 'energy-kcal_100g': 380, proteins_100g: 7, carbohydrates_100g: 84, fat_100g: 1, fiber_100g: 3 },
  unique_scans_n: 900, partial: true, ...extra
});
/** Short label per request: relay:<q>, off:<search_terms>, usda:<query>. */
const label = (u) => {
  if (isRelay(u)) return `relay:${param(u, 'q')}`;
  return isOff(u) ? `off:${param(u, 'search_terms')}` : `usda:${param(u, 'query')}`;
};

await testAsync('relay: success maps products (per 100 g, no servings, first brand) and marks _partial; no Authorization; OFF cgi not called', async () => {
  const calls = [];
  globalThis.fetch = async (u, opts = {}) => {
    calls.push({ u: String(u), opts });
    return jsonRes({ products: [relayProduct('0038000596476', 'Corn Flakes'), { code: '2', product_name: '' }, relayProduct('3', 'Empty', { nutriments: {} })], source: 'search-a-licious', cached: false });
  };
  const r = await foods.searchFoodsDetailed('corn flakes', { region: 'us', relayUrl: `${RELAY}/` });
  assert.deepEqual(calls.map((c) => label(c.u)), ['relay:corn flakes']);
  assert.ok(calls[0].u.startsWith(`${RELAY}/v1/search?`), calls[0].u);
  assert.equal(param(calls[0].u, 'region'), 'us');
  assert.ok(!calls[0].opts.headers || !('Authorization' in calls[0].opts.headers), 'no Authorization header');
  assert.equal(r.foods.length, 1, 'nameless and nutrient-less products dropped');
  const f = r.foods[0];
  assert.equal(f.id, 'off:0038000596476');
  assert.equal(f.barcode, '0038000596476');
  assert.equal(f.source, 'off');
  assert.equal(f.brand, 'Acme');
  assert.equal(f._partial, true);
  assert.deepEqual(f.servings, []);
  assert.equal(f.defaultGrams, 100);
  assert.deepEqual(f.per100, { cal: 380, p: 7, c: 84, f: 1, fiber: 3 });
  assert.equal(f.pop, 900);
  assert.deepEqual(r.failed, []);
  calls.length = 0;
  await foods.searchFoodsDetailed('corn flakes', { region: 'us', relayUrl: RELAY });
  assert.equal(calls.length, 0, 'cached for the session');
});

await testAsync('relay failure (network, 500, 429, bad JSON, timeout-like abort) → legacy cgi search; call order relay then cgi', async () => {
  const failures = {
    network: async () => { throw new TypeError('Failed to fetch'); },
    http500: async () => jsonRes({ error: 'x' }, 500),
    http429: async () => jsonRes({ error: 'rate limited' }, 429),
    http502: async () => jsonRes({ error: 'upstream' }, 502),
    badJson: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }),
    noProducts: async () => jsonRes({ hello: 1 }),
    abort: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  };
  for (const [name, fail] of Object.entries(failures)) {
    const urls = [];
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      return isRelay(String(u)) ? fail() : jsonRes({ products: [offProduct('77', 'Granola bar')] });
    };
    const q = `granola ${name}`;
    const r = await foods.searchFoodsDetailed(q, { relayUrl: RELAY, retryDelayMs: 0 });
    assert.deepEqual(urls.map(label), [`relay:${q}`, `off:${q}`], name);
    assert.deepEqual(ids(r.foods), ['off:77'], name);
    assert.equal(r.foods[0]._partial, undefined, `${name}: cgi foods are full`);
    assert.deepEqual(r.failed, [], name);
  }
  // A non-404 failure does not skip the relay next time.
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({ products: [relayProduct('78', 'Granola clusters')] }); };
  await foods.searchFoodsDetailed('granola clusters', { relayUrl: RELAY });
  assert.deepEqual(urls.map(label), ['relay:granola clusters']);
});

await testAsync('relay fails and cgi is busy: cgi retried ONCE; both failing throws the Open Food Facts error', async () => {
  const urls = [];
  let cgi = 0;
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (isRelay(String(u))) throw new TypeError('offline');
    return ++cgi === 1 ? jsonRes({}, 503) : jsonRes({ products: [offProduct('81', 'Muesli')] });
  };
  const r = await foods.searchFoodsDetailed('muesli', { relayUrl: RELAY, retryDelayMs: 0 });
  assert.deepEqual(urls.map(label), ['relay:muesli', 'off:muesli', 'off:muesli']);
  assert.deepEqual(ids(r.foods), ['off:81']);
  urls.length = 0;
  globalThis.fetch = async (u) => { urls.push(String(u)); return isRelay(String(u)) ? jsonRes({}, 502) : jsonRes({}, 503); };
  await assert.rejects(foods.searchFoodsDetailed('bircher muesli', { relayUrl: RELAY, retryDelayMs: 0 }), /busy or rate-limiting/);
  assert.equal(urls.length, 3, 'relay once, cgi twice');
});

await testAsync('relay 404 / 401 (older helper): cgi used, and the relay is skipped on later searches', async () => {
  for (const [status, base] of [[404, 'https://old404.example'], [401, 'https://old401.example']]) {
    const urls = [];
    globalThis.fetch = async (u) => {
      urls.push(String(u));
      return String(u).startsWith(base) ? jsonRes({ error: 'not found' }, status) : jsonRes({ products: [offProduct(`9${status}`, 'Trail mix')] });
    };
    await foods.searchFoodsDetailed(`trail mix ${status}`, { relayUrl: base });
    assert.deepEqual(urls.map((u) => (u.startsWith(base) ? 'relay' : 'off')), ['relay', 'off'], `${status}: first search`);
    urls.length = 0;
    await foods.searchFoodsDetailed(`nut mix ${status}`, { relayUrl: base });
    assert.deepEqual(urls.map((u) => (u.startsWith(base) ? 'relay' : 'off')), ['off'], `${status}: relay skipped next time`);
  }
  // Another relay address is unaffected.
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({ products: [] }); };
  await foods.searchFoodsDetailed('nut mix other', { relayUrl: 'https://relay2.example' });
  assert.deepEqual(urls.map((u) => (u.startsWith('https://relay2') ? 'relay' : 'off')), ['relay']);
});

await testAsync('no relayUrl (or blank) → legacy cgi only', async () => {
  for (const relayUrl of [undefined, '', '   ']) {
    const urls = [];
    globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({ products: [offProduct('91', 'Rye bread')] }); };
    const r = await foods.searchFoodsDetailed(`rye bread ${String(relayUrl).length}`, relayUrl === undefined ? {} : { relayUrl });
    assert.equal(urls.length, 1);
    assert.ok(isOff(urls[0]) && urls[0].includes('/cgi/search.pl?'), urls[0]);
    assert.deepEqual(ids(r.foods), ['off:91']);
  }
});

await testAsync('second chance through the relay: "vickey" → USDA "vick*" → relay "vickies"; brandAlias searches the relay with the real spelling', async () => {
  const urls = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    if (isRelay(s)) {
      return param(s, 'q') === 'vickies'
        ? jsonRes({ products: [relayProduct('0060410017563', "Miss Vickie's Original Kettle Cooked Potato Chips", { brands: "Miss Vickie's" })] })
        : jsonRes({ products: [] });
    }
    if (param(s, 'query') === 'vick*') return jsonRes({ foods: [usdaItem(131, "MISS VICKIE'S JALAPENO KETTLE COOKED POTATO CHIPS", { brandOwner: 'Frito-Lay' })] });
    return jsonRes({ foods: [] });
  };
  const r = await foods.searchFoodsDetailed('vickey', { usdaKey: 'k2', relayUrl: RELAY, retryDelayMs: 0 });
  assert.deepEqual(urls.map(label), ['relay:vickey', 'usda:vickey', 'usda:vick*', 'relay:vickies']);
  assert.equal(r.corrected, 'vickies');
  assert.deepEqual(ids(r.foods).sort(), ['off:0060410017563', 'usda:131']);
  assert.equal(r.foods.find((f) => f.id === 'off:0060410017563')._partial, true);
  // The corrected search falls back to cgi when the relay fails.
  urls.length = 0;
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    if (isRelay(s)) return param(s, 'q') === 'vickies' ? jsonRes({}, 502) : jsonRes({ products: [] });
    if (isOff(s)) return jsonRes({ products: [offProduct('0060410017564', "Miss Vickie's Sea Salt")] });
    if (param(s, 'query') === 'vick*') return jsonRes({ foods: [usdaItem(132, "MISS VICKIE'S SEA SALT POTATO CHIPS")] });
    return jsonRes({ foods: [] });
  };
  const r2 = await foods.searchFoodsDetailed('vickey', { usdaKey: 'k3', region: 'ca', relayUrl: RELAY, retryDelayMs: 0 });
  assert.deepEqual(urls.map(label), ['relay:vickey', 'usda:vickey', 'usda:vick*', 'relay:vickies', 'off:vickies']);
  assert.deepEqual(ids(r2.foods).sort(), ['off:0060410017564', 'usda:132']);
  // Alias: "rice crispie" is searched as "rice krispies" on the relay.
  urls.length = 0;
  globalThis.fetch = async (u) => { urls.push(String(u)); return jsonRes({ products: [relayProduct('0038000001109', 'Rice Krispies', { brands: "Kellogg's" })] }); };
  const r3 = await foods.searchFoodsDetailed('rice crispie', { relayUrl: RELAY });
  assert.deepEqual(urls.map(label), ['relay:rice krispies']);
  assert.equal(r3.corrected, 'rice krispies');
  assert.equal(foods.rankFoods('rice crispie', r3.foods, { fuzzy: r3.fuzzy })[0].id, 'off:0038000001109');
});

// ---------- product packs vs library vs live copies ----------
const POP = { id: 'off-popular-us', name: 'Popular products (US)', brand: 'Open Food Facts', kind: 'products' };
const packProduct = (id, n, bc, extra = {}) => packFoodToFood(POP, { id, n, b: "Kellogg's", bc, s: ['1 cup (39 g)', 39], v: [150, 2, 34, 0, 1], ...extra });

test('rank: library food > pack product > partial live copy of the same barcode (de-dup keeps one)', () => {
  const pack = packProduct('1', 'Frosted Flakes', '0038000596476');
  const partial = { ...foods.foodFromOFF(relayProduct('0038000596476', 'Frosted Flakes', { brands: "Kellogg's" })), _partial: true };
  const full = foods.foodFromOFF({ ...relayProduct('38000596476', 'Frosted Flakes', { brands: "Kellogg's" }), serving_size: '1 cup (39 g)', unique_scans_n: 1e6 });
  const lib = foods.makeCustomFood({ id: 'off:0038000596476', name: 'Frosted Flakes (mine)', brand: "Kellogg's", barcode: '0038000596476', per: '100g', cal: 380, p: 5, c: 87, f: 0, origin: 'off' });
  const localIds = new Set([lib.id]);
  const q = 'frosted flakes';
  assert.ok(foods.scoreFood(q, partial) > 0 && foods.scoreFood(q, pack) > 0);
  // Partial live copy vs pack copy: the pack copy is kept, whichever scores higher or comes first.
  assert.deepEqual(foods.rankFoods(q, [partial, pack]), [pack]);
  assert.deepEqual(foods.rankFoods(q, [pack, partial]), [pack]);
  // A full live copy with a huge scan count still loses to the pack copy of the same barcode; it beats a partial one.
  assert.deepEqual(foods.rankFoods(q, [full, pack, partial]), [pack]);
  assert.deepEqual(foods.rankFoods(q, [partial, full]), [full]);
  // The library copy wins over all of them.
  assert.deepEqual(foods.rankFoods(q, [partial, pack, full, lib], { localIds }), [lib]);
  // The kept copy takes the best-scored copy's place in the list.
  const other = { ...foods.foodFromOFF(relayProduct('5', 'Frosted Flakes Cereal Bars Strawberry Pack')), _partial: true };
  const ranked = foods.rankFoods(q, [other, partial, pack]);
  assert.deepEqual(ranked.map((f) => f.id), [pack.id, 'off:5']);
});

test('rank: product-pack foods: curated bonus, long names not buried, below the library and above live copies at equal names', () => {
  const q = 'chicken breast';
  const live = (id, name, extra = {}) => ({ id, source: 'off', barcode: null, name, brand: 'Farm', per100: { cal: 120, p: 23, c: 0, f: 2.5, fiber: 0 }, servings: [], defaultGrams: 100, pop: 50, ...extra });
  const prod = packProduct('2', 'Chicken Breast Strips', '0001', { b: 'Farm' });
  const liveSame = live('off:9', 'Chicken Breast Strips');
  assert.ok(foods.scoreFood(q, prod) > foods.scoreFood(q, liveSame), 'product beats an equal live result');
  const lib = live('custom:1', 'Chicken Breast Strips', { source: 'custom' });
  assert.ok(foods.scoreFood(q, lib, { localIds: new Set(['custom:1']) }) > foods.scoreFood(q, prod), 'library beats an equal product');
  // A long product name pays at most 1.5 for its extra words; a live result pays 0.5 each.
  const longName = 'Chicken Breast Boneless Skinless Organic Family Value Pack';
  const longProd = packProduct('3', longName, '0002', { b: 'Farm' });
  const longLive = live('off:10', longName, { pop: 0 });
  assert.ok(foods.scoreFood(q, longProd) - foods.scoreFood(q, longLive) >= 3.5, 'capped penalty');
  // Still ordered by how much of the name the query covers.
  assert.ok(foods.scoreFood(q, prod) > foods.scoreFood(q, longProd));
  // Restaurant-pack foods keep the flat bonus (no per-word cost).
  const menu = packFoodToFood({ id: 'diner', name: 'Diner', brand: 'Diner' }, { id: '1', n: longName, s: ['1 plate', null], v: [500, 40, 20, 20, 2] });
  assert.ok(foods.scoreFood(q, menu) > foods.scoreFood(q, longProd));
});

test('plainFirst: generic searches lead with the everyday built-in food, brand searches are untouched', () => {
  const n = { cal: 100, p: 5, c: 10, f: 3 };
  const b = (id, name) => ({ id: `usda:${id}`, source: 'builtin', name, brand: '', per100: n });
  const prod = (id, name, brand) => ({ id: `pack:p:${id}`, source: 'pack', product: true, barcode: `00000000${id}`, name, brand, per100: n });
  const pool = [
    prod(11, 'Egg', 'Costco'), prod(12, 'Eggs', 'Trader Joes'), prod(13, 'Eggs', 'Members Mark'), prod(14, 'Egg', 'Kirkland'),
    b(1, 'Egg, white, dried'), b(2, 'Egg, whole, raw, fresh'), b(3, 'Egg substitute, powder'), b(4, 'Candies, with egg'),
    prod(15, 'Cheerios', 'General Mills'), b(5, 'Cereals ready-to-eat, GENERAL MILLS, CHEERIOS')
  ];
  const plain = foods.searchLocal('egg', { builtin: pool, plainFirst: true });
  assert.equal(plain[0].name, 'Egg, whole, raw, fresh', 'the everyday form leads');
  assert.equal(plain[1].source, 'pack', 'then the best other result');
  assert.equal(plain[2].source, 'builtin');
  assert.ok(plain.findIndex((f) => f.name === 'Candies, with egg') > 4, 'a food that merely mentions the word is not promoted');
  const off = foods.searchLocal('egg', { builtin: pool });
  assert.equal(off[0].source, 'pack', 'without plainFirst the order is the score order');
  const brand = foods.searchLocal('cheerios', { builtin: pool, plainFirst: true });
  assert.equal(brand[0].name, 'Cheerios', 'a brand search keeps the product first');
  const mine = { id: 'custom:1', source: 'custom', name: 'Egg', brand: 'Mine', per100: n };
  const withLib = foods.searchLocal('egg', { library: [mine], builtin: pool, plainFirst: true });
  assert.equal(withLib[0].id, 'custom:1', "the user's own food stays on top");
  assert.equal(withLib[1].name, 'Egg, whole, raw, fresh');
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
