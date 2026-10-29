#!/usr/bin/env node
/**
 * MacroTally AI helper: a tiny HTTP service that runs the Claude Code CLI headless (`claude -p`) on the owner's
 * Claude subscription and returns schema-validated food items to the app. Plain Node 22, no dependencies.
 * See README.md in this folder for setup (Docker / Unraid / Cloudflare Tunnel) and SPEC-ai.md for the design.
 *
 * The pure helpers below are exported for tools/test_ai_server.mjs; the server only listens when this file is run
 * directly (`node ai-server.mjs`).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Server version, reported by GET /v1/health (matches the app's APP_VERSION). */
export const VERSION = '1.6.1';
/** Largest accepted request body (bytes). */
export const MAX_BODY = 12 * 1024 * 1024;
/** Longest accepted description. */
export const MAX_TEXT = 2000;
/** Most items returned per answer. */
export const MAX_ITEMS = 8;
/** Longest accepted base64 string per photo. */
export const MAX_IMAGE_CHARS = 4 * 1024 * 1024;
/** Most photos per ask (front of the pack, nutrition panel, plate). */
export const MAX_IMAGES = 4;
/** Accepted image types → file extension written for Claude's Read tool. */
export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
/** Default CORS allow-list. */
export const DEFAULT_ORIGINS = 'https://zooksey.github.io,http://localhost:8766,http://127.0.0.1:8766';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = 'Read,WebSearch,WebFetch';
/**
 * Grocery retailer sites that stall automated fetches instead of refusing them: one such page cost a full
 * 60 s tool timeout. Denied outright so a fetch fails at once and Claude moves on.
 */
export const BLOCKED_DOMAINS = [
  'kroger.com', 'walmart.com', 'target.com', 'instacart.com', 'amazon.com', 'costco.com', 'samsclub.com',
  'albertsons.com', 'safeway.com', 'heb.com', 'wegmans.com', 'publix.com', 'meijer.com', 'shipt.com',
  'stopandshop.com', 'giantfood.com', 'hy-vee.com', 'frysfood.com', 'ralphs.com', 'fredmeyer.com'
];
/** Permission deny rules for BLOCKED_DOMAINS (bare and www forms). */
export function blockedFetchRules() {
  return BLOCKED_DOMAINS.flatMap((d) => [`WebFetch(domain:${d})`, `WebFetch(domain:www.${d})`]);
}

/** An error carrying the HTTP status (and optional detail) to answer with. */
function httpError(status, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.message = message;
  if (detail !== undefined) e.detail = detail;
  return e;
}

/**
 * Parse a comma-separated origin list (trims, drops trailing slashes and blanks).
 * @param {string|string[]} s
 * @returns {string[]}
 */
export function parseOrigins(s) {
  const list = Array.isArray(s) ? s : String(s ?? '').split(',');
  return list.map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean);
}

/**
 * CORS response headers for a request Origin. An allowed origin is echoed back; anything else gets only
 * `Vary: Origin` (so the browser blocks the response).
 * @param {string|undefined} origin request Origin header
 * @param {string|string[]} allowed allow-list (array or comma string)
 * @returns {Record<string,string>}
 */
export function corsHeaders(origin, allowed) {
  const list = parseOrigins(allowed);
  if (!origin || !list.includes(String(origin))) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': String(origin),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

const blank = (v) => v === undefined || v === null || v === '';

/** One photo: base64 with whitespace removed (at most MAX_IMAGE_CHARS) and a mime (default image/jpeg). */
function checkImage(data, rawMime, what) {
  if (typeof data !== 'string' || !data) throw httpError(400, `${what} must be a base64 string`);
  const b64 = data.replace(/\s+/g, '');
  if (b64.length > MAX_IMAGE_CHARS) throw httpError(413, `${what} too large`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) throw httpError(400, `${what} must be plain base64 (no data: prefix)`);
  const mime = blank(rawMime) ? 'image/jpeg' : rawMime;
  if (!Object.prototype.hasOwnProperty.call(MIME_EXT, mime)) throw httpError(400, 'mime must be image/jpeg or image/png');
  return { data: b64, mime };
}

/**
 * Validate a parsed POST /v1/food body. Photos come as `images: [{data, mime}, ...]` (at most MAX_IMAGES), or as
 * the one-photo shorthand `image` + `mime`; sending both forms is a 400.
 * @param {*} body
 * @returns {{text: string, images: {data: string, mime: string}[]}} text trimmed; data is base64 without whitespace
 * @throws {{status:number, message:string}} 400 for bad input, 413 for an oversize image
 */
export function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be a JSON object');
  const rawText = body.text ?? '';
  if (typeof rawText !== 'string') throw httpError(400, 'text must be a string');
  const text = rawText.trim();
  if (text.length > MAX_TEXT) throw httpError(400, `text is longer than ${MAX_TEXT} characters`);
  const hasList = body.images !== undefined && body.images !== null;
  const hasOne = !blank(body.image);
  if (hasList && hasOne) throw httpError(400, 'send images or image, not both');
  const images = [];
  if (hasList) {
    if (!Array.isArray(body.images)) throw httpError(400, 'images must be an array');
    if (body.images.length > MAX_IMAGES) throw httpError(400, `send at most ${MAX_IMAGES} images`);
    body.images.forEach((im, i) => {
      if (!im || typeof im !== 'object' || Array.isArray(im)) throw httpError(400, `images[${i}] must be {data, mime}`);
      images.push(checkImage(im.data, im.mime, `images[${i}]`));
    });
  } else if (hasOne) {
    images.push(checkImage(body.image, body.mime, 'image'));
  }
  if (!text && !images.length) throw httpError(400, 'send text, an image, or both');
  return { text, images };
}

