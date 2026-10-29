// MacroTally weight feed tests. Run from the project root: node tools/test_feed.mjs
import assert from 'node:assert/strict';

// Tiny in-memory localStorage shim (must exist before store.js is imported).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear()
};

// Minimal DOM stub so ui.js toast()/requestRender() work under Node (only syncWeightFeed calls them).
const toasts = [];
let renders = 0;
const stubEl = () => ({ classList: { add() {} }, setAttribute() {}, appendChild() {}, remove() {}, set textContent(v) { toasts.push(v); } });
globalThis.document = {
  getElementById: () => stubEl(),
  createElement: () => stubEl(),
  body: { appendChild() {} },
  dispatchEvent: () => { renders++; }
};

const store = await import('../js/store.js');
const feed = await import('../js/feed.js');

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
const lb = (x) => x * store.KG_PER_LB;
const today = store.todayStr();
const day = (n) => store.addDays(today, n);

// ---------- state ----------
test('feed defaults and merge', () => {
  store.resetAll();
  assert.deepEqual(store.state.feed, { gistId: '', lastSync: null, lastCount: 0, lastError: null, imported: {} });
  store.replaceState({ version: 1, diary: {}, feed: { gistId: 'abc', imported: 'nope' } });
  assert.equal(store.state.feed.gistId, 'abc');
  assert.deepEqual(store.state.feed.imported, {});
  assert.equal(store.state.feed.lastCount, 0);
  store.replaceState({ version: 1, diary: {} });
  assert.equal(store.state.feed.gistId, '');
  // Backups carry the feed.
  store.replaceState({ version: 1, diary: {}, feed: { gistId: 'x1', imported: { '2026-10-01': 80 } } });
  const json = store.exportJSON();
  store.resetAll();
  store.importJSON(json);
  assert.equal(store.state.feed.gistId, 'x1');
  assert.deepEqual(store.state.feed.imported, { '2026-10-01': 80 });
  store.resetAll();
});

// ---------- parseWeightLines ----------
const MIXED = [
  'Date,Weight',
  '2026-10-29 07:12 180.4 lb',
  '',
  '2026-10-28T06:58:00 181.0 lb',
  '10/27/2026, 182.2',
  '2026-10-26 82.1 kg',
  'Oct 25 183.0 lb',
  '   '
].join('\n');

test('parseWeightLines: mixed formats, header/blank/junk skipped, sorted', () => {
  const s = feed.parseWeightLines(MIXED, 'imperial');
  assert.deepEqual(s.map((x) => [x.date, x.time]), [
    ['2026-10-26', null],
    ['2026-10-27', null],
    ['2026-10-28', '06:58'],
    ['2026-10-29', '07:12']
  ]);
  near(s[0].kg, 82.1, 1e-9, 'kg unit');
  near(s[1].kg, lb(182.2), 1e-9, 'no unit → lb');
  near(s[2].kg, lb(181.0), 1e-9);
  near(s[3].kg, lb(180.4), 1e-9);
});

test('parseWeightLines: default unit by profile', () => {
  const metric = feed.parseWeightLines(MIXED, 'metric');
  near(metric.find((x) => x.date === '2026-10-27').kg, 182.2, 1e-9, 'no unit → kg');
  near(metric.find((x) => x.date === '2026-10-29').kg, lb(180.4), 1e-9, 'explicit lb kept');
  near(feed.parseWeightLines('2026-10-27 80', 'metric')[0].kg, 80, 1e-9);
  near(feed.parseWeightLines('2026-10-27 180', 'imperial')[0].kg, lb(180), 1e-9);
});

test('parseWeightLines: units, separators, times', () => {
  const s = feed.parseWeightLines([
    '2026/10/20;7:05 AM;181 lbs',
    '2026-10-21\t12:30 PM\t180 Pounds',
    '2026-10-22, 12:10 AM, 79.5 KG',
    '2026-10-23 80 kilograms',
    '2026-10-24T06:58:00-07:00 180.5 LB',
    '10/25/2026 6:40 pm 81,3 kg'
  ].join('\r\n'), 'imperial');
  assert.deepEqual(s.map((x) => [x.date, x.time]), [
    ['2026-10-20', '07:05'],
    ['2026-10-21', '12:30'],
    ['2026-10-22', '00:10'],
    ['2026-10-23', null],
    ['2026-10-24', '06:58'],
    ['2026-10-25', '18:40']
  ]);
  near(s[0].kg, lb(181), 1e-9);
  near(s[1].kg, lb(180), 1e-9);
  near(s[2].kg, 79.5, 1e-9);
  near(s[3].kg, 80, 1e-9);
  near(s[4].kg, lb(180.5), 1e-9, 'timezone offset not read as the weight');
  near(s[5].kg, 81.3, 1e-9, 'decimal comma');
});

