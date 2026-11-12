// MacroTally AI helper server tests: the pure helpers of server/ai-server.mjs, then the search relay and the
// brand endpoints on a local server with injected upstream fetches and clock (no network; Claude is never called).
// Run from the project root: node tools/test_ai_server.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const srv = await import('../server/ai-server.mjs');
const op = await import('../server/off-pack.mjs');

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
const status = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.status;
  }
  return 'no throw';
};

const ITEM = {
  name: "Dot's Homestyle Pretzels, Original", brand: "Dot's Pretzels", per: 'serving', servingGrams: 28,
  servingLabel: '1 oz (28 g)', cal: 130, p: 2, c: 18, f: 6, fiber: 0.5, grams: 71, servings: null,
  confidence: 'label', source: 'dotspretzels.com', notes: 'Scaled from 28 g.'
};
// Shaped like the real `claude -p --output-format json` result (see SPEC-ai.md section 2).
const cliOut = (structured, extra = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 18465, total_cost_usd: 0.3,
  result: 'done', structured_output: structured, ...extra
});

// ---------- corsHeaders ----------
test('corsHeaders allows a listed origin', () => {
  const h = srv.corsHeaders('http://127.0.0.1:8766', srv.DEFAULT_ORIGINS);
  assert.equal(h['Access-Control-Allow-Origin'], 'http://127.0.0.1:8766');
  assert.equal(h.Vary, 'Origin');
  assert.equal(h['Access-Control-Allow-Methods'], 'GET, POST, PUT, OPTIONS');
  assert.equal(h['Access-Control-Allow-Headers'], 'Authorization, Content-Type, If-None-Match');
  assert.equal(h['Access-Control-Expose-Headers'], 'ETag');
  assert.equal(h['Access-Control-Max-Age'], '86400');
  assert.equal(srv.corsHeaders('https://zooksey.github.io', ['https://zooksey.github.io/'])['Access-Control-Allow-Origin'], 'https://zooksey.github.io');
});
test('corsHeaders denies others', () => {
  for (const o of ['https://evil.example', 'https://zooksey.github.io.evil.example', '', undefined, 'null']) {
    const h = srv.corsHeaders(o, srv.DEFAULT_ORIGINS);
    assert.equal(h['Access-Control-Allow-Origin'], undefined, String(o));
    assert.equal(h.Vary, 'Origin');
  }
});

// ---------- validateBody ----------
test('validateBody accepts text, image, or both', () => {
  assert.deepEqual(srv.validateBody({ text: '  71g of pretzels ' }), { text: '71g of pretzels', images: [] });
  assert.deepEqual(srv.validateBody({ image: 'AAAA', mime: 'image/png' }), { text: '', images: [{ data: 'AAAA', mime: 'image/png' }] });
  assert.deepEqual(srv.validateBody({ text: 'x', image: 'AA\nAA' }), { text: 'x', images: [{ data: 'AAAA', mime: 'image/jpeg' }] });
});
test('validateBody: images list', () => {
  const two = srv.validateBody({ text: 'x', images: [{ data: 'AAAA', mime: 'image/jpeg' }, { data: 'BB\nBB', mime: 'image/png' }] });
  assert.deepEqual(two, { text: 'x', images: [{ data: 'AAAA', mime: 'image/jpeg' }, { data: 'BBBB', mime: 'image/png' }] });
  // mime defaults to jpeg; an empty list with text is just text.
  assert.deepEqual(srv.validateBody({ images: [{ data: 'AAAA' }] }).images, [{ data: 'AAAA', mime: 'image/jpeg' }]);
  assert.deepEqual(srv.validateBody({ text: 'x', images: [] }), { text: 'x', images: [] });
  assert.equal(status(() => srv.validateBody({ images: [] })), 400);
});
test('validateBody: images count limit', () => {
  const pic = { data: 'AAAA', mime: 'image/jpeg' };
  assert.equal(srv.MAX_IMAGES, 4);
  assert.equal(srv.validateBody({ images: [pic, pic, pic, pic] }).images.length, 4);
  assert.equal(status(() => srv.validateBody({ images: [pic, pic, pic, pic, pic] })), 400);
});
test('validateBody: bad images entry', () => {
  const pic = { data: 'AAAA', mime: 'image/jpeg' };
  assert.equal(status(() => srv.validateBody({ images: 'AAAA' })), 400);
  assert.equal(status(() => srv.validateBody({ images: [pic, 'AAAA'] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [pic, null] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [[pic]] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [{ mime: 'image/jpeg' }] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [{ data: 42 }] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [{ data: 'AAAA', mime: 'image/gif' }] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [{ data: 'data:image/jpeg;base64,AAAA' }] })), 400);
  assert.equal(status(() => srv.validateBody({ images: [pic, { data: 'A'.repeat(srv.MAX_IMAGE_CHARS + 4) }] })), 413);
});
test('validateBody: images and image together is a 400', () => {
  const pic = { data: 'AAAA', mime: 'image/jpeg' };
  assert.equal(status(() => srv.validateBody({ images: [pic], image: 'AAAA' })), 400);
  assert.equal(status(() => srv.validateBody({ text: 'x', images: [], image: 'AAAA' })), 400);
  // null / empty shorthand next to a list is not "both".
  assert.equal(srv.validateBody({ images: [pic], image: null, mime: null }).images.length, 1);
  assert.equal(srv.validateBody({ images: [pic], image: '' }).images.length, 1);
});
test('validateBody: missing both', () => {
  assert.equal(status(() => srv.validateBody({})), 400);
  assert.equal(status(() => srv.validateBody({ text: '   ' })), 400);
  assert.equal(status(() => srv.validateBody({ text: '', image: '' })), 400);
  assert.equal(status(() => srv.validateBody(null)), 400);
  assert.equal(status(() => srv.validateBody([1])), 400);
  assert.equal(status(() => srv.validateBody({ text: 5 })), 400);
});
test('validateBody: too long text', () => {
  assert.equal(status(() => srv.validateBody({ text: 'x'.repeat(2000) })), 'no throw');
  assert.equal(status(() => srv.validateBody({ text: 'x'.repeat(2001) })), 400);
});
test('validateBody: bad mime and bad base64', () => {
  assert.equal(status(() => srv.validateBody({ image: 'AAAA', mime: 'image/gif' })), 400);
  assert.equal(status(() => srv.validateBody({ image: 'AAAA', mime: 'text/html' })), 400);
  assert.equal(status(() => srv.validateBody({ image: 'data:image/jpeg;base64,AAAA' })), 400);
  assert.equal(status(() => srv.validateBody({ image: 'AA$A' })), 400);
  assert.equal(status(() => srv.validateBody({ image: 42 })), 400);
});
test('validateBody: oversize base64', () => {
  assert.equal(status(() => srv.validateBody({ image: 'A'.repeat(srv.MAX_IMAGE_CHARS + 4) })), 413);
});