/**
 * CLI flags for one job (everything except `-p <prompt>`, which goes first). Locked down: only the Read and web
 * tools, no permission prompts, no session files, no user customizations (--safe-mode keeps auth). Never --bare,
 * which skips OAuth and breaks subscription auth.
 * @param {{schemaJson: string, systemPath: string, model?: string, maxTurns?: number}} o
 * @returns {string[]}
 */
export function buildArgs({ schemaJson, systemPath, model = 'sonnet', maxTurns = 10 }) {
  return [
    '--output-format', 'json',
    '--json-schema', String(schemaJson),
    '--model', String(model || 'sonnet'),
    '--max-turns', String(Number(maxTurns) > 0 ? Math.round(Number(maxTurns)) : 10),
    '--tools', TOOLS,
    '--allowedTools', TOOLS,
    '--disallowedTools', ...blockedFetchRules(),
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--append-system-prompt-file', String(systemPath),
    '--safe-mode'
  ];
}

/**
 * The user message for a job. One photo keeps the original "Photo:" line; several share one "Photos:" line.
 * @param {{text: string, photoName?: string|null, photoNames?: string[]}} o
 * @returns {string}
 */
export function buildPrompt({ text, photoName = null, photoNames = [] }) {
  const lines = [];
  const names = (photoNames && photoNames.length ? photoNames : [photoName]).filter(Boolean);
  if (names.length === 1) lines.push(`Photo: ./${names[0]} (use Read to look at it).`);
  else if (names.length > 1) {
    lines.push(`Photos: ${names.map((n) => `./${n}`).join(', ')} (use Read on each; they show the same food: packaging, nutrition panel, plate).`);
  }
  if (text) lines.push(`User says: "${text}"`);
  return lines.join('\n');
}

const str = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** Optional positive number: a finite number > 0, else null. */
const optPos = (v) => (isNum(v) && v > 0 ? v : null);

/**
 * Sanity-filter one item from Claude: required numbers finite and ≥ 0 (else the item is dropped), per in
 * {serving, 100g}, strings trimmed, optional amounts null unless positive.
 * @param {*} it
 * @returns {object|null}
 */
export function cleanItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  const name = str(it.name, 200);
  if (!name) return null;
  if (it.per !== 'serving' && it.per !== '100g') return null;
  for (const k of ['cal', 'p', 'c', 'f', 'fiber']) if (!isNum(it[k])) return null;
  const confidence = ['label', 'web', 'estimate'].includes(it.confidence) ? it.confidence : 'estimate';
  return {
    name,
    brand: str(it.brand, 120),
    per: it.per,
    servingGrams: optPos(it.servingGrams),
    servingLabel: str(it.servingLabel, 120) || '1 serving',
    cal: it.cal,
    p: it.p,
    c: it.c,
    f: it.f,
    fiber: it.fiber,
    grams: optPos(it.grams),
    servings: optPos(it.servings),
    confidence,
    source: str(it.source, 300),
    notes: str(it.notes, 300)
  };
}

function tryJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Parse the CLI's `--output-format json` stdout and return the sanitized items (at most 8).
 * @param {string} stdout
 * @returns {{items: object[]}}
 * @throws {{status: 502, message: 'no result', detail?: string}} when there is no usable structured_output.items
 */