test('parseWeightLines: skips invalid dates, missing or implausible weights', () => {
  assert.deepEqual(feed.parseWeightLines('2026-02-30 180\n2026-13-01 180\n2026-10-20\n2026-10-20 07:12\n2026-10-20 3 lb\nweight 180 lb', 'imperial'), []);
  assert.deepEqual(feed.parseWeightLines('', 'imperial'), []);
  assert.deepEqual(feed.parseWeightLines(null, 'metric'), []);
});

// ---------- dailyWeights ----------
test('dailyWeights: earliest per day, untimed after timed', () => {
  const d = feed.dailyWeights([
    { date: '2026-10-28', time: '19:00', kg: 82 },
    { date: '2026-10-27', time: null, kg: 81 },
    { date: '2026-10-28', time: null, kg: 83 },
    { date: '2026-10-28', time: '06:30', kg: 81.5 },
    { date: '2026-10-29', time: null, kg: 80.9 },
    { date: '2026-10-29', time: null, kg: 99 }
  ]);
  assert.deepEqual(d, [
    { date: '2026-10-27', kg: 81 },
    { date: '2026-10-28', kg: 81.5 },
    { date: '2026-10-29', kg: 80.9 }
  ]);
  assert.deepEqual(feed.dailyWeights([]), []);
});

// ---------- mergeFeedWeights ----------
test('mergeFeedWeights: add, skip manual, ignore future, record imported', () => {
  const st = store.defaults();
  st.weights = [{ date: day(-2), kg: 85 }];
  const r = feed.mergeFeedWeights(st, [
    { date: day(-3), kg: 84 },
    { date: day(-2), kg: 80 }, // manual weigh-in: kept
    { date: day(-1), kg: 83.5 },
    { date: day(1), kg: 70 } // future: ignored
  ]);
  assert.deepEqual(r, { added: 2, updated: 0 });
  assert.deepEqual(st.weights, [
    { date: day(-3), kg: 84 },
    { date: day(-2), kg: 85 },
    { date: day(-1), kg: 83.5 }
  ]);
  assert.deepEqual(st.feed.imported, { [day(-3)]: 84, [day(-1)]: 83.5 });
});

test('mergeFeedWeights: updates feed-written days only when changed by >= 0.05 kg', () => {
  const st = store.defaults();
  feed.mergeFeedWeights(st, [{ date: day(-1), kg: 80 }, { date: day(0), kg: 79.8 }]);
  let r = feed.mergeFeedWeights(st, [{ date: day(-1), kg: 80.03 }, { date: day(0), kg: 79.8 }]);
  assert.deepEqual(r, { added: 0, updated: 0 }, 'tiny difference ignored');
  r = feed.mergeFeedWeights(st, [{ date: day(-1), kg: 80.6 }, { date: day(0), kg: 79.8 }]);
  assert.deepEqual(r, { added: 0, updated: 1 });
  assert.equal(st.weights.find((w) => w.date === day(-1)).kg, 80.6);
  assert.equal(st.feed.imported[day(-1)], 80.6);
});

test('mergeFeedWeights: a feed day the user retyped or deleted is left alone', () => {
  const st = store.defaults();
  feed.mergeFeedWeights(st, [{ date: day(-2), kg: 80 }, { date: day(-1), kg: 81 }]);
  st.weights.find((w) => w.date === day(-2)).kg = 79; // user retyped it in the Weight tab
  st.weights = st.weights.filter((w) => w.date !== day(-1)); // user deleted it
  const r = feed.mergeFeedWeights(st, [{ date: day(-2), kg: 80.5 }, { date: day(-1), kg: 81.5 }]);
  assert.deepEqual(r, { added: 0, updated: 0 });
  assert.deepEqual(st.weights, [{ date: day(-2), kg: 79 }]);
});

test('mergeFeedWeights: imported pruned to the last 400 days; missing feed created', () => {
  const st = { weights: [] };
  st.feed = { imported: { [day(-401)]: 90, [day(-400)]: 89 } };
  feed.mergeFeedWeights(st, [{ date: day(0), kg: 80 }]);
  assert.deepEqual(Object.keys(st.feed.imported).sort(), [day(-400), day(0)]);
  const bare = { weights: [] };
  assert.deepEqual(feed.mergeFeedWeights(bare, [{ date: day(0), kg: 80 }]), { added: 1, updated: 0 });
  assert.equal(bare.feed.imported[day(0)], 80);
});