// ---------- parseClaudeOutput ----------
test('parseClaudeOutput: good output', () => {
  const { items } = srv.parseClaudeOutput(cliOut({ items: [ITEM] }));
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], ITEM);
  // Strings are trimmed; zero / bad optional amounts become null; unknown confidence becomes estimate.
  const [b] = srv.parseClaudeOutput(cliOut({ items: [{ ...ITEM, name: '  Banana ', brand: ' ', servingGrams: 0, grams: -5, servings: 'two', confidence: 'guess' }] })).items;
  assert.equal(b.name, 'Banana');
  assert.equal(b.brand, '');
  assert.equal(b.servingGrams, null);
  assert.equal(b.grams, null);
  assert.equal(b.servings, null);
  assert.equal(b.confidence, 'estimate');
  // Stray lines around the JSON are tolerated.
  assert.equal(srv.parseClaudeOutput(`warning: something\n${cliOut({ items: [ITEM] })}\n`).items.length, 1);
});
test('parseClaudeOutput: missing structured_output', () => {
  const e = (() => {
    try {
      srv.parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'I ran out of turns' }));
    } catch (err) {
      return err;
    }
    return null;
  })();
  assert.ok(e);
  assert.equal(e.status, 502);
  assert.equal(e.message, 'no result');
  assert.equal(e.detail, 'error_max_turns');
  assert.equal(status(() => srv.parseClaudeOutput(cliOut({ name: 'not wrapped in items' }))), 502);
  assert.equal(status(() => srv.parseClaudeOutput('')), 502);
  assert.equal(status(() => srv.parseClaudeOutput('not json at all')), 502);
});
test('parseClaudeOutput: bad numbers filtered', () => {
  const bad = [
    { ...ITEM, cal: -1 },
    { ...ITEM, p: 'lots' },
    { ...ITEM, f: Number.NaN },
    { ...ITEM, fiber: null },
    { ...ITEM, per: 'cup' },
    { ...ITEM, name: '   ' },
    'nope',
    null
  ];
  const { items } = srv.parseClaudeOutput(cliOut({ items: [...bad, { ...ITEM, name: 'Good one' }] }));
  assert.deepEqual(items.map((i) => i.name), ['Good one']);
  assert.equal(status(() => srv.parseClaudeOutput(cliOut({ items: bad }))), 502);
  assert.equal(status(() => srv.parseClaudeOutput(cliOut({ items: [] }))), 502);
});
test('parseClaudeOutput: more than 8 items cut', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ ...ITEM, name: `Food ${i}` }));
  const { items } = srv.parseClaudeOutput(cliOut({ items: many }));
  assert.equal(items.length, 8);
  assert.equal(items[7].name, 'Food 7');
});