export function parseClaudeOutput(stdout) {
  const text = String(stdout ?? '').trim();
  let obj = tryJson(text);
  if (obj === undefined) {
    // Tolerate stray lines around the JSON: take the last line that parses.
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
    for (let i = lines.length - 1; i >= 0 && obj === undefined; i--) obj = tryJson(lines[i].trim());
  }
  if (Array.isArray(obj)) obj = [...obj].reverse().find((x) => x && x.type === 'result') || null;
  if (!obj || typeof obj !== 'object') throw httpError(502, 'no result');
  const so = obj.structured_output;
  const raw = so && typeof so === 'object' && Array.isArray(so.items) ? so.items : null;
  if (!raw) throw httpError(502, 'no result', String(obj.subtype || (obj.is_error ? 'error' : 'no structured_output')));
  const items = raw.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
  if (!items.length) throw httpError(502, 'no result', 'no usable items');
  return { items };
}

/**
 * Constant-time check of an `Authorization: Bearer <secret>` header.
 * @param {string|undefined} header
 * @param {string} secret
 * @returns {boolean}
 */
export function checkAuth(header, secret) {
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header || '').trim());
  const given = m ? m[1].trim() : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b) && given.length > 0;
}

/**
 * How to start the CLI: `claude` on Linux/macOS. On Windows `claude` is an npm `.cmd` shim, and running a .cmd
 * needs a shell, which would re-parse the user's text (quotes, &, |, %): instead the shim is resolved to the
 * program it launches (claude.exe, or node + cli.js for older installs). CLAUDE_BIN overrides everything.
 * @param {string} [platform]
 * @param {object} [env]
 * @returns {{cmd: string, prefix: string[]}|null} null when nothing was found on Windows
 */
export function resolveClaude(platform = process.platform, env = process.env) {
  if (env.CLAUDE_BIN) return { cmd: env.CLAUDE_BIN, prefix: [] };
  if (platform !== 'win32') return { cmd: 'claude', prefix: [] };
  const dirs = String(env.PATH || env.Path || '').split(';').map((d) => d.trim()).filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, 'claude.exe');
    if (existsSync(exe)) return { cmd: exe, prefix: [] };
  }
  for (const d of dirs) {
    const shim = path.join(d, 'claude.cmd');
    if (!existsSync(shim)) continue;
    let body = '';
    try {
      body = readFileSync(shim, 'utf8');
    } catch {
      continue;
    }
    const exe = /"%dp0%\\([^"]+?\.exe)"/i.exec(body);
    if (exe && existsSync(path.join(d, exe[1]))) return { cmd: path.join(d, exe[1]), prefix: [] };
    const js = /"%dp0%\\([^"]+?\.c?js)"/i.exec(body);
    if (js && existsSync(path.join(d, js[1]))) return { cmd: process.execPath, prefix: [path.join(d, js[1])] };
  }
  return null;
}

/** Child environment: ours, minus ANTHROPIC_API_KEY (so the subscription login is used) and an empty OAuth token. */
export function childEnv(env = process.env) {
  const out = { ...env };
  delete out.ANTHROPIC_API_KEY;
  if (!String(out.CLAUDE_CODE_OAUTH_TOKEN || '').trim()) delete out.CLAUDE_CODE_OAUTH_TOKEN;
  return out;
}

/** Run the CLI once. Resolves (never rejects) with stdout/stderr and whether it was killed by the timeout. */
function runClaude(bin, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(bin.cmd, [...bin.prefix, ...args], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env,
        windowsHide: true
      }, (err, stdout, stderr) => {
        resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) });
      });
    } catch (err) {
      resolve({ err, stdout: '', stderr: String(err && err.message), timedOut: false });
      return;
    }
    // With a prompt argument the CLI may still read piped stdin: close it so it never waits for input.
    if (child.stdin) child.stdin.end();
  });
}

