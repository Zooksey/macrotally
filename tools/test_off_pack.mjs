// Tests for server/off-pack.mjs (Open Food Facts export -> products pack). No network.
// Run from the project root: node tools/test_off_pack.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const op = await import('../server/off-pack.mjs');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

// A header in the export's style: the wanted columns scattered among others.
const HEADER = ['code', 'url', 'product_name', 'x1', 'brands', 'brands_tags', 'countries_tags', 'serving_size',
  'serving_quantity', 'unique_scans_n', 'energy-kcal_100g', 'fat_100g', 'carbohydrates_100g', 'fiber_100g', 'proteins_100g'];
const IDX = Object.fromEntries(HEADER.map((h, i) => [h, i]));
/** A row (array of cells) from an object of named values. */
function row(o) {
  const d = {
    code: '0038000200038', url: 'http://x', product_name: 'Rice Krispies', x1: '', brands: "Kellogg's",
    brands_tags: 'xx:kellogg-s', countries_tags: 'en:united-states', serving_size: '1 1/4 cup (26 g)', serving_quantity: '26',
    unique_scans_n: '8', 'energy-kcal_100g': '375', fat_100g: '0', carbohydrates_100g: '90', fiber_100g: '', proteins_100g: '7.5', ...o
  };
  return HEADER.map((h) => String(d[h] ?? ''));
}
const line = (o) => row(o).join('\t');

// ---------- brandSlug / brandKey ----------
await test('brandKey matches names and OFF tags', () => {
  assert.equal(op.brandSlug("Kellogg's"), 'kelloggs');
  assert.equal(op.brandKey("Kellogg's"), 'kelloggs');
  assert.equal(op.brandKey('xx:kellogg-s'), 'kelloggs');
  assert.equal(op.brandKey('en:kelloggs'), 'kelloggs');
  assert.equal(op.brandKey('Kellogg’s'), 'kelloggs');
  assert.equal(op.brandKey("Miss Vickie's"), op.brandKey('xx:miss-vickie-s'));
  assert.equal(op.brandKey("Miss Vickie's"), 'missvickies');
  assert.equal(op.brandSlug('Häagen-Dazs'), 'haagen-dazs');
  assert.equal(op.brandKey('Häagen-Dazs'), op.brandKey('xx:haagen-dazs'));
  assert.equal(op.brandKey('Nestlé'), 'nestle');
  assert.equal(op.brandKey('  Fairlife '), 'fairlife');
  assert.equal(op.brandKey('!!!'), '');
  assert.notEqual(op.brandKey('Kellogg'), op.brandKey("Kellogg's"));
});