// ---------- buildArgs / prompt / auth / env ----------
test('buildArgs contains the lockdown flags and never --bare', () => {
  const args = srv.buildArgs({ schemaJson: '{"type":"object"}', systemPath: '/app/system.txt', model: 'sonnet', maxTurns: 10 });
  const val = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('-p'), 'the prompt goes first, outside buildArgs');
  assert.equal(val('--output-format'), 'json');
  assert.equal(val('--json-schema'), '{"type":"object"}');
  assert.equal(val('--model'), 'sonnet');
  assert.equal(val('--max-turns'), '10');
  assert.equal(val('--tools'), 'Read,WebSearch,WebFetch');
  assert.equal(val('--allowedTools'), 'Read,WebSearch,WebFetch');
  assert.equal(val('--permission-mode'), 'dontAsk');
  assert.equal(val('--append-system-prompt-file'), '/app/system.txt');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--safe-mode'));
  // No tool that could touch the machine.
  assert.ok(!args.some((a) => /Bash|Edit|Write/.test(a)));
  // Retailer sites that stall fetches are denied (bare and www), right after --disallowedTools.
  const di = args.indexOf('--disallowedTools');
  assert.ok(di > 0);
  const rules = args.slice(di + 1, args.indexOf('--permission-mode'));
  assert.ok(rules.includes('WebFetch(domain:kroger.com)') && rules.includes('WebFetch(domain:www.kroger.com)'));
  assert.equal(rules.length, srv.BLOCKED_DOMAINS.length * 2);
  assert.ok(rules.every((r) => /^WebFetch\(domain:[a-z0-9.-]+\)$/.test(r)));
});
test('buildPrompt', () => {
  assert.equal(srv.buildPrompt({ text: '71g of these', photoName: 'photo.jpg' }), 'Photo: ./photo.jpg (use Read to look at it).\nUser says: "71g of these"');
  assert.equal(srv.buildPrompt({ text: 'a banana' }), 'User says: "a banana"');
  assert.equal(srv.buildPrompt({ text: '', photoName: 'photo.png' }), 'Photo: ./photo.png (use Read to look at it).');
});
test('buildPrompt with several photos', () => {
  assert.equal(
    srv.buildPrompt({ text: '71g of these', photoNames: ['photo1.jpg', 'photo2.jpg'] }),
    'Photos: ./photo1.jpg, ./photo2.jpg (use Read on each; they show the same food: packaging, nutrition panel, plate).\nUser says: "71g of these"'
  );
  assert.equal(
    srv.buildPrompt({ text: '', photoNames: ['photo1.jpg', 'photo2.png', 'photo3.jpg'] }),
    'Photos: ./photo1.jpg, ./photo2.png, ./photo3.jpg (use Read on each; they show the same food: packaging, nutrition panel, plate).'
  );
  // A one-entry list keeps the single-photo line.
  assert.equal(srv.buildPrompt({ text: '', photoNames: ['photo.jpg'] }), 'Photo: ./photo.jpg (use Read to look at it).');
  assert.equal(srv.buildPrompt({ text: 'a banana', photoNames: [] }), 'User says: "a banana"');
});
test('limits', () => {
  assert.equal(srv.VERSION, '1.8.1');
  assert.equal(srv.MAX_BODY, 12 * 1024 * 1024);
  assert.equal(srv.MAX_IMAGE_CHARS, 4 * 1024 * 1024);
});
test('checkAuth', () => {
  const secret = 'testsecret12345678';
  assert.equal(srv.checkAuth(`Bearer ${secret}`, secret), true);
  assert.equal(srv.checkAuth(`bearer ${secret}`, secret), true);
  assert.equal(srv.checkAuth('Bearer wrong', secret), false);
  assert.equal(srv.checkAuth(secret, secret), false);
  assert.equal(srv.checkAuth(undefined, secret), false);
  assert.equal(srv.checkAuth('Bearer ', ''), false);
});
test('childEnv drops ANTHROPIC_API_KEY and an empty OAuth token', () => {
  const env = srv.childEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-x', CLAUDE_CODE_OAUTH_TOKEN: '' });
  assert.deepEqual(env, { PATH: '/bin' });
  assert.equal(srv.childEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }).CLAUDE_CODE_OAUTH_TOKEN, 'tok');
});
test('resolveClaude: plain claude off Windows, CLAUDE_BIN override', () => {
  assert.deepEqual(srv.resolveClaude('linux', { PATH: '/usr/bin' }), { cmd: 'claude', prefix: [] });
  assert.deepEqual(srv.resolveClaude('win32', { CLAUDE_BIN: 'C:\\x\\claude.exe' }), { cmd: 'C:\\x\\claude.exe', prefix: [] });
  assert.equal(srv.resolveClaude('win32', { PATH: '' }), null);
});
test('readConfig defaults', () => {
  const c = srv.readConfig({ AI_SECRET: 'x'.repeat(16) });
  assert.equal(c.model, 'sonnet');
  assert.equal(c.port, 8787);
  assert.equal(c.timeoutMs, 85000);
  assert.equal(c.maxTurns, 10);
  assert.deepEqual(c.origins, ['https://zooksey.github.io', 'http://localhost:8766', 'http://127.0.0.1:8766']);
  assert.equal(c.dataDir, '/data');
  assert.equal(c.searchRatePerMin, 30);
  assert.equal(c.exportUrl, 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz');
  assert.equal(c.packCountry, 'en:united-states');
  const c2 = srv.readConfig({ DATA_DIR: '/x', SEARCH_RATE_PER_MIN: '5', EXPORT_URL: 'http://e/x.gz', PACK_COUNTRY: '' });
  assert.deepEqual([c2.dataDir, c2.searchRatePerMin, c2.exportUrl, c2.packCountry], ['/x', 5, 'http://e/x.gz', '']);
});

// ---------- search helpers ----------
test('cleanSearchText strips query syntax', () => {
  assert.equal(srv.cleanSearchText('  rice   krispies '), 'rice krispies');
  assert.equal(srv.cleanSearchText("miss vickie's"), "miss vickie's");
  assert.equal(srv.cleanSearchText('countries_tags:"en:france" OR x*'), 'countries_tags en france or x');
  assert.equal(srv.cleanSearchText('-chips +salt (a) [b] {c}'), 'chips salt a b c');
  assert.equal(srv.cleanSearchText('kit-kat m&m'), 'kit-kat m&m');
});
test('searchUrl adds the country filter for a known region', () => {
  const u = new URL(srv.searchUrl('rice krispies', 'us'));
  assert.equal(u.origin + u.pathname, 'https://search.openfoodfacts.org/search');
  assert.equal(u.searchParams.get('q'), 'rice krispies countries_tags:"en:united-states"');
  assert.equal(u.searchParams.get('page_size'), '25');
  assert.equal(u.searchParams.get('langs'), 'en');
  assert.match(u.searchParams.get('fields'), /code,product_name,brands,nutriments/);
  assert.equal(new URL(srv.searchUrl('rice', 'zz')).searchParams.get('q'), 'rice');
  assert.equal(srv.normalizeRegion('US'), 'us');
  assert.equal(srv.normalizeRegion('xx'), '');
});
test('mapSearchHit', () => {
  const h = {
    code: '0038000199929', product_name: ' Rice  Krispies ', brands: ['Kellogg\'s', 'Rice krispies'], unique_scans_n: 5,
    nutriments: { 'energy-kcal_100g': 375, proteins_100g: 7.5, carbohydrates_100g: 87.5, fat_100g: 0, sodium_100g: 0.6 }
  };
  assert.deepEqual(srv.mapSearchHit(h), {
    code: '0038000199929', product_name: 'Rice Krispies', brands: "Kellogg's, Rice krispies",
    nutriments: { 'energy-kcal_100g': 375, proteins_100g: 7.5, carbohydrates_100g: 87.5, fat_100g: 0 },
    unique_scans_n: 5, partial: true
  });
  assert.equal(srv.mapSearchHit({ code: '1', product_name: 'x', brands: 'A, B' }).brands, 'A, B');
  assert.equal(srv.mapSearchHit({ code: '1', product_name: 'x' }).unique_scans_n, 0);
  assert.equal(srv.mapSearchHit({ code: '1' }), null);
  assert.equal(srv.mapSearchHit({ product_name: 'x' }), null);
  assert.equal(srv.mapSearchHit(null), null);
});
test('validateBrands', () => {
  assert.deepEqual(srv.validateBrands({ brands: [{ name: "Kellogg's", n: 3 }, { name: 'kelloggs', n: 9 }, { name: ' Fairlife ', n: 1 }, { name: '!!' }] }),
    [{ name: "Kellogg's", n: 9 }, { name: 'Fairlife', n: 1 }]);
  assert.deepEqual(srv.validateBrands({ brands: [] }), []);
  assert.equal(status(() => srv.validateBrands({})), 400);
  assert.equal(status(() => srv.validateBrands([])), 400);
  assert.equal(status(() => srv.validateBrands({ brands: [{ name: 5 }] })), 400);
  assert.equal(status(() => srv.validateBrands({ brands: [{ name: 'x'.repeat(61) }] })), 400);
  assert.equal(status(() => srv.validateBrands({ brands: [{ name: '  ' }] })), 400);
  assert.equal(status(() => srv.validateBrands({ brands: [{ name: 'a', n: -1 }] })), 400);
  assert.equal(status(() => srv.validateBrands({ brands: [{ name: 'a', n: '3' }] })), 400);
  assert.equal(status(() => srv.validateBrands({ brands: Array.from({ length: 301 }, (_, i) => ({ name: `b${i}` })) })), 400);
  assert.equal(srv.validateBrands({ brands: Array.from({ length: 300 }, (_, i) => ({ name: `b${i}` })) }).length, 300);
});
test('shouldBuild rules', () => {
  const H = 3600 * 1000;
  const now = Date.UTC(2026, 10, 11, 12);
  const brands = [{ name: "Kellogg's", n: 3 }];
  const fresh = { generated: '2026-11-11', builtAt: new Date(now - H).toISOString(), brands: ['kelloggs'] };
  const index = { count: 10, builtAt: new Date(now - H).toISOString() };
  const base = { brands, building: false, pack: fresh, index, lastAttempt: now - H, lastBuildError: null, now };
  assert.equal(srv.shouldBuild(base), false);
  assert.equal(srv.shouldBuild({ ...base, brands: [] }), false);
  assert.equal(srv.shouldBuild({ ...base, pack: null }), true);
  assert.equal(srv.shouldBuild({ ...base, pack: null, building: true }), false);
  // Brand set changed: only after 20 h since the last attempt.
  const changed = { ...base, brands: [...brands, { name: 'Fairlife', n: 1 }] };
  assert.equal(srv.shouldBuild(changed), false);
  assert.equal(srv.shouldBuild({ ...changed, lastAttempt: now - 21 * H }), true);
  // Older than 7 days.
  assert.equal(srv.shouldBuild({ ...base, pack: { ...fresh, builtAt: new Date(now - 8 * 24 * H).toISOString() }, lastAttempt: now - 8 * 24 * H }), true);
  assert.equal(srv.shouldBuild({ ...base, pack: { generated: '2026-11-01', brands: ["Kellogg's"] } }), true);
  // A recent failure backs off 6 h even with no pack.
  assert.equal(srv.shouldBuild({ ...base, pack: null, lastBuildError: 'boom', lastAttempt: now - H }), false);
  assert.equal(srv.shouldBuild({ ...base, pack: null, lastBuildError: 'boom', lastAttempt: now - 7 * H }), true);
  assert.equal(srv.sameBrandSet([{ name: "Kellogg's" }], ['kelloggs']), true);
  assert.equal(srv.sameBrandSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(srv.sameBrandSet(['a'], ['a', 'b']), false);
});
test('shouldBuild: servings index rules', () => {
  const H = 3600 * 1000;
  const now = Date.UTC(2026, 10, 11, 12);
  const fresh = { generated: '2026-11-11', builtAt: new Date(now - H).toISOString(), brands: ['kelloggs'] };
  const index = { count: 10, builtAt: new Date(now - H).toISOString() };
  const base = { brands: [{ name: "Kellogg's", n: 3 }], building: false, pack: fresh, index, lastAttempt: now - H, lastBuildError: null, now };
  // No index (null, missing or unreadable builtAt): due, with or without brands.
  assert.equal(srv.shouldBuild({ ...base, index: null }), true);
  assert.equal(srv.shouldBuild({ ...base, index: undefined }), true);
  assert.equal(srv.shouldBuild({ ...base, index: { count: 3 } }), true);
  assert.equal(srv.shouldBuild({ ...base, brands: [], pack: null, index: null }), true);
  assert.equal(srv.shouldBuild({ ...base, brands: undefined, pack: null, index: null }), true);
  // Fresh index, no brands: nothing to do.
  assert.equal(srv.shouldBuild({ ...base, brands: [], pack: null }), false);
  // Older than 7 days: due, even with no brands; 6 days is fine.
  const old = { count: 10, builtAt: new Date(now - 8 * 24 * H).toISOString() };
  assert.equal(srv.shouldBuild({ ...base, brands: [], index: old }), true);
  assert.equal(srv.shouldBuild({ ...base, index: old }), true);
  assert.equal(srv.shouldBuild({ ...base, brands: [], index: { count: 1, builtAt: new Date(now - 6 * 24 * H).toISOString() } }), false);
  // Not while building; a recent failure backs off 6 h.
  assert.equal(srv.shouldBuild({ ...base, index: null, building: true }), false);
  assert.equal(srv.shouldBuild({ ...base, brands: [], index: null, lastBuildError: 'boom', lastAttempt: now - H }), false);
  assert.equal(srv.shouldBuild({ ...base, brands: [], index: null, lastBuildError: 'boom', lastAttempt: now - 7 * H }), true);
});
test('withServings: adds serving data from the index, copies, leaves others alone', () => {
  const c = op.createServingCollector();
  c.add('0038000199929', 28);
  c.add('5000000000017', 28.35);
  const idx = c.finish();
  const a = { code: '0038000199929', product_name: 'Rice Krispies', partial: true };
  const b = { code: '38000199929', product_name: 'Same code, no leading zeros', partial: true };
  const d = { code: '5000000000017', product_name: 'Fraction', partial: true };
  const e = { code: '0000000000000', product_name: 'Not in index', partial: true };
  const out = srv.withServings([a, b, d, e], idx);
  assert.deepEqual(out[0], { ...a, serving_size: '28 g', serving_quantity: 28 });
  assert.deepEqual(out[1], { ...b, serving_size: '28 g', serving_quantity: 28 });
  assert.deepEqual(out[2], { ...d, serving_size: '28.4 g', serving_quantity: 28.4 });
  assert.equal(out[3], e);
  assert.equal(out[0].partial, true);
  assert.equal(a.serving_size, undefined, 'input not mutated');
  const list = [a];
  assert.equal(srv.withServings(list, null), list);
});

// ---------- HTTP: search relay and brand endpoints ----------
let apassed = 0;
async function atest(name, fn) {
  try {
    await fn();
    apassed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}
const SECRET = 'test-secret-0123456789';
const AUTH = { Authorization: `Bearer ${SECRET}` };
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'mt-srv-'));
let tmpN = 0;
const freshDir = () => path.join(tmpRoot, `data${++tmpN}`);

/** Start a server on a free port; run fn(base, server); close it. */
async function withServer({ cfg = {}, fetchImpl, clock } = {}, fn) {
  const server = srv.createServer({ ...srv.readConfig({ AI_SECRET: SECRET }), dataDir: freshDir(), ...cfg }, {
    fetchImpl, now: clock ? () => clock.t : Date.now, log: () => {}
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
const HITS = {
  hits: [
    { code: '0038000199929', product_name: 'Rice Krispies', brands: ["Kellogg's"], unique_scans_n: 5, nutriments: { 'energy-kcal_100g': 375, proteins_100g: 7.5, carbohydrates_100g: 87.5, fat_100g: 0 } },
    { code: '2030606199943', product_name: 'rice krispies', countries_tags: ['en:united-states'] },
    { code: '123', brands: ['No name'] },
    { product_name: 'No code' }
  ]
};
function fakeSearch() {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ q: u.searchParams.get('q'), ua: init && init.headers && init.headers['User-Agent'] });
    if (u.searchParams.get('q').includes('broken')) return new Response('Service Unavailable', { status: 503 });
    if (u.searchParams.get('q').includes('garbage')) return new Response('<html>', { status: 200 });
    return Response.json(HITS);
  };
  fn.calls = calls;
  return fn;
}

await atest('GET /v1/search: no auth, shape mapping, cache hit, Cache-Control', async () => {
  const f = fakeSearch();
  await withServer({ fetchImpl: f }, async (base) => {
    const r = await fetch(`${base}/v1/search?q=${encodeURIComponent(' Rice Krispies ')}&region=us`, { headers: { Origin: 'http://localhost:8766' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(r.headers.get('access-control-allow-origin'), 'http://localhost:8766');
    const j = await r.json();
    assert.equal(j.source, 'search-a-licious');
    assert.equal(j.cached, false);
    assert.equal(j.products.length, 2);
    assert.deepEqual(j.products[0], {
      code: '0038000199929', product_name: 'Rice Krispies', brands: "Kellogg's",
      nutriments: { 'energy-kcal_100g': 375, proteins_100g: 7.5, carbohydrates_100g: 87.5, fat_100g: 0 }, unique_scans_n: 5, partial: true
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].q, 'Rice Krispies countries_tags:"en:united-states"');
    assert.match(f.calls[0].ua, /^MacroTally-helper\//);
    // Same query (any case) and region: served from the cache.
    const j2 = await (await fetch(`${base}/v1/search?q=rice%20krispies&region=US`)).json();
    assert.equal(j2.cached, true);
    assert.deepEqual(j2.products, j.products);
    assert.equal(f.calls.length, 1);
    // Another region is another cache entry.
    assert.equal((await (await fetch(`${base}/v1/search?q=rice%20krispies`)).json()).cached, false);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].q, 'rice krispies');
  });
});
await atest('GET /v1/search: cache expires after 6 h', async () => {
  const f = fakeSearch();
  const clock = { t: Date.UTC(2026, 10, 11) };
  await withServer({ fetchImpl: f, clock }, async (base) => {
    await fetch(`${base}/v1/search?q=oats`);
    clock.t += 5 * 3600 * 1000;
    assert.equal((await (await fetch(`${base}/v1/search?q=oats`)).json()).cached, true);
    clock.t += 2 * 3600 * 1000;
    assert.equal((await (await fetch(`${base}/v1/search?q=oats`)).json()).cached, false);
  });
});
await atest('GET /v1/search: 400 bad query', async () => {
  const f = fakeSearch();
  await withServer({ fetchImpl: f }, async (base) => {
    for (const q of ['', 'a', '  b  ', 'x'.repeat(101), '::', '""']) {
      const r = await fetch(`${base}/v1/search?q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 400, JSON.stringify(q));
      assert.deepEqual(await r.json(), { error: 'bad query' });
    }
    assert.equal((await fetch(`${base}/v1/search`)).status, 400);
    assert.equal((await fetch(`${base}/v1/search?q=${'x'.repeat(100)}`)).status, 200);
    assert.equal(f.calls.length, 1);
  });
});
await atest('GET /v1/search: per-IP 429, window slides, global cap', async () => {
  const f = fakeSearch();
  const clock = { t: Date.UTC(2026, 10, 11) };
  await withServer({ fetchImpl: f, clock, cfg: { searchRatePerMin: 3, searchGlobalPerMin: 5 } }, async (base) => {
    const get = (q, ip) => fetch(`${base}/v1/search?q=${q}`, { headers: { 'CF-Connecting-IP': ip } });
    for (let i = 0; i < 3; i++) assert.equal((await get('milk', '1.1.1.1')).status, 200);
    const r = await get('milk', '1.1.1.1');
    assert.equal(r.status, 429);
    assert.deepEqual(await r.json(), { error: 'rate limited' });
    // Another IP (x-forwarded-for first entry) is not affected.
    const x = await fetch(`${base}/v1/search?q=milk`, { headers: { 'X-Forwarded-For': '2.2.2.2, 10.0.0.1' } });
    assert.equal(x.status, 200);
    clock.t += 61 * 1000;
    assert.equal((await get('milk', '1.1.1.1')).status, 200);
    // Global cap counts upstream calls (cache misses): 5 per minute.
    clock.t += 61 * 1000;
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await get(`q${i}x`, `9.9.9.${i}`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  });
});
await atest('GET /v1/search: upstream failure -> 502, not cached', async () => {
  const f = fakeSearch();
  await withServer({ fetchImpl: f }, async (base) => {
    for (const q of ['broken', 'garbage']) {
      const r = await fetch(`${base}/v1/search?q=${q}`);
      assert.equal(r.status, 502, q);
      assert.deepEqual(await r.json(), { error: 'upstream' });
    }
    assert.equal((await fetch(`${base}/v1/search?q=broken`)).status, 502);
    assert.equal(f.calls.length, 3);
  });
  await withServer({ fetchImpl: async () => { throw new Error('ECONNRESET'); } }, async (base) => {
    assert.equal((await fetch(`${base}/v1/search?q=milk`)).status, 502);
  });
});

// A small export: header + rows (US Kellogg's, a French Kellogg's with a stray US tag, Fairlife, Chobani, Canada-only).
const XH = ['code', 'product_name', 'brands', 'brands_tags', 'countries_tags', 'serving_size', 'serving_quantity',
  'unique_scans_n', 'energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g', 'fiber_100g'];
const xrow = (code, name, brands, tags, countries, scans) => [code, name, brands, tags, countries, '1 cup (30 g)', '30', scans, '380', '7', '85', '1', '2'].join('\t');
const EXPORT_TEXT = [
  XH.join('\t'),
  xrow('0038000200038', 'Rice Krispies', "Kellogg's", 'xx:kellogg-s', 'en:united-states', '8'),
  xrow('0038000001234', 'Frosted "Flakes', "Kellogg's", 'xx:kellogg-s', 'en:canada,en:united-states', '20'),
  xrow('5050083000000', 'Corn Flakes (FR)', "Kellogg's", 'xx:kellogg-s', 'en:france,en:united-states', '99'),
  xrow('0811620022118', 'Core Power', 'fairlife', 'xx:fairlife', 'en:united-states', '3'),
  xrow('0894700010137', 'Greek Yogurt', 'Chobani', 'xx:chobani', 'en:united-states', '50'),
  xrow('0064100000000', 'Rice Krispies CA', "Kellogg's", 'xx:kellogg-s', 'en:canada', '70')
].join('\n') + '\n';
const EXPORT_GZ = gzipSync(Buffer.from(EXPORT_TEXT, 'utf8'));
const EXPORT_URL_T = 'https://export.test/products.csv.gz';
/** fetch for export downloads; `gate` (a promise) holds the download until it resolves. */
function fakeExport(state = {}) {
  return async (url) => {
    state.calls = (state.calls || 0) + 1;
    if (state.gate) await state.gate;
    if (state.fail) return new Response('nope', { status: 500 });
    assert.equal(url, EXPORT_URL_T);
    let i = 0;
    return new Response(new ReadableStream({
      pull(ctrl) {
        if (i >= EXPORT_GZ.length) return ctrl.close();
        ctrl.enqueue(EXPORT_GZ.subarray(i, i + 50));
        i += 50;
      }
    }));
  };
}
const health = async (base) => (await fetch(`${base}/v1/health`, { headers: AUTH })).json();
async function waitIdle(base) {
  for (let i = 0; i < 200; i++) {
    const h = await health(base);
    if (!h.building) return h;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('build did not finish');
}
const putBrands = (base, brands) => fetch(`${base}/v1/brands`, {
  method: 'PUT', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ brands })
});

await atest('brands: auth required; PUT/GET round trip; validation', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/v1/brands`)).status, 401);
    assert.equal((await fetch(`${base}/v1/brand-pack`)).status, 401);
    assert.equal((await fetch(`${base}/v1/brand-pack/rebuild`, { method: 'POST' })).status, 401);
    const empty = await (await fetch(`${base}/v1/brands`, { headers: AUTH })).json();
    assert.deepEqual(empty, { brands: [], updated: null });
    const r = await putBrands(base, [{ name: "Kellogg's", n: 4 }, { name: 'Kelloggs', n: 7 }, { name: 'Fairlife', n: 2 }]);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, count: 2 });
    const got = await (await fetch(`${base}/v1/brands`, { headers: AUTH })).json();
    assert.deepEqual(got.brands, [{ name: "Kellogg's", n: 7 }, { name: 'Fairlife', n: 2 }]);
    assert.match(got.updated, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await putBrands(base, [{ name: 'x'.repeat(61), n: 1 }])).status, 400);
    const bad = await fetch(`${base}/v1/brands`, { method: 'PUT', headers: AUTH, body: '{nope' });
    assert.equal(bad.status, 400);
    const big = await fetch(`${base}/v1/brands`, { method: 'PUT', headers: AUTH, body: JSON.stringify({ brands: [], pad: 'x'.repeat(70000) }) });
    assert.equal(big.status, 413);
    assert.equal((await health(base)).brands, 2);
    // Replaces the list.
    await putBrands(base, [{ name: 'Chobani', n: 1 }]);
    assert.deepEqual((await (await fetch(`${base}/v1/brands`, { headers: AUTH })).json()).brands, [{ name: 'Chobani', n: 1 }]);
  });
});
await atest('brands persist across restarts (same DATA_DIR)', async () => {
  const dir = freshDir();
  await withServer({ cfg: { dataDir: dir } }, async (base) => {
    await putBrands(base, [{ name: 'Fairlife', n: 2 }]);
  });
  await withServer({ cfg: { dataDir: dir } }, async (base) => {
    assert.equal((await health(base)).brands, 1);
  });
});
await atest('brand-pack: 404, rebuild 202 / running 200, 200 + ETag, 304, health fields', async () => {
  const st = {};
  let release;
  st.gate = new Promise((r) => { release = r; });
  await withServer({ fetchImpl: fakeExport(st), cfg: { exportUrl: EXPORT_URL_T } }, async (base, server) => {
    const h0 = await health(base);
    assert.equal(h0.version, '1.8.1');
    assert.deepEqual([h0.brands, h0.pack, h0.servings, h0.building, h0.lastBuildError], [0, null, null, false, null]);
    const r404 = await fetch(`${base}/v1/brand-pack`, { headers: AUTH });
    assert.equal(r404.status, 404);
    assert.deepEqual(await r404.json(), { error: 'no pack yet' });
    await putBrands(base, [{ name: "Kellogg's", n: 5 }, { name: 'Fairlife', n: 1 }]);
    const r1 = await fetch(`${base}/v1/brand-pack/rebuild`, { method: 'POST', headers: AUTH });
    assert.equal(r1.status, 202);
    assert.deepEqual(await r1.json(), { started: true });
    const r2 = await fetch(`${base}/v1/brand-pack/rebuild`, { method: 'POST', headers: AUTH });
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { started: false, running: true });
    assert.equal((await health(base)).building, true);
    // The server keeps answering while a build runs.
    assert.equal((await fetch(`${base}/v1/brands`, { headers: AUTH })).status, 200);
    release();
    const h = await waitIdle(base);
    assert.equal(h.lastBuildError, null);
    assert.deepEqual(h.pack.brands, ["Kellogg's", 'Fairlife']);
    assert.equal(h.pack.foods, 3);
    assert.match(h.pack.generated, /^\d{4}-\d\d-\d\d$/);
    // The same pass built the servings index from every row (all countries, all brands).
    assert.equal(h.servings.count, 6);
    assert.match(h.servings.builtAt, /^\d{4}-\d\d-\d\dT/);
    const r = await fetch(`${base}/v1/brand-pack`, { headers: { ...AUTH, Origin: 'https://zooksey.github.io' } });
    assert.equal(r.status, 200);
    const etag = r.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    assert.equal(r.headers.get('access-control-expose-headers'), 'ETag');
    const pack = await r.json();
    assert.equal(pack.format, 'macrotally-pack/1');
    assert.equal(pack.kind, 'products');
    assert.equal(pack.id, 'my-brands');
    assert.equal(pack.name, 'Brands you use');
    assert.deepEqual(pack.brands, ["Kellogg's", 'Fairlife']);
    // US only (the Canada-only row and the French code with a stray US tag are out), most scanned first per brand.
    assert.deepEqual(pack.foods.map((f) => f.id), ['0038000001234', '0811620022118', '0038000200038']);
    assert.deepEqual(pack.foods[0], { id: '0038000001234', bc: '0038000001234', n: 'Frosted "Flakes', b: "Kellogg's", s: ['1 cup', 30], v: [114, 2.1, 25.5, 0.3, 0.6] });
    const r304 = await fetch(`${base}/v1/brand-pack`, { headers: { ...AUTH, 'If-None-Match': etag } });
    assert.equal(r304.status, 304);
    assert.equal(r304.headers.get('etag'), etag);
    assert.equal((await fetch(`${base}/v1/brand-pack`, { headers: { ...AUTH, 'If-None-Match': '"other"' } })).status, 200);
    assert.equal(st.calls, 1);
    // Scheduler: fresh pack with the same brands -> no build.
    server.helper.tick();
    assert.equal(server.helper.status().building, false);
    assert.equal(st.calls, 1);
  });
});
await atest('scheduler: index-only build without brands, builds when there is no pack, rebuilds a changed set after 20 h, weekly index; failure recorded', async () => {
  const st = {};
  const clock = { t: Date.UTC(2026, 10, 11, 8) };
  await withServer({ fetchImpl: fakeExport(st), clock, cfg: { exportUrl: EXPORT_URL_T } }, async (base, server) => {
    // No brands but no servings index: an index-only build.
    server.helper.tick();
    let h = await waitIdle(base);
    assert.equal(st.calls, 1);
    assert.equal(h.pack, null);
    assert.equal(h.servings.count, 6);
    assert.equal(h.servings.builtAt, new Date(clock.t).toISOString());
    server.helper.tick();
    await waitIdle(base);
    assert.equal(st.calls, 1, 'fresh index, no brands: no build');
    await putBrands(base, [{ name: 'Chobani', n: 1 }]);
    server.helper.tick();
    h = await waitIdle(base);
    assert.equal(st.calls, 2);
    assert.deepEqual(h.pack.brands, ['Chobani']);
    assert.equal(h.pack.foods, 1);
    await putBrands(base, [{ name: 'Chobani', n: 1 }, { name: 'Fairlife', n: 1 }]);
    server.helper.tick();
    await waitIdle(base);
    assert.equal(st.calls, 2, 'changed set waits 20 h');
    clock.t += 21 * 3600 * 1000;
    st.fail = true;
    server.helper.tick();
    h = await waitIdle(base);
    assert.equal(st.calls, 3);
    assert.match(h.lastBuildError, /HTTP 500/);
    assert.deepEqual(h.pack.brands, ['Chobani'], 'old pack kept after a failed build');
    assert.equal(h.servings.count, 6, 'old index kept after a failed build');
    // Retried by the same rules (a changed set: 20 h after the last attempt), then the error clears.
    st.fail = false;
    clock.t += 7 * 3600 * 1000;
    server.helper.tick();
    await waitIdle(base);
    assert.equal(st.calls, 3);
    clock.t += 14 * 3600 * 1000;
    server.helper.tick();
    h = await waitIdle(base);
    assert.equal(st.calls, 4);
    assert.equal(h.lastBuildError, null);
    assert.deepEqual(h.pack.brands, ['Chobani', 'Fairlife']);
    // A week later the index is due again, even with the brand pack unchanged.
    const builtAt = h.servings.builtAt;
    clock.t += 6 * 24 * 3600 * 1000;
    server.helper.tick();
    await waitIdle(base);
    assert.equal(st.calls, 4);
    clock.t += 2 * 24 * 3600 * 1000;
    server.helper.tick();
    h = await waitIdle(base);
    assert.equal(st.calls, 5);
    assert.notEqual(h.servings.builtAt, builtAt);
  });
});