/** Read config from the environment. */
export function readConfig(env = process.env) {
  return {
    secret: String(env.AI_SECRET || ''),
    model: String(env.AI_MODEL || 'sonnet').trim() || 'sonnet',
    origins: parseOrigins(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS),
    port: Number(env.PORT) > 0 ? Number(env.PORT) : 8787,
    timeoutMs: Number(env.AI_TIMEOUT_MS) > 0 ? Number(env.AI_TIMEOUT_MS) : 85000,
    maxTurns: Number(env.AI_MAX_TURNS) > 0 ? Number(env.AI_MAX_TURNS) : 10
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(httpError(413, 'body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) over = true;
      else chunks.push(c);
    });
    req.on('end', () => (over ? reject(httpError(413, 'body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function logLine(fields) {
  console.log([new Date().toISOString(), ...fields].join(' '));
}

/**
 * Create the HTTP server (not listening yet).
 * @param {ReturnType<typeof readConfig>} cfg
 * @returns {http.Server}
 */
export function createServer(cfg) {
  const schemaJson = JSON.stringify(JSON.parse(readFileSync(path.join(HERE, 'schema.json'), 'utf8')));
  const systemPath = path.join(HERE, 'system.txt');
  const bin = resolveClaude();
  let busy = false;

  return http.createServer(async (req, res) => {
    const t0 = Date.now();
    const cors = corsHeaders(req.headers.origin, cfg.origins);
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      // keep '/'
    }
    const info = { items: 0, textLen: 0, images: 0 };
    const send = (status, obj) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (pathname === '/v1/food') logLine([req.method, pathname, status, `${secs}s`, `items=${info.items}`, `text=${info.textLen}`, `images=${info.images}`]);
      else logLine([req.method, pathname, status, `${secs}s`]);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (!checkAuth(req.headers.authorization, cfg.secret)) {
      req.resume();
      send(401, { error: 'bad secret' });
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/health') {
      send(200, { ok: true, version: VERSION, model: cfg.model });
      return;
    }
    if (req.method !== 'POST' || pathname !== '/v1/food') {
      req.resume();
      send(404, { error: 'not found' });
      return;
    }

    let input;
    try {
      const raw = await readBody(req, MAX_BODY);
      const parsed = tryJson(raw);
      if (parsed === undefined) throw httpError(400, 'body must be JSON');
      input = validateBody(parsed);
    } catch (err) {
      send(err.status || 400, { error: err.message || 'bad input' });
      return;
    }
    info.textLen = input.text.length;
    info.images = input.images.length;
    if (busy) {
      send(429, { error: 'busy' });
      return;
    }
    if (!bin) {
      send(502, { error: 'no result', detail: 'claude CLI not found on this machine (set CLAUDE_BIN)' });
      return;
    }
    busy = true;
    let dir = null;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), 'mt-ai-'));
      // One photo keeps its old name (photo.jpg); several become photo1.jpg, photo2.png, ...
      const multi = input.images.length > 1;
      const photoNames = input.images.map((im, i) => `photo${multi ? i + 1 : ''}.${MIME_EXT[im.mime]}`);
      for (let i = 0; i < input.images.length; i++) {
        await writeFile(path.join(dir, photoNames[i]), Buffer.from(input.images[i].data, 'base64'));
      }
      const prompt = buildPrompt({ text: input.text, photoNames });
      const args = ['-p', prompt, ...buildArgs({ schemaJson, systemPath, model: cfg.model, maxTurns: cfg.maxTurns })];
      const tRun = Date.now();
      const run = await runClaude(bin, args, { cwd: dir, timeoutMs: cfg.timeoutMs, env: childEnv() });
      const seconds = Math.round((Date.now() - tRun) / 100) / 10;
      if (run.timedOut) {
        send(504, { error: 'timeout' });
        return;
      }
      let out;
      try {
        out = parseClaudeOutput(run.stdout);
      } catch (err) {
        const detail = err.detail || run.stderr.trim().slice(0, 300) || (run.err ? String(run.err.message).slice(0, 300) : 'no output');
        send(502, { error: 'no result', detail });
        return;
      }
      info.items = out.items.length;
      send(200, { items: out.items, model: cfg.model, seconds });
    } catch (err) {
      console.error('job failed:', err && err.message);
      send(500, { error: 'server error' });
    } finally {
      busy = false;
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

function main() {
  const cfg = readConfig();
  if (cfg.secret.length < 16) {
    console.error('AI_SECRET must be set to at least 16 characters (the app sends it as a Bearer token).');
    process.exit(1);
  }
  if (!String(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').trim()) {
    console.warn('Warning: CLAUDE_CODE_OAUTH_TOKEN is not set, so the claude CLI must already be logged in on this machine ' +
      '(fine on a PC where you ran `claude` and signed in; in Docker set it from `claude setup-token`).');
  }
  if (process.env.ANTHROPIC_API_KEY) console.warn('Note: ANTHROPIC_API_KEY is set; it is removed for the CLI so your subscription is used.');
  if (!resolveClaude()) console.warn('Warning: could not find the claude CLI on PATH. Install it or set CLAUDE_BIN; requests will fail until then.');
  const server = createServer(cfg);
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`MacroTally AI helper ${VERSION} listening on 0.0.0.0:${cfg.port} (model ${cfg.model}, origins ${cfg.origins.join(', ')})`);
  });
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