// ---------- rowToFood ----------
await test('rowToFood: serving from serving_quantity', () => {
  const f = op.rowToFood(row({}), IDX);
  assert.equal(f.id, '0038000200038');
  assert.equal(f.bc, '0038000200038');
  assert.equal(f.n, 'Rice Krispies');
  assert.equal(f.b, "Kellogg's");
  assert.deepEqual(f.s, ['1 1/4 cup', 26]);
  assert.deepEqual(f.v, [97.5, 2, 23.4, 0, 0]);
  assert.equal(f.scans, 8);
  assert.ok(f.keys.includes('kelloggs'));
});
await test('rowToFood: no serving -> 100 g', () => {
  for (const sq of ['', '0', '1500', 'abc', '-3']) {
    const f = op.rowToFood(row({ serving_quantity: sq, fiber_100g: '3.333' }), IDX);
    assert.deepEqual(f.s, ['100 g', 100], sq);
    assert.deepEqual(f.v, [375, 7.5, 90, 0, 3.3], sq);
  }
});
await test('rowToFood: serving labels', () => {
  const lab = (serving_size, q = '40') => op.rowToFood(row({ serving_size, serving_quantity: q }), IDX).s[0];
  assert.equal(lab('1 cup (240 ml)', '240'), '1 cup');
  assert.equal(lab('2 tbsp (32 g)', '32'), '2 tbsp');
  assert.equal(lab('40g'), '1 serving');
  assert.equal(lab('28 g (1 oz)', '28'), '1 oz');
  assert.equal(lab(''), '1 serving');
  assert.equal(lab('1   bar  '), '1 bar');
  assert.equal(lab('x'.repeat(41)), '1 serving');
  assert.equal(op.servingLabel('1 ONZ (28 g)'), '1 ONZ');
  assert.equal(op.servingLabel('1/2 cup (121 g) (121 g)'), '1/2 cup');
});
await test('rowToFood: name and brand cleaning', () => {
  const f = op.rowToFood(row({ product_name: '  Frosted \t  Flakes ', brands: ' Kellogg\'s , Kellogg Company', brands_tags: '' }), IDX);
  assert.equal(f.n, 'Frosted Flakes');
  assert.equal(f.b, "Kellogg's");
  assert.equal(op.rowToFood(row({ brands: 'B'.repeat(50) }), IDX).b.length, 40);
  assert.equal(op.rowToFood(row({ brands: '' , brands_tags: '' }), IDX).b, '');
  assert.equal(op.rowToFood(row({ product_name: 'n'.repeat(90) }), IDX).n.length, 90);
  // Stray quotes are data.
  assert.equal(op.rowToFood(row({ product_name: '"Best" "Chips' }), IDX).n, '"Best" "Chips');
});
await test('rowToFood: rejects', () => {
  const bad = [
    { code: '1234567' }, { code: '123456789012345' }, { code: '00380002x0038' }, { code: '' },
    { product_name: '' }, { product_name: '   ' }, { product_name: 'n'.repeat(91) },
    { 'energy-kcal_100g': '' }, { proteins_100g: 'abc' }, { fat_100g: '-1' }, { carbohydrates_100g: '' },
    { 'energy-kcal_100g': '951' }, { proteins_100g: '50', carbohydrates_100g: '50', fat_100g: '6' },
    // all zero, and "0 kcal" with real macros
    { 'energy-kcal_100g': '0', proteins_100g: '0', carbohydrates_100g: '0', fat_100g: '0' },
    { 'energy-kcal_100g': '0', proteins_100g: '0', carbohydrates_100g: '60', fat_100g: '0' }
  ];
  for (const o of bad) assert.equal(op.rowToFood(row(o), IDX), null, JSON.stringify(o));
});
await test('rowToFood: accepts edge cases', () => {
  assert.ok(op.rowToFood(row({ code: '12345678' }), IDX));
  assert.ok(op.rowToFood(row({ code: '12345678901234' }), IDX));
  // 0 kcal with trace carbs (diet soda) is fine; kcal > 0 is kept even when it disagrees with the macros.
  assert.ok(op.rowToFood(row({ 'energy-kcal_100g': '0', proteins_100g: '0', carbohydrates_100g: '0.2', fat_100g: '0' }), IDX));
  assert.ok(op.rowToFood(row({ 'energy-kcal_100g': '231', proteins_100g: '0', carbohydrates_100g: '0', fat_100g: '0' }), IDX));
  assert.ok(op.rowToFood(row({ 'energy-kcal_100g': '950', proteins_100g: '0', carbohydrates_100g: '0', fat_100g: '100' }), IDX));
  assert.equal(op.rowToFood(row({ unique_scans_n: '' }), IDX).scans, 0);
  assert.equal(op.rowToFood(row({ fiber_100g: '-2' }), IDX).v[4], 0);
  // A short row (missing trailing cells) does not throw.
  assert.equal(op.rowToFood(['0038000200038', 'u', 'Name'], IDX), null);
});

// ---------- inCountry ----------
await test('inCountry', () => {
  assert.equal(op.inCountry('3017620425035', 'en:france,en:united-states', 'en:united-states'), false);
  assert.equal(op.inCountry('0038000200038', 'en:canada,en:united-states', 'en:united-states'), true);
  assert.equal(op.inCountry('038000200038', 'en:canada,en:united-states', 'en:united-states'), true);
  assert.equal(op.inCountry('4099100014020', 'en:united-states', 'en:united-states'), true);
  assert.equal(op.inCountry('00614207', 'en:germany,en:united-states', 'en:united-states'), true);
  assert.equal(op.inCountry('20005832', 'en:germany,en:united-states', 'en:united-states'), false);
  assert.equal(op.inCountry('0038000200038', 'en:canada', 'en:united-states'), false);
  assert.equal(op.inCountry('3017620425035', 'en:france,en:germany', 'en:france'), true);
  assert.equal(op.inCountry('3017620425035', 'en:france', ''), true);
});