// A second export for the servings index: codes with leading zeros, a fraction, duplicates, bad rows.
const SROWS = [
  ['code', 'product_name', 'countries_tags', 'serving_size', 'serving_quantity'].join('\t'),
  ['0038000199929', 'Rice Krispies', 'en:united-states', '1 1/4 cup (28 g)', '28'].join('\t'),
  ['5000000000017', 'British biscuit', 'en:united-kingdom', '1 biscuit', '28.35'].join('\t'),
  ['5000000000017', 'Same code again', 'en:united-kingdom', '', '99'].join('\t'),
  ['0000000000123', 'No serving', 'en:united-states', '', ''].join('\t'),
  ['0000000000456', 'Huge serving', 'en:united-states', '', '1500'].join('\t'),
  ['123', 'Short code', 'en:united-states', '', '30'].join('\t')
].join('\n') + '\n';
const SEARCH_HITS = {
  hits: [
    { code: '0038000199929', product_name: 'Rice Krispies', brands: ["Kellogg's"], unique_scans_n: 5, nutriments: { 'energy-kcal_100g': 375 } },
    { code: '5000000000017', product_name: 'Rice biscuit', nutriments: { 'energy-kcal_100g': 480 } },
    { code: '2030606199943', product_name: 'rice krispies' }
  ]
};
/** fetch serving both the export (EXPORT_URL_T) and the search upstream. */
function fakeBoth(state = {}) {
  const gz = gzipSync(Buffer.from(SROWS, 'utf8'));
  return async (url) => {
    if (url === EXPORT_URL_T) {
      state.exportCalls = (state.exportCalls || 0) + 1;
      return new Response(gz);
    }
    state.searchCalls = (state.searchCalls || 0) + 1;
    return Response.json(SEARCH_HITS);
  };
}
const rebuild = (base) => fetch(`${base}/v1/brand-pack/rebuild`, { method: 'POST', headers: AUTH });

