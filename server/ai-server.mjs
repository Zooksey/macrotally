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
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPORT_URL, USER_AGENT, brandKey, buildPack, inCountry, rowToFood, selectBrands, streamExport } from './off-pack.mjs';

/** Server version, reported by GET /v1/health (matches the app's APP_VERSION). */
export const VERSION = '1.8.0';
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
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
    maxTurns: Number(env.AI_MAX_TURNS) > 0 ? Number(env.AI_MAX_TURNS) : 10,
    dataDir: String(env.DATA_DIR || '').trim() || '/data',
    searchRatePerMin: Number(env.SEARCH_RATE_PER_MIN) > 0 ? Math.round(Number(env.SEARCH_RATE_PER_MIN)) : 30,
    searchGlobalPerMin: 120,
    searchTimeoutMs: 8000,
    exportUrl: String(env.EXPORT_URL || '').trim() || EXPORT_URL,
    packCountry: env.PACK_COUNTRY === undefined ? 'en:united-states' : String(env.PACK_COUNTRY).trim()
  };
}

// ---------- Open Food Facts search relay (GET /v1/search) ----------

/** Open Food Facts' Elasticsearch-backed search ("search-a-licious"); it sends no CORS header, hence the relay. */
export const SEARCH_URL = 'https://search.openfoodfacts.org/search';
const SEARCH_FIELDS = 'code,product_name,brands,nutriments,unique_scans_n,countries_tags';
/** region code -> OFF countries tag, applied as a Lucene filter clause (it filters, it does not change ranking). */
export const REGIONS = {
  us: 'en:united-states', ca: 'en:canada', gb: 'en:united-kingdom', uk: 'en:united-kingdom', ie: 'en:ireland',
  au: 'en:australia', nz: 'en:new-zealand', fr: 'en:france', de: 'en:germany', es: 'en:spain', it: 'en:italy'
};
const NUTRIMENT_KEYS = ['energy-kcal_100g', 'proteins_100g', 'carbohydrates_100g', 'fat_100g', 'fiber_100g'];
/** Search cache size and lifetime. */
export const SEARCH_CACHE_MAX = 500;
export const SEARCH_CACHE_TTL_MS = 6 * 3600 * 1000;