// ---------- selectPopular / selectBrands ----------
const food = (code, n, b, scans, keys) => ({ id: code, bc: code, n, b, s: ['100 g', 100], v: [1, 1, 1, 1, 0], scans, keys: keys || [op.brandKey(b)] });
await test('selectPopular: top n, de-duplicated, stripped', () => {
  const foods = [
    food('1', 'Cheerios', 'General Mills', 50),
    food('2', 'cheerios', 'General-Mills', 80),
    food('3', 'Cheerios', 'Cheerios', 10),
    food('4', 'Chips', 'Lays', 70),
    food('5', 'Soda', 'X', 0)
  ];
  const out = op.selectPopular(foods, 3);
  assert.deepEqual(out.map((f) => f.id), ['2', '4', '3']);
  assert.deepEqual(Object.keys(out[0]).sort(), ['b', 'bc', 'id', 'n', 's', 'v']);
  assert.equal(op.selectPopular(foods, 10).length, 4);
  assert.equal(foods[0].scans, 50, 'input not mutated');
});
await test('selectBrands: matching by key, per-brand cap, total cap, de-dup', () => {
  const foods = [
    food('k1', 'Rice Krispies', "Kellogg's", 9, ['kelloggs']),
    food('k2', 'Frosted Flakes', 'Kellogg', 7, ['kellogg', 'kelloggs']),
    food('k3', 'Rice Krispies', "Kellogg's", 3, ['kelloggs']),
    food('k4', 'Corn Flakes', '', 5, ['kelloggs']),
    food('f1', 'Fairlife 2%', 'fairlife', 1, ['fairlife']),
    food('f2', 'Core Power', 'Fairlife', 2, ['fairlife']),
    food('z1', 'Other', 'Nope', 100, ['nope'])
  ];
  const all = op.selectBrands(foods, ["Kellogg's", 'Fairlife']);
  assert.deepEqual(all.map((f) => f.id).sort(), ['f1', 'f2', 'k1', 'k2', 'k4']);
  assert.ok(all.every((f) => !('scans' in f) && !('keys' in f)));
  const capped = op.selectBrands(foods, ["Kellogg's", 'Fairlife'], { perBrand: 2 });
  assert.deepEqual(capped.map((f) => f.id), ['k1', 'f2', 'k2', 'f1']);
  // Total cap: brands take turns, so the small brand is not crowded out.
  assert.deepEqual(op.selectBrands(foods, ["Kellogg's", 'Fairlife'], { total: 2 }).map((f) => f.id), ['k1', 'f2']);
  assert.deepEqual(op.selectBrands(foods, []), []);
  assert.deepEqual(op.selectBrands(foods, ['Unknown brand']), []);
  // Falls back to the brand name when a food has no keys.
  assert.equal(op.selectBrands([{ ...food('x', 'A', 'Chobani', 1), keys: undefined }], ['chobani']).length, 1);
});