await atest('rebuild with no brands: 202, index-only build, no pack, files written', async () => {
  const st = {};
  const dir = freshDir();
  await withServer({ fetchImpl: fakeBoth(st), cfg: { exportUrl: EXPORT_URL_T, dataDir: dir } }, async (base) => {
    const r = await rebuild(base);
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { started: true });
    const h = await waitIdle(base);
    assert.equal(st.exportCalls, 1);
    assert.equal(h.lastBuildError, null);
    assert.equal(h.pack, null);
    assert.equal(h.servings.count, 2);
    assert.equal((await fetch(`${base}/v1/brand-pack`, { headers: AUTH })).status, 404);
    const idx = op.decodeServingIndex(readFileSync(path.join(dir, 'servings.idx')));
    assert.deepEqual([...idx.codes], [38000199929, 5000000000017]);
    assert.equal(op.lookupServing(idx, '5000000000017'), Math.fround(28.4), 'first copy of a code wins');
    const state = JSON.parse(readFileSync(path.join(dir, 'build-state.json'), 'utf8'));
    assert.deepEqual(state.servings, h.servings);
    assert.equal(existsSync(path.join(dir, 'brand-pack.json')), false);
  });
});
await atest('servings index: loaded at startup; a corrupt file is ignored', async () => {
  const dir = freshDir();
  let first;
  await withServer({ fetchImpl: fakeBoth(), cfg: { exportUrl: EXPORT_URL_T, dataDir: dir } }, async (base) => {
    await rebuild(base);
    first = (await waitIdle(base)).servings;
  });
  await withServer({ fetchImpl: fakeBoth(), cfg: { dataDir: dir } }, async (base) => {
    assert.deepEqual((await health(base)).servings, first);
    const j = await (await fetch(`${base}/v1/search?q=rice`)).json();
    assert.equal(j.products[0].serving_size, '28 g');
  });
  writeFileSync(path.join(dir, 'servings.idx'), 'MTSRV001 not really an index');
  await withServer({ fetchImpl: fakeBoth(), cfg: { dataDir: dir } }, async (base, server) => {
    assert.equal((await health(base)).servings, null);
    const j = await (await fetch(`${base}/v1/search?q=rice`)).json();
    assert.equal(j.products[0].serving_size, undefined);
    assert.equal(server.helper.status().servings, null);
  });
});
await atest('GET /v1/search: serving data from the index, also for a search cached before the index', async () => {
  const st = {};
  await withServer({ fetchImpl: fakeBoth(st), cfg: { exportUrl: EXPORT_URL_T } }, async (base) => {
    const before = await (await fetch(`${base}/v1/search?q=rice`)).json();
    assert.equal(before.cached, false);
    assert.equal(before.products.length, 3);
    for (const p of before.products) {
      assert.equal(p.serving_size, undefined);
      assert.equal(p.serving_quantity, undefined);
    }
    await rebuild(base);
    await waitIdle(base);
    const after = await (await fetch(`${base}/v1/search?q=rice`)).json();
    assert.equal(after.cached, true);
    assert.equal(st.searchCalls, 1);
    assert.deepEqual(after.products[0], { ...before.products[0], serving_size: '28 g', serving_quantity: 28 });
    assert.deepEqual(after.products[1], { ...before.products[1], serving_size: '28.4 g', serving_quantity: 28.4 });
    assert.equal(after.products[0].partial, true);
    // A hit without an index entry is unchanged.
    assert.deepEqual(after.products[2], before.products[2]);
    // A fresh (uncached) search is enriched too.
    const other = await (await fetch(`${base}/v1/search?q=krispies`)).json();
    assert.equal(other.cached, false);
    assert.equal(other.products[0].serving_quantity, 28);
    // And the cache still holds the bare hits (served again, still enriched, never doubled up).
    const again = await (await fetch(`${base}/v1/search?q=rice`)).json();
    assert.deepEqual(again.products, after.products);
  });
});
await atest('missing DATA_DIR: brand endpoints 503, search and health still work', async () => {
  const file = path.join(tmpRoot, 'not-a-dir');
  writeFileSync(file, 'x');
  await withServer({ fetchImpl: fakeSearch(), cfg: { dataDir: path.join(file, 'data') } }, async (base, server) => {
    for (const [method, p] of [['GET', '/v1/brands'], ['PUT', '/v1/brands'], ['GET', '/v1/brand-pack'], ['POST', '/v1/brand-pack/rebuild']]) {
      const r = await fetch(`${base}${p}`, { method, headers: AUTH, body: method === 'PUT' ? '{"brands":[]}' : undefined });
      assert.equal(r.status, 503, `${method} ${p}`);
      assert.deepEqual(await r.json(), { error: 'no data dir' });
    }
    const h = await health(base);
    assert.deepEqual([h.ok, h.brands, h.pack, h.servings, h.building], [true, 0, null, null, false]);
    server.helper.tick();
    assert.equal(server.helper.status().building, false, 'no build without a data dir');
    assert.equal((await fetch(`${base}/v1/search?q=milk`)).status, 200);
  });
});
await atest('OPTIONS preflight for PUT and unknown routes', async () => {
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/v1/brands`, { method: 'OPTIONS', headers: { Origin: 'https://zooksey.github.io', 'Access-Control-Request-Method': 'PUT' } });
    assert.equal(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /PUT/);
    assert.equal((await fetch(`${base}/v1/nope`, { headers: AUTH })).status, 404);
    assert.equal((await fetch(`${base}/v1/search?q=milk`, { method: 'POST' })).status, 401);
  });
});
rmSync(tmpRoot, { recursive: true, force: true });
passed += apassed;

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