/** Known region code (lowercase) or ''. */
export function normalizeRegion(r) {
  const k = String(r || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(REGIONS, k) ? k : '';
}

/**
 * The user's text as plain search words: Lucene syntax characters (field:, quotes, brackets, wildcards, leading
 * '-' / '+') become spaces and the operators AND/OR/NOT are lowercased, so a query can never add its own clauses.
 * @param {string} q
 * @returns {string}
 */
export function cleanSearchText(q) {
  return String(q || '')
    .replace(/[:"()[\]{}^~*?\\/!<>=|]/g, ' ')
    .replace(/&&/g, ' ')
    .replace(/(^|\s)[-+]+/g, '$1')
    .replace(/\b(AND|OR|NOT|TO)\b/g, (m) => m.toLowerCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/** Upstream URL for a cleaned query and region. */
export function searchUrl(text, region) {
  const tag = REGIONS[normalizeRegion(region)];
  const q = tag ? `${text} countries_tags:"${tag}"` : text;
  const qs = new URLSearchParams({ q, page_size: '25', fields: SEARCH_FIELDS, langs: 'en' });
  return `${SEARCH_URL}?${qs}`;
}

/**
 * One upstream hit -> the product shape the app expects (OFF v2 style), or null without a code or name.
 * @param {*} h
 */
export function mapSearchHit(h) {
  if (!h || typeof h !== 'object') return null;
  const code = typeof h.code === 'string' || typeof h.code === 'number' ? String(h.code).trim() : '';
  const name = typeof h.product_name === 'string' ? h.product_name.replace(/\s+/g, ' ').trim() : '';
  if (!code || !name) return null;
  let brands = '';
  if (Array.isArray(h.brands)) brands = h.brands.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim()).join(', ');
  else if (typeof h.brands === 'string') brands = h.brands.trim();
  const nutriments = {};
  const src = h.nutriments && typeof h.nutriments === 'object' ? h.nutriments : {};
  for (const k of NUTRIMENT_KEYS) {
    const v = typeof src[k] === 'string' ? Number(src[k]) : src[k];
    if (typeof v === 'number' && Number.isFinite(v)) nutriments[k] = v;
  }
  const scans = Number(h.unique_scans_n);
  return {
    code,
    product_name: name,
    brands,
    nutriments,
    unique_scans_n: Number.isFinite(scans) && scans > 0 ? scans : 0,
    partial: true
  };
}

/** Sliding one-minute window counters: one per key, plus pruning. */
function makeLimiter(limit, windowMs = 60000) {
  const hits = new Map();
  return {
    /** Record a hit for key at time t; false (and nothing recorded) when the key is over its limit. */
    take(key, t) {
      let arr = hits.get(key);
      if (!arr) hits.set(key, (arr = []));
      while (arr.length && arr[0] <= t - windowMs) arr.shift();
      if (arr.length >= limit) return false;
      arr.push(t);
      if (hits.size > 5000) this.prune(t);
      return true;
    },
    prune(t) {
      for (const [k, arr] of hits) if (!arr.length || arr[arr.length - 1] <= t - windowMs) hits.delete(k);
    },
    get size() {
      return hits.size;
    }
  };
}

/** Small LRU with a TTL. */
function makeLru(max, ttlMs) {
  const m = new Map();
  return {
    get(k, t) {
      const e = m.get(k);
      if (!e) return undefined;
      if (t - e.at > ttlMs) {
        m.delete(k);
        return undefined;
      }
      m.delete(k);
      m.set(k, e);
      return e.v;
    },
    set(k, v, t) {
      m.delete(k);
      m.set(k, { v, at: t });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() {
      return m.size;
    }
  };
}

/** Client IP: Cloudflare's header, else the first X-Forwarded-For entry, else the socket address. */
export function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (xff) return xff;
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------- Brands you use (PUT/GET /v1/brands, /v1/brand-pack) ----------

export const MAX_BRANDS = 300;
export const MAX_BRAND_NAME = 60;
export const MAX_BRANDS_BODY = 64 * 1024;
const HOUR = 3600 * 1000;
/** A brand-set change rebuilds at most this often. */
export const REBUILD_CHANGED_MS = 20 * HOUR;
/** A pack older than this is rebuilt. */
export const PACK_MAX_AGE_MS = 7 * 24 * HOUR;
/** After a failed build, wait this long before trying again (a build downloads ~1.5 GB). */
export const FAIL_BACKOFF_MS = 6 * HOUR;

/**
 * Validate a PUT /v1/brands body: `{ brands: [{ name, n }] }`, at most 300, names 1-60 characters, n a number
 * >= 0 (missing n counts as 0). De-duplicated by brandKey (first spelling kept, highest n); names without letters
 * or digits are skipped.
 * @param {*} body
 * @returns {{name: string, n: number}[]}
 */
export function validateBrands(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'body must be a JSON object');
  if (!Array.isArray(body.brands)) throw httpError(400, 'brands must be an array');
  if (body.brands.length > MAX_BRANDS) throw httpError(400, `send at most ${MAX_BRANDS} brands`);
  const out = [];
  const byKey = new Map();
  body.brands.forEach((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw httpError(400, `brands[${i}] must be {name, n}`);
    if (typeof b.name !== 'string') throw httpError(400, `brands[${i}].name must be a string`);
    const name = b.name.replace(/\s+/g, ' ').trim();
    if (!name || name.length > MAX_BRAND_NAME) throw httpError(400, `brands[${i}].name must be 1-${MAX_BRAND_NAME} characters`);
    const n = b.n === undefined || b.n === null ? 0 : b.n;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw httpError(400, `brands[${i}].n must be a number >= 0`);
    const k = brandKey(name);
    if (!k) return;
    const prev = byKey.get(k);
    if (prev) prev.n = Math.max(prev.n, n);
    else {
      const e = { name, n };
      byKey.set(k, e);
      out.push(e);
    }
  });
  return out;
}

/** Same brands (by brandKey), ignoring order and spelling. */
export function sameBrandSet(a, b) {
  const ka = new Set((a || []).map((x) => brandKey(typeof x === 'string' ? x : x && x.name)).filter(Boolean));
  const kb = new Set((b || []).map((x) => brandKey(typeof x === 'string' ? x : x && x.name)).filter(Boolean));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
}

/**
 * Scheduler rule: build when there are brands, no build is running, the last failure is at least
 * FAIL_BACKOFF_MS old, and (there is no pack, or the pack is older than 7 days, or the brand set differs from the
 * pack's and the last attempt is more than 20 h old).
 * @param {{brands: object[], building: boolean, pack: {generated?: string, builtAt?: string, brands?: string[]}|null,
 *   lastAttempt: number, lastBuildError: string|null, now: number}} s
 */
export function shouldBuild({ brands, building, pack, lastAttempt = 0, lastBuildError = null, now }) {
  if (!brands || !brands.length || building) return false;
  if (lastBuildError && lastAttempt && now - lastAttempt < FAIL_BACKOFF_MS) return false;
  if (!pack) return true;
  const built = Date.parse(pack.builtAt || pack.generated || '');
  if (!Number.isFinite(built) || now - built > PACK_MAX_AGE_MS) return true;
  return !sameBrandSet(brands, pack.brands) && (!lastAttempt || now - lastAttempt > REBUILD_CHANGED_MS);
}

/** Write a file atomically (temp file in the same folder, then rename). */
async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** True when dir exists (created if needed) and a file can be written in it. */
function probeDataDir(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
 * @param {ReturnType<typeof readConfig>} cfgIn (missing fields take readConfig's defaults)
 * @param {{fetchImpl?: typeof fetch, now?: () => number, schedule?: boolean, log?: (fields: any[]) => void}} [deps]
 *   fetchImpl serves both the search relay and the export download; now drives rate limits, the cache and the
 *   build rules; schedule starts the hourly brand-pack scheduler (main() turns it on; tests leave it off).
 * @returns {http.Server}
 */
export function createServer(cfgIn, { fetchImpl = globalThis.fetch, now = Date.now, schedule = false, log = logLine } = {}) {
  const cfg = { ...readConfig({}), ...cfgIn };
  const schemaJson = JSON.stringify(JSON.parse(readFileSync(path.join(HERE, 'schema.json'), 'utf8')));
  const systemPath = path.join(HERE, 'system.txt');
  const bin = resolveClaude();
  let busy = false;

  // ----- search relay state -----
  const ipLimiter = makeLimiter(cfg.searchRatePerMin);
  const globalLimiter = makeLimiter(cfg.searchGlobalPerMin);
  const cache = makeLru(SEARCH_CACHE_MAX, SEARCH_CACHE_TTL_MS);
  const inflight = new Map();

  // ----- data dir / brand pack state -----
  const files = {
    brands: path.join(cfg.dataDir, 'brands.json'),
    pack: path.join(cfg.dataDir, 'brand-pack.json'),
    state: path.join(cfg.dataDir, 'build-state.json')
  };
  let dataOk = probeDataDir(cfg.dataDir);
  let dataCheckedAt = now();
  let brands = [];
  let packMeta = null;
  let building = false;
  let lastAttempt = 0;
  let lastBuildError = null;
  let packCache = null;
  const buildAbort = new AbortController();
  const loadData = () => {
    const b = readJsonFile(files.brands);
    brands = b && Array.isArray(b.brands) ? b.brands.filter((x) => x && typeof x.name === 'string') : [];
    const p = readJsonFile(files.pack);
    packMeta = p && Array.isArray(p.foods)
      ? { generated: String(p.generated || ''), builtAt: p.builtAt || null, foods: p.foods.length, brands: Array.isArray(p.brands) ? p.brands : [] }
      : null;
    const st = readJsonFile(files.state);
    if (st) {
      lastAttempt = Number(st.lastAttempt) || 0;
      lastBuildError = typeof st.lastBuildError === 'string' ? st.lastBuildError : null;
    }
  };
  if (dataOk) loadData();
  else log(['data dir', cfg.dataDir, 'is missing or not writable: brand endpoints answer 503']);
  /** Data dir usable? A failed check is retried at most once a minute (say after fixing permissions). */
  const haveData = () => {
    if (dataOk) return true;
    if (now() - dataCheckedAt < 60000) return false;
    dataCheckedAt = now();
    dataOk = probeDataDir(cfg.dataDir);
    if (dataOk) loadData();
    return dataOk;
  };
  const saveState = () => writeAtomic(files.state, JSON.stringify({ lastAttempt, lastBuildError })).catch(() => {});

  async function runBuild() {
    building = true;
    lastAttempt = now();
    await saveState();
    const t0 = Date.now();
    const names = brands.map((b) => b.name);
    const wanted = new Set(names.map(brandKey).filter(Boolean));
    const country = cfg.packCountry;
    const foods = [];
    try {
      const { rows } = await streamExport({
        url: cfg.exportUrl,
        fetchImpl,
        signal: buildAbort.signal,
        lineFilter: country ? (line) => line.includes(country) : undefined,
        onRow: (cols, idx) => {
          if (!inCountry(cols[idx.code], cols[idx.countries_tags], country)) return;
          const tags = `${cols[idx.brands_tags] ?? ''},${cols[idx.brands] ?? ''}`;
          if (!tags.split(',').some((t) => wanted.has(brandKey(t)))) return;
          const f = rowToFood(cols, idx);
          if (f) foods.push(f);
        }
      });
      const selected = selectBrands(foods, names);
      const pack = {
        ...buildPack({ id: 'my-brands', name: 'Brands you use', foods: selected, source: 'https://world.openfoodfacts.org', now: now() }),
        brands: names,
        builtAt: new Date(now()).toISOString()
      };
      await writeAtomic(files.pack, JSON.stringify(pack));
      packMeta = { generated: pack.generated, builtAt: pack.builtAt, foods: selected.length, brands: names };
      packCache = null;
      lastBuildError = null;
      log(['brand-pack built', `rows=${rows}`, `matched=${foods.length}`, `foods=${selected.length}`, `brands=${names.length}`, `${((Date.now() - t0) / 1000).toFixed(0)}s`]);
    } catch (err) {
      lastBuildError = String((err && err.message) || err).slice(0, 300);
      log(['brand-pack build failed', `${((Date.now() - t0) / 1000).toFixed(0)}s`, lastBuildError]);
    } finally {
      building = false;
      await saveState();
    }
  }
  const startBuild = () => {
    if (building) return false;
    building = true;
    runBuild().catch(() => {});
    return true;
  };
  const tick = () => {
    if (haveData() && shouldBuild({ brands, building, pack: packMeta, lastAttempt, lastBuildError, now: now() })) startBuild();
    ipLimiter.prune(now());
  };

  // ----- search -----
  async function upstreamSearch(text, region) {
    const res = await fetchImpl(searchUrl(text, region), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(cfg.searchTimeoutMs)
    });
    if (!res || !res.ok) throw new Error(`upstream HTTP ${res ? res.status : '?'}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.hits)) throw new Error('upstream: no hits array');
    return body.hits.map(mapSearchHit).filter(Boolean);
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const cors = corsHeaders(req.headers.origin, cfg.origins);
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      url = new URL('http://localhost/');
    }
    const pathname = url.pathname;
    const info = { items: 0, textLen: 0, images: 0, extra: [] };
    const logReq = (status) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (pathname === '/v1/food') log([req.method, pathname, status, `${secs}s`, `items=${info.items}`, `text=${info.textLen}`, `images=${info.images}`]);
      else log([req.method, pathname, status, `${secs}s`, ...info.extra]);
    };
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(obj));
      logReq(status);
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    // Public on purpose (Open Food Facts data): no secret, but rate-limited, cached and origin-limited by CORS.
    if (req.method === 'GET' && pathname === '/v1/search') {
      req.resume();
      const t = now();
      const q = String(url.searchParams.get('q') || '').trim();
      const region = normalizeRegion(url.searchParams.get('region'));
      info.extra.push(`q=${q.length}`);
      if (region) info.extra.push(`region=${region}`);
      if (!ipLimiter.take(clientIp(req), t)) {
        send(429, { error: 'rate limited' }, { 'Retry-After': '60' });
        return;
      }
      const text = cleanSearchText(q);
      if (q.length < 2 || q.length > 100 || text.length < 2) {
        send(400, { error: 'bad query' });
        return;
      }
      const key = `${region}|${q.toLowerCase()}`;
      const hit = cache.get(key, t);
      if (hit) {
        info.extra.push(`hits=${hit.length}`, 'cached');
        send(200, { products: hit, source: 'search-a-licious', cached: true }, { 'Cache-Control': 'public, max-age=3600' });
        return;
      }
      let job = inflight.get(key);
      if (!job) {
        if (!globalLimiter.take('all', t)) {
          send(429, { error: 'rate limited' }, { 'Retry-After': '60' });
          return;
        }
        job = upstreamSearch(text, region).finally(() => inflight.delete(key));
        inflight.set(key, job);
      }
      try {
        const products = await job;
        cache.set(key, products, now());
        info.extra.push(`hits=${products.length}`);
        send(200, { products, source: 'search-a-licious', cached: false }, { 'Cache-Control': 'public, max-age=3600' });
      } catch (err) {
        info.extra.push(`err=${String((err && err.message) || err).slice(0, 80).replace(/\s+/g, '_')}`);
        send(502, { error: 'upstream' });
      }
      return;
    }

    if (!checkAuth(req.headers.authorization, cfg.secret)) {
      req.resume();
      send(401, { error: 'bad secret' });
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/health') {
      haveData();
      send(200, {
        ok: true,
        version: VERSION,
        model: cfg.model,
        brands: brands.length,
        pack: packMeta ? { generated: packMeta.generated, foods: packMeta.foods, brands: packMeta.brands } : null,
        building,
        lastBuildError
      });
      return;
    }

    const brandRoute = pathname === '/v1/brands' || pathname === '/v1/brand-pack' || pathname === '/v1/brand-pack/rebuild';
    if (brandRoute && !haveData()) {
      req.resume();
      send(503, { error: 'no data dir' });
      return;
    }
    if (pathname === '/v1/brands' && req.method === 'GET') {
      req.resume();
      const stored = readJsonFile(files.brands);
      send(200, { brands, updated: (stored && stored.updated) || null });
      return;
    }
    if (pathname === '/v1/brands' && req.method === 'PUT') {
      let list;
      try {
        const raw = await readBody(req, MAX_BRANDS_BODY);
        const parsed = tryJson(raw);
        if (parsed === undefined) throw httpError(400, 'body must be JSON');
        list = validateBrands(parsed);
      } catch (err) {
        send(err.status || 400, { error: err.message || 'bad input' });
        return;
      }
      try {
        await writeAtomic(files.brands, JSON.stringify({ brands: list, updated: new Date(now()).toISOString() }));
      } catch (err) {
        console.error('brands write failed:', err && err.message);
        send(503, { error: 'no data dir' });
        return;
      }
      brands = list;
      info.extra.push(`count=${list.length}`);
      send(200, { ok: true, count: list.length });
      return;
    }
    if (pathname === '/v1/brand-pack' && req.method === 'GET') {
      req.resume();
      let st;
      try {
        st = await stat(files.pack);
      } catch {
        send(404, { error: 'no pack yet' });
        return;
      }
      if (!packCache || packCache.mtimeMs !== st.mtimeMs || packCache.size !== st.size) {
        const buf = await readFile(files.pack);
        packCache = { mtimeMs: st.mtimeMs, size: st.size, buf, etag: `"${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}"` };
      }
      const tags = String(req.headers['if-none-match'] || '').split(',').map((s) => s.trim().replace(/^W\//, ''));
      if (tags.includes(packCache.etag) || tags.includes('*')) {
        res.writeHead(304, { ...cors, ETag: packCache.etag, 'Cache-Control': 'private, no-cache' });
        res.end();
        logReq(304);
        return;
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', ETag: packCache.etag, 'Cache-Control': 'private, no-cache' });
      res.end(packCache.buf);
      logReq(200);
      return;
    }
    if (pathname === '/v1/brand-pack/rebuild' && req.method === 'POST') {
      req.resume();
      if (building) {
        send(200, { started: false, running: true });
        return;
      }
      if (!brands.length) {
        send(409, { error: 'no brands' });
        return;
      }
      startBuild();
      send(202, { started: true });
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

  const timers = [];
  if (schedule) {
    timers.push(setTimeout(tick, 2 * 60 * 1000), setInterval(tick, HOUR));
    for (const t of timers) t.unref();
  }
  server.on('close', () => {
    for (const t of timers) clearTimeout(t);
    buildAbort.abort(new Error('server closed'));
  });
  /** For tests and diagnostics: run the scheduler rule once now; current build state. */
  server.helper = { tick, status: () => ({ building, lastBuildError, lastAttempt, brands: brands.length, pack: packMeta, dataOk }) };
  return server;
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
  const server = createServer(cfg, { schedule: true });
  server.listen(cfg.port, '0.0.0.0', () => {
    const dataNote = server.helper.status().dataOk ? '' : ' (missing or not writable: brand features off)';
    console.log(`MacroTally AI helper ${VERSION} listening on 0.0.0.0:${cfg.port} (model ${cfg.model}, origins ${cfg.origins.join(', ')}, ` +
      `data ${cfg.dataDir}${dataNote})`);
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