// ---------- streamExport ----------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mt-offpack-'));
const rows = [
  line({}),
  line({ code: '0016000275263', product_name: 'Cheerios', brands: 'General Mills', brands_tags: 'xx:general-mills' }),
  line({ code: '3017620425035', product_name: 'Nutella "original', countries_tags: 'en:france,en:united-states' }),
  line({ code: '0811620022118', product_name: 'Fairlife "Core" Power', brands: 'fairlife', brands_tags: 'xx:fairlife' }),
  line({ code: '0028400012553', product_name: 'Jalapeño Chips', brands: "Miss Vickie's", brands_tags: 'xx:miss-vickie-s', countries_tags: 'en:canada' })
];
const text = `${HEADER.join('\t')}\n${rows.join('\n')}\n`;
/** A Response whose body arrives in small pieces of the given buffer. */
function chunkedResponse(buf, size = 37) {
  let i = 0;
  const body = new ReadableStream({
    pull(ctrl) {
      if (i >= buf.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(buf.subarray(i, i + size));
      i += size;
    }
  });
  return new Response(body, { status: 200 });
}
await test('streamExport: gzip over fetch, multi-chunk, multi-member, quotes, accents', async () => {
  // Two gzip members, split mid-row and mid-UTF-8 character.
  const raw = Buffer.from(text, 'utf8');
  const cut = raw.indexOf(Buffer.from('ñ', 'utf8')) + 1;
  const gz = Buffer.concat([gzipSync(raw.subarray(0, cut)), gzipSync(raw.subarray(cut))]);
  const seen = [];
  let calledWith = null;
  const out = await op.streamExport({
    url: 'https://example.test/export.csv.gz',
    fetchImpl: async (u, init) => {
      calledWith = { u, ua: init && init.headers && init.headers['User-Agent'] };
      return chunkedResponse(gz);
    },
    onRow: (cols, idx) => {
      assert.equal(cols.length, HEADER.length);
      seen.push(cols[idx.product_name]);
    },
    yieldEvery: 2
  });
  assert.equal(out.rows, 5);
  assert.equal(calledWith.u, 'https://example.test/export.csv.gz');
  assert.match(calledWith.ua, /^MacroTally-helper\//);
  assert.deepEqual(seen, ['Rice Krispies', 'Cheerios', 'Nutella "original', 'Fairlife "Core" Power', 'Jalapeño Chips']);
});
await test('streamExport: lineFilter, async onRow, progress, no trailing newline', async () => {
  const gz = gzipSync(Buffer.from(text.trimEnd(), 'utf8'));
  const seen = [];
  const progress = [];
  const out = await op.streamExport({
    fetchImpl: async () => chunkedResponse(gz, 1000),
    lineFilter: (l) => l.includes('en:united-states'),
    onRow: async (cols, idx) => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(cols[idx.code]);
    },
    onProgress: (n) => progress.push(n),
    progressEvery: 2
  });
  assert.equal(out.rows, 5);
  assert.deepEqual(seen, ['0038000200038', '0016000275263', '3017620425035', '0811620022118']);
  assert.deepEqual(progress, [2, 4]);
});
await test('streamExport: local .csv.gz and .csv files', async () => {
  const gzFile = path.join(tmp, 'e.csv.gz');
  const csvFile = path.join(tmp, 'e.csv');
  writeFileSync(gzFile, gzipSync(Buffer.from(text.replace(/\n/g, '\r\n'), 'utf8')));
  writeFileSync(csvFile, text);
  for (const file of [gzFile, csvFile]) {
    const codes = [];
    const { rows: n } = await op.streamExport({ file, onRow: (cols, idx) => codes.push(cols[idx.code]) });
    assert.equal(n, 5, file);
    assert.equal(codes[4], '0028400012553', file);
  }
});
await test('streamExport: HTTP error and abort', async () => {
  await assert.rejects(op.streamExport({ fetchImpl: async () => new Response('no', { status: 503 }), onRow: () => {} }), /HTTP 503/);
  const ac = new AbortController();
  ac.abort(new Error('stop now'));
  const gz = gzipSync(Buffer.from(text, 'utf8'));
  await assert.rejects(op.streamExport({ fetchImpl: async () => chunkedResponse(gz), onRow: () => {}, signal: ac.signal }), /stop now/);
});

// ---------- end to end + buildPack ----------
await test('rows -> selectBrands -> buildPack', async () => {
  const foods = [];
  await op.streamExport({
    fetchImpl: async () => chunkedResponse(gzipSync(Buffer.from(text, 'utf8')), 64),
    onRow: (cols, idx) => {
      if (!op.inCountry(cols[idx.code], cols[idx.countries_tags], 'en:united-states')) return;
      const f = op.rowToFood(cols, idx);
      if (f) foods.push(f);
    }
  });
  assert.deepEqual(foods.map((f) => f.id), ['0038000200038', '0016000275263', '0811620022118']);
  const sel = op.selectBrands(foods, ["Kellogg's", 'Fairlife', "Miss Vickie's"]);
  assert.deepEqual(sel.map((f) => f.n), ['Rice Krispies', 'Fairlife "Core" Power']);
  const pack = op.buildPack({ id: 'my-brands', name: 'Brands you use', foods: sel, now: Date.UTC(2026, 10, 11, 23) });
  assert.deepEqual(Object.keys(pack), ['format', 'kind', 'id', 'name', 'brand', 'source', 'generated', 'foods']);
  assert.equal(pack.format, 'macrotally-pack/1');
  assert.equal(pack.kind, 'products');
  assert.equal(pack.brand, '');
  assert.equal(pack.generated, '2026-11-11');
  assert.deepEqual(pack.foods[0], { id: '0038000200038', bc: '0038000200038', n: 'Rice Krispies', b: "Kellogg's", s: ['1 1/4 cup', 26], v: [97.5, 2, 23.4, 0, 0] });
  // Transient fields never leak into a pack.
  const p2 = op.buildPack({ id: 'x', name: 'X', foods: [food('1', 'A', 'B', 5)] });
  assert.deepEqual(Object.keys(p2.foods[0]).sort(), ['b', 'bc', 'id', 'n', 's', 'v']);
  JSON.parse(JSON.stringify(pack));
});

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