// ---------- gistText / parseGistId ----------
test('gistText: prefers .txt/.csv/.json, else the first file', () => {
  assert.equal(feed.gistText({ files: { 'a.md': { filename: 'a.md', content: 'md' }, 'weights.txt': { filename: 'weights.txt', content: 'txt' } } }), 'txt');
  assert.equal(feed.gistText({ files: { 'notes': { filename: 'notes', content: 'n' }, 'w.CSV': { filename: 'w.CSV', content: 'csv' } } }), 'csv');
  assert.equal(feed.gistText({ files: { 'x.json': { filename: 'x.json', content: '[]' } } }), '[]');
  assert.equal(feed.gistText({ files: { 'readme': { filename: 'readme', content: 'first' }, 'other': { filename: 'other', content: 'second' } } }), 'first');
  assert.equal(feed.gistText({ files: {} }), '');
  assert.equal(feed.gistText(null), '');
  assert.equal(feed.gistText({}), '');
});

test('parseGistId: id or full URL, last hex run', () => {
  const id = '0123456789abcdef0123456789abcdef';
  assert.equal(feed.parseGistId(id), id);
  assert.equal(feed.parseGistId(`https://gist.github.com/someone/${id.toUpperCase()}`), id);
  assert.equal(feed.parseGistId(`https://gist.github.com/someone/${id}#file-weights-txt`), id);
  assert.equal(feed.parseGistId('aa5a315d61ae9438b18d'), 'aa5a315d61ae9438b18d');
  assert.equal(feed.parseGistId('not an id'), '');
  assert.equal(feed.parseGistId(''), '');
});

// ---------- syncWeightFeed (fetch stubbed) ----------
const realFetch = globalThis.fetch;
const calls = [];
let reply = null;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return reply();
};
const jsonReply = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

await testAsync('syncWeightFeed: blank id is a no-op', async () => {
  store.resetAll();
  assert.equal(await feed.syncWeightFeed({ force: true }), null);
  assert.equal(calls.length, 0);
});

await testAsync('syncWeightFeed: success merges, saves, toasts; 30-minute rule; 404/403 errors', async () => {
  store.resetAll();
  store.state.profile.units = 'imperial';
  store.state.feed.gistId = 'aa5a315d61ae9438b18d';
  store.addWeight(day(-2), 90); // typed by the user
  reply = jsonReply(200, { files: { 'weights.txt': { filename: 'weights.txt', content: `${day(-2)} 07:00 180 lb\n${day(-1)} 07:00 181 lb\n${day(-1)} 20:00 183 lb\n${day(0)} 06:50 180.2 lb` } } });
  toasts.length = 0;
  const r = await feed.syncWeightFeed();
  assert.deepEqual(r, { added: 2, updated: 0 });
  assert.equal(calls[0].url, 'https://api.github.com/gists/aa5a315d61ae9438b18d');
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal(store.state.weights.find((w) => w.date === day(-2)).kg, 90);
  near(store.state.weights.find((w) => w.date === day(-1)).kg, lb(181), 1e-9);
  assert.equal(store.state.feed.lastCount, 2);
  assert.equal(store.state.feed.lastError, null);
  assert.ok(store.state.feed.lastSync);
  assert.deepEqual(toasts, ['2 weigh-ins from the scale']);
  assert.ok(JSON.parse(mem.get(store.STORAGE_KEY)).feed.imported[day(-1)], 'saved');
  await Promise.resolve();
  assert.ok(renders > 0, 'requestRender');

  // Within 30 minutes: skipped unless forced.
  assert.equal(await feed.syncWeightFeed(), null);
  assert.equal(calls.length, 1);
  assert.deepEqual(await feed.syncWeightFeed({ force: true }), { added: 0, updated: 0 });
  assert.equal(calls.length, 2);
  assert.equal(store.state.feed.lastCount, 0);

  // Concurrent calls share one fetch.
  const [a, b] = await Promise.all([feed.syncWeightFeed({ force: true }), feed.syncWeightFeed({ force: true })]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 3);

  reply = jsonReply(404, { message: 'Not Found' });
  assert.equal(await feed.syncWeightFeed({ force: true }), null);
  assert.equal(store.state.feed.lastError, 'Gist not found (404)');
  reply = jsonReply(403, { message: 'API rate limit exceeded' });
  assert.equal(await feed.syncWeightFeed({ force: true }), null);
  assert.equal(store.state.feed.lastError, 'GitHub rate limit, try later (403)');
  reply = () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await feed.syncWeightFeed({ force: true }), null);
  assert.equal(store.state.feed.lastError, 'Could not reach GitHub');
  reply = jsonReply(200, { files: {} });
  assert.deepEqual(await feed.syncWeightFeed({ force: true }), { added: 0, updated: 0 });
  assert.equal(store.state.feed.lastError, null);
  store.resetAll();
});
globalThis.fetch = realFetch;

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
