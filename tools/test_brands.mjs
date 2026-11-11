// MacroTally "Brands you use" tests: brand tracking in addEntry (js/store.js), the brand sync to the AI helper and
// the helper's brand pack (js/brandpack.js, with ETag / 304 and Cache Storage). No network: fetch and caches are
// stubbed. Run from the project root: node tools/test_brands.mjs
import assert from 'node:assert/strict';

// Tiny in-memory localStorage shim (must exist before store.js is imported).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear()
};

// Stub Cache Storage: name → Map(key → { text, headers }).
const cacheData = new Map();
const cachesStub = {
  open: async (name) => {
    if (!cacheData.has(name)) cacheData.set(name, new Map());
    const m = cacheData.get(name);
    return {
      match: async (k) => {
        const e = m.get(String(k));
        return e ? new Response(e.text, { headers: e.headers }) : undefined;
      },
      put: async (k, res) => { m.set(String(k), { text: await res.text(), headers: Object.fromEntries(res.headers) }); },
      delete: async (k) => m.delete(String(k))
    };
  }
};
globalThis.caches = cachesStub;

const store = await import('../js/store.js');
const packs = await import('../js/packs.js');
const bp = await import('../js/brandpack.js');

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

const per100 = { cal: 380, p: 6, c: 84, f: 1, fiber: 3 };
const food = (id, extra = {}) => ({ id, name: `Food ${id}`, brand: '', barcode: null, per100, servings: [], defaultGrams: 100, ...extra });
/** Save the food in the library and log it on a date (as the detail sheet does). */
function log(f, date = '2026-11-01') {
  store.saveFood(f);
  store.addEntry(date, { foodId: f.id, name: f.name, brand: f.brand || '', qty: 1, unit: { label: 'g', grams: 100 }, grams: 100, cal: 1, p: 0, c: 0, f: 0, fiber: 0 });
}

// ---------- brand tracking ----------
test('brandKey: lowercase, apostrophes dropped, punctuation collapsed', () => {
  assert.equal(store.brandKey("Kellogg's"), 'kelloggs');
  assert.equal(store.brandKey('  KELLOGG’S  '), 'kelloggs');
  assert.equal(store.brandKey("Ben & Jerry's"), 'ben jerrys');
  assert.equal(store.brandKey('Frito-Lay,  Inc.'), 'frito lay inc');
  assert.equal(store.brandKey('Nestlé'), 'nestlé');
  assert.equal(store.brandKey('   '), '');
  assert.equal(store.brandKey(null), '');
});

test('addEntry tracks the brand of packaged products only (off, usda, barcode, product pack)', () => {
  store.resetAll();
  let changes = 0;
  const off = store.onBrandsChange(() => { changes++; });
  log(food('off:1', { source: 'off', brand: "Kellogg's", barcode: '1' }));
  log(food('usda:2', { source: 'usda', brand: 'Frito-Lay' }));
  log(food('custom:3', { source: 'custom', brand: 'Grandma Bakery', barcode: '0123456' }));
  log(food('custom:3b', { source: 'custom', brand: 'Fixed Brand', barcode: '555', origin: 'off' }));
  log(food('pack:off-popular-us:4', { source: 'pack', product: true, brand: 'Chobani', barcode: '818290' }));
  log(food('pack:my-brands:4b', { source: 'pack', product: true, brand: 'Oikos' }));
  // Not packaged / no brand:
  log(food('pack:taco-bell:5', { source: 'pack', brand: 'Taco Bell' }));
  log(food('usda:171077', { source: 'builtin', brand: '' }));
  log(food('custom:6', { source: 'custom', brand: 'Home Kitchen' }));
  log(food('custom:7', { source: 'custom', brand: '', barcode: '777' }));
  log(food('usda:8', { source: 'usda', brand: '' }));
  store.addEntry('2026-11-01', { foodId: 'off:not-saved', name: 'X', brand: 'Ghost' });
  assert.deepEqual(Object.keys(store.state.brands).sort(), ['chobani', 'fixed brand', 'frito lay', 'grandma bakery', 'kelloggs', 'oikos']);
  assert.deepEqual(store.state.brands.kelloggs, { name: "Kellogg's", n: 1, last: '2026-11-01' });
  assert.equal(changes, 6, 'listener called once per tracked log');
  off();
  // Counting, last date, nicest casing.
  log(food('off:10', { source: 'off', brand: 'FRITO-LAY', barcode: '10' }), '2026-11-05');
  log(food('off:11', { source: 'off', brand: 'frito-lay', barcode: '11' }), '2026-11-03');
  assert.deepEqual(store.state.brands['frito lay'], { name: 'Frito-Lay', n: 3, last: '2026-11-05' }, 'mixed case kept over capitals / lowercase');
  log(food('off:12', { source: 'off', brand: 'TRADER JOES', barcode: '12' }));
  log(food('off:13', { source: 'off', brand: "Trader Joe's", barcode: '13' }));
  assert.equal(store.state.brands['trader joes'].name, "Trader Joe's", 'capitals upgraded to mixed case');
  // Multi-brand string: the first brand.
  log(food('off:14', { source: 'off', brand: 'Danone, Dannon', barcode: '14' }));
  assert.ok(store.state.brands.danone);
  assert.equal(changes, 6, 'unsubscribed');
  // Saved to storage (and so in backups).
  assert.equal(JSON.parse(store.exportJSON()).brands.kelloggs.n, 1);
});

