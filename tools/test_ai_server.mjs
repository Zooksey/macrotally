// MacroTally AI helper server tests (pure helpers of server/ai-server.mjs; no server is started and Claude is
// never called). Run from the project root: node tools/test_ai_server.mjs
import assert from 'node:assert/strict';

const srv = await import('../server/ai-server.mjs');

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
  assert.equal(h['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
  assert.equal(h['Access-Control-Allow-Headers'], 'Authorization, Content-Type');
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
  assert.equal(srv.VERSION, '1.6.1');
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
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