test('removeBrand: deletes it and blocks re-adding by later logs', () => {
  store.resetAll();
  log(food('off:1', { source: 'off', brand: "Kellogg's", barcode: '1' }));
  let changes = 0;
  const off = store.onBrandsChange(() => { changes++; });
  assert.equal(store.removeBrand('kelloggs'), true);
  assert.equal(store.state.brands.kelloggs, undefined);
  assert.deepEqual(store.state.brandsOff, ['kelloggs']);
  assert.equal(changes, 1);
  log(food('off:2', { source: 'off', brand: 'KELLOGG’S', barcode: '2' }));
  assert.equal(store.state.brands.kelloggs, undefined, 'not re-added');
  assert.equal(changes, 1);
  assert.equal(store.removeBrand('kelloggs'), false, 'already removed');
  // By name too, and a brand never logged is blocked in advance.
  assert.equal(store.removeBrand('Nabisco'), true);
  log(food('off:3', { source: 'off', brand: 'Nabisco', barcode: '3' }));
  assert.equal(store.state.brands.nabisco, undefined);
  assert.equal(store.removeBrand(''), false);
  off();
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(store.STORAGE_KEY)).brandsOff, ['kelloggs', 'nabisco'], 'saved');
});

test('store: brands / brandsOff / brandSync defaults and repair on load; backup keeps the device brandSync', () => {
  store.resetAll();
  assert.deepEqual(store.state.brands, {});
  assert.deepEqual(store.state.brandsOff, []);
  assert.deepEqual(store.state.brandSync, { sent: '', sentAt: null, packCheckedAt: null });
  store.replaceState({
    brands: { x: { name: 'Acme', n: 2, last: '2026-01-01' }, junk: 5, y: { name: '', n: 1 }, z: { name: 'ACME', n: '3', last: '2026-02-01' }, w: { name: 'Zed', n: 0 } },
    brandsOff: ['a', 3, '', 'a'],
    brandSync: { sent: 7, sentAt: 1 }
  });
  assert.deepEqual(store.state.brands, { acme: { name: 'Acme', n: 5, last: '2026-02-01' } });
  assert.deepEqual(store.state.brandsOff, ['a']);
  assert.deepEqual(store.state.brandSync, { sent: '', sentAt: null, packCheckedAt: null });
  store.replaceState({ brands: 'junk', brandsOff: 'junk', brandSync: 'junk' });
  assert.deepEqual(store.state.brands, {});
  assert.deepEqual(store.state.brandsOff, []);
  // Backups carry brands and brandsOff; brandSync is this device's.
  store.resetAll();
  log(food('off:1', { source: 'off', brand: 'Acme', barcode: '1' }));
  store.removeBrand('Nabisco');
  const backup = store.exportJSON();
  store.state.brandSync.sent = '[{"name":"Acme","n":1}]';
  store.importJSON(JSON.stringify({ ...JSON.parse(backup), brandSync: { sent: 'other device', sentAt: null, packCheckedAt: null } }));
  assert.equal(store.state.brands.acme.n, 1);
  assert.deepEqual(store.state.brandsOff, ['nabisco']);
  assert.equal(store.state.brandSync.sent, '[{"name":"Acme","n":1}]');
  store.resetAll();
});

test('saveFood never stores the _partial flag; loading repairs older data', () => {
  store.resetAll();
  const partial = food('off:9', { source: 'off', brand: 'Acme', barcode: '9', _partial: true });
  store.saveFood(partial);
  assert.equal('_partial' in store.state.foods['off:9'], false);
  assert.equal(partial._partial, true, 'the caller’s object is left alone');
  assert.ok(!globalThis.localStorage.getItem(store.STORAGE_KEY).includes('_partial'));
  store.replaceState({ foods: { 'off:9': { ...partial } } });
  assert.equal('_partial' in store.state.foods['off:9'], false);
  store.resetAll();
});

// ---------- brand sync (PUT /v1/brands) ----------
const realFetch = globalThis.fetch;
const res = (status, body = '', headers = {}) => new Response(status === 304 ? null : (typeof body === 'string' ? body : JSON.stringify(body)), { status, headers });
let calls = [];
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (u, opts = {}) => {
    const call = { url: String(u), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body };
    calls.push(call);
    return handler(call);
  };
}
function helperOn() {
  store.state.ai.url = 'https://helper.example';
  store.state.ai.secret = 's3cret';
}

test('brandPayload: top 300 by count (then latest), { name, n } only', () => {
  store.resetAll();
  const brands = {};
  for (let i = 0; i < 320; i++) brands[`b${i}`] = { name: `B${i}`, n: (i % 7) + 1, last: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` };
  store.replaceState({ brands });
  const p = bp.brandPayload();
  assert.equal(p.length, 300);
  assert.deepEqual(Object.keys(p[0]).sort(), ['n', 'name']);
  for (let i = 1; i < p.length; i++) assert.ok(p[i - 1].n >= p[i].n);
  assert.equal(p[0].n, 7);
  assert.deepEqual(bp.brandPayload({ brands: { a: { name: 'A', n: 1 }, b: { name: 'B', n: 3 }, c: { name: 'C', n: 1, last: '2026-02-01' } } }),
    [{ name: 'B', n: 3 }, { name: 'C', n: 1 }, { name: 'A', n: 1 }]);
  store.resetAll();
});

await testAsync('syncBrands: off without the helper; PUT with Bearer and { name, n }; unchanged → no request; failures retried', async () => {
  store.resetAll();
  log(food('off:1', { source: 'off', brand: "Kellogg's", barcode: '1' }));
  stubFetch(() => res(200, { ok: true, count: 1 }));
  assert.equal(await bp.syncBrands(), 'off');
  assert.equal(calls.length, 0, 'no helper secret: no request');
  helperOn();
  assert.equal(await bp.syncBrands(), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://helper.example/v1/brands');
  assert.equal(calls[0].headers.Authorization, 'Bearer s3cret');
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].body), { brands: [{ name: "Kellogg's", n: 1 }] });
  assert.equal(store.state.brandSync.sent, JSON.stringify([{ name: "Kellogg's", n: 1 }]));
  assert.ok(store.state.brandSync.sentAt);
  // Unchanged: nothing sent.
  assert.equal(await bp.syncBrands(), 'unchanged');
  assert.equal(calls.length, 1);
  // A new log changes the list.
  log(food('off:2', { source: 'off', brand: "Kellogg's", barcode: '2' }));
  stubFetch(() => res(500, { error: 'x' }));
  assert.equal(await bp.syncBrands(), 'failed');
  assert.equal(store.state.brandSync.sent, JSON.stringify([{ name: "Kellogg's", n: 1 }]), 'not recorded');
  stubFetch(() => { throw new TypeError('offline'); });
  assert.equal(await bp.syncBrands(), 'failed');
  stubFetch(() => res(404, { error: 'not found' }));
  assert.equal(await bp.syncBrands(), 'failed', 'an older helper: silent');
  stubFetch(() => res(200, { ok: true, count: 1 }));
  assert.equal(await bp.syncBrands(), 'sent', 'retried on the next call');
  assert.deepEqual(JSON.parse(calls[0].body), { brands: [{ name: "Kellogg's", n: 2 }] });
  // Removing the last brand sends the empty list once; nothing tracked and nothing sent: no request.
  store.removeBrand('kelloggs');
  assert.equal(await bp.syncBrands(), 'sent');
  assert.deepEqual(JSON.parse(calls[1].body), { brands: [] });
  store.resetAll();
  helperOn();
  stubFetch(() => res(200, { ok: true, count: 0 }));
  assert.equal(await bp.syncBrands(), 'unchanged');
  assert.equal(calls.length, 0);
  assert.equal(await bp.syncBrands({ force: true }), 'sent');
  store.resetAll();
});

// ---------- brand pack (GET /v1/brand-pack) ----------
const PACK = {
  format: 'macrotally-pack/1', id: 'my-brands', name: 'Brands you use', brand: 'Open Food Facts', kind: 'products', generated: '2026-11-09',
  foods: [
    { id: '0038000596476', n: 'Frosted Flakes', b: "Kellogg's", bc: '0038000596476', s: ['1 cup (39 g)', 39], v: [150, 2, 34, 0, 1] },
    { id: '0038000001109', n: 'Rice Krispies', b: "Kellogg's", bc: '0038000001109', s: ['100 g', 100], v: [380, 6, 87, 1, 0] }
  ]
};
const stored = () => (cacheData.get(bp.DATA_CACHE) || new Map());

await testAsync('refreshBrandPack: 200 stores text + ETag in Cache Storage and shows the pack; 20 h rule; 304 / 404 / 503 / network are no-ops', async () => {
  store.resetAll();
  stubFetch(() => res(200, PACK, { ETag: '"v1"' }));
  assert.equal(await bp.refreshBrandPack(), 'off');
  assert.equal(calls.length, 0, 'no helper: no request');
  helperOn();
  assert.equal(await bp.refreshBrandPack(), 'updated');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://helper.example/v1/brand-pack');
  assert.equal(calls[0].headers.Authorization, 'Bearer s3cret');
  assert.equal(calls[0].headers['If-None-Match'], undefined, 'nothing stored yet');
  assert.deepEqual(bp.brandPackInfo(), { id: 'my-brands', name: 'Brands you use', count: 2, generated: '2026-11-09' });
  assert.equal(packs.packFoodByBarcode('38000596476').id, 'pack:my-brands:0038000596476');
  assert.ok(packs.listPacks().some((p) => p.id === 'my-brands' && p.remote && p.enabled));
  const entry = [...stored().values()][0];
  assert.equal(stored().size, 1);
  assert.equal(JSON.parse(entry.text).id, 'my-brands');
  assert.equal(entry.headers.etag, '"v1"');
  assert.ok(!globalThis.localStorage.getItem(store.STORAGE_KEY).includes('Frosted Flakes'), 'never in localStorage');
  assert.ok(store.state.brandSync.packCheckedAt);
  // Within 20 h: no request.
  assert.equal(await bp.refreshBrandPack(), 'fresh');
  assert.equal(calls.length, 1);
  // Forced: conditional request; 304 keeps the pack.
  stubFetch(() => res(304));
  assert.equal(await bp.refreshBrandPack({ force: true }), 'unchanged');
  assert.equal(calls[0].headers['If-None-Match'], '"v1"');
  assert.equal(bp.brandPackInfo().count, 2);
  // Older than 20 h: checked again without force.
  store.state.brandSync.packCheckedAt = new Date(Date.now() - 21 * 3600 * 1000).toISOString();
  stubFetch(() => res(404, { error: 'no pack yet' }));
  assert.equal(await bp.refreshBrandPack(), 'none');
  assert.equal(calls.length, 1);
  assert.equal(bp.brandPackInfo().count, 2, '404 keeps the stored pack');
  stubFetch(() => res(503, { error: 'no data dir' }));
  assert.equal(await bp.refreshBrandPack({ force: true }), 'failed');
  assert.equal(bp.brandPackInfo().count, 2);
  const checked = store.state.brandSync.packCheckedAt;
  stubFetch(() => { throw new TypeError('offline'); });
  assert.equal(await bp.refreshBrandPack({ force: true }), 'failed');
  assert.equal(store.state.brandSync.packCheckedAt, checked, 'a network error is retried at the next start');
  // An unreadable or foreign pack is ignored; the stored one stays.
  stubFetch(() => res(200, 'not json', { ETag: '"bad"' }));
  assert.equal(await bp.refreshBrandPack({ force: true }), 'failed');
  stubFetch(() => res(200, { ...PACK, id: 'other' }, { ETag: '"bad"' }));
  assert.equal(await bp.refreshBrandPack({ force: true }), 'failed');
  assert.equal(JSON.parse([...stored().values()][0].text).generated, '2026-11-09');
  assert.equal([...stored().values()][0].headers.etag, '"v1"');
  // A new pack replaces it.
  stubFetch(() => res(200, { ...PACK, generated: '2026-11-11', foods: PACK.foods.slice(0, 1) }, { ETag: '"v2"' }));
  assert.equal(await bp.refreshBrandPack({ force: true }), 'updated');
  assert.equal(calls[0].headers['If-None-Match'], '"v1"');
  assert.deepEqual(bp.brandPackInfo(), { id: 'my-brands', name: 'Brands you use', count: 1, generated: '2026-11-11' });
  assert.equal([...stored().values()][0].headers.etag, '"v2"');
});

await testAsync('start-up: the stored pack loads without network; then brand sync, then the pack check; clearBrandPack', async () => {
  // A fresh module instance plays the next app start (packs.js is shared, so clear its copy first).
  packs.setRemotePack('my-brands', null);
  const fresh = await import('../js/brandpack.js?start=1');
  stubFetch(() => { throw new Error('no network allowed'); });
  assert.equal(await fresh.loadStoredBrandPack(), true);
  assert.equal(calls.length, 0, 'no request');
  assert.equal(fresh.brandPackInfo().count, 1);
  // startBrandPack with the helper on: brands first, then the pack (forced by an old check time).
  store.resetAll();
  helperOn();
  log(food('off:1', { source: 'off', brand: 'Acme', barcode: '1' }));
  store.state.brandSync.packCheckedAt = null;
  stubFetch((c) => (c.url.endsWith('/v1/brands') ? res(200, { ok: true, count: 1 }) : res(304)));
  let updates = 0;
  await fresh.startBrandPack({ onUpdate: () => { updates++; } });
  assert.deepEqual(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ['PUT /v1/brands', 'GET /v1/brand-pack']);
  assert.equal(calls[1].headers['If-None-Match'], '"v2"');
  assert.equal(updates, 1, 'stored pack loaded');
  // Without the helper: only the stored copy, no requests.
  store.resetAll();
  calls = [];
  await fresh.startBrandPack();
  assert.equal(calls.length, 0);
  // Erase: the pack leaves packs.js and Cache Storage.
  await fresh.clearBrandPack();
  assert.equal(fresh.brandPackInfo(), null);
  assert.equal(stored().size, 0);
  assert.equal(packs.packFoodByBarcode('38000596476'), null);
});

await testAsync('no Cache API: the pack is kept in memory only (and nothing is stored)', async () => {
  delete globalThis.caches;
  const fresh = await import('../js/brandpack.js?nocache=1');
  store.resetAll();
  helperOn();
  stubFetch(() => res(200, PACK, { ETag: '"m1"' }));
  assert.equal(await fresh.loadStoredBrandPack(), false);
  assert.equal(await fresh.refreshBrandPack({ force: true }), 'updated');
  assert.equal(fresh.brandPackInfo().count, 2);
  stubFetch(() => res(304));
  assert.equal(await fresh.refreshBrandPack({ force: true }), 'unchanged');
  assert.equal(calls[0].headers['If-None-Match'], '"m1"', 'the ETag is remembered in memory');
  assert.ok(!globalThis.localStorage.getItem(store.STORAGE_KEY).includes('Frosted Flakes'));
  await fresh.clearBrandPack();
  globalThis.caches = cachesStub;
  store.resetAll();
});

globalThis.fetch = realFetch;

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
