/**
 * MacroTally: build product food packs (format `macrotally-pack/1`, kind `products`) from the Open Food Facts
 * full export (a gzip TSV of every product). Pure helpers plus a streaming reader, shared by
 * tools/build_off_pack.mjs (the bundled "Popular products" pack) and server/ai-server.mjs (the per-user
 * "Brands you use" pack). Plain Node 22, no dependencies.
 *
 * Row rules (rowToFood), kept deliberately simple:
 * - code is 8 to 14 digits; product_name is non-empty after collapsing whitespace and at most 90 characters;
 * - kcal, protein, carbs and fat per 100 g all parse as finite numbers >= 0, kcal <= 950 and p + c + f <= 105;
 * - energy: a row with kcal > 0 is kept; a row with kcal = 0 is kept only when its macros are not all zero
 *   and 4p + 4c + 9f is at most 25 kcal (diet drinks, sweeteners); so all-zero rows (usually unfilled) and
 *   "0 kcal" rows with real macros are dropped.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';

export const PACK_FORMAT = 'macrotally-pack/1';
/** The daily Open Food Facts product export (302 redirect to the current file, ~1.5 GB gzip). */
export const EXPORT_URL = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
export const USER_AGENT = 'MacroTally-helper/1.8 (personal macro tracker)';

const MAX_NAME = 90;
const MAX_BRAND = 40;
const MAX_LABEL = 40;

/**
 * Brand slug: lowercase, accents stripped, apostrophes removed, other non-alphanumerics -> '-', trimmed.
 * "Kellogg's" -> "kelloggs", "Häagen-Dazs" -> "haagen-dazs".
 * @param {string} name
 * @returns {string}
 */
export function brandSlug(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Brand matching key for a brand name or an OFF brands tag: language prefix ("xx:", "en:") dropped, slugged,
 * dashes removed. "Kellogg's", "xx:kellogg-s" and "xx:kelloggs" all give "kelloggs".
 * @param {string} nameOrTag
 * @returns {string}
 */
export function brandKey(nameOrTag) {
  const s = String(nameOrTag ?? '').trim().replace(/^[a-z]{2}:/i, '');
  return brandSlug(s).replace(/-/g, '');
}

/** Number from an export cell, or NaN for blank / non-numeric text. */
function num(s) {
  if (s === undefined || s === null) return NaN;
  const t = String(s).trim();
  if (!t) return NaN;
  return Number(t);
}
const r1 = (x) => Math.round(x * 10) / 10;
/**
 * A standalone copy of a string. Cells are V8 slices of a large decoded chunk; keeping a slice keeps the whole
 * chunk alive (a full export run otherwise runs out of memory), so every string a food keeps is copied.
 */
const own = (s) => Buffer.from(String(s), 'utf8').toString('utf8');
const cell = (cols, idx, name) => (idx[name] === undefined ? '' : (cols[idx[name]] ?? ''));

/** Comma list cell -> trimmed non-empty entries. */
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Serving label from OFF serving_size text: whitespace collapsed; a trailing "(NN g)" / "(NN ml)" (which the app
 * adds back from the grams) removed; a label that starts with a metric weight ("28 g (1 oz)") becomes its
 * parenthetical ("1 oz"); a bare weight ("40g"), an empty or a too-long label becomes "1 serving".
 * @param {string} text
 * @returns {string}
 */
export function servingLabel(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  const tail = /\s*\(\s*\d+(?:[.,]\d+)?\s*(?:g|gr|grs|grams?|ml|mls)\.?\s*\)\s*$/i;
  for (let i = 0; i < 3 && tail.test(s); i++) s = s.replace(tail, '').trim();
  const metric = /^\d+(?:[.,]\d+)?\s*(?:g|gr|grs|grams?|ml|mls)\b\.?/i;
  if (metric.test(s)) {
    const paren = /\(([^()]+)\)\s*$/.exec(s);
    s = paren ? paren[1].trim() : '';
  }
  if (!s || s.length > MAX_LABEL || !/[a-z0-9]/i.test(s)) return '1 serving';
  return s;
}

/**
 * One export row -> pack food, or null when the row fails the rules in this file's header comment.
 * The food carries transient `scans` (unique_scans_n, 0 when blank) and `keys` (brand keys from brands_tags and
 * brands), which selectPopular / selectBrands strip.
 * @param {string[]} cols tab-split row
 * @param {Record<string, number>} idx column name -> index (from the header row)
 * @returns {{id:string, bc:string, n:string, b:string, s:[string, number], v:number[], scans:number, keys:string[]}|null}
 */
export function rowToFood(cols, idx) {
  const code = cell(cols, idx, 'code').trim();
  if (!/^\d{8,14}$/.test(code)) return null;
  const name = cell(cols, idx, 'product_name').replace(/\s+/g, ' ').trim();
  if (!name || name.length > MAX_NAME) return null;
  const kcal = num(cell(cols, idx, 'energy-kcal_100g'));
  const p = num(cell(cols, idx, 'proteins_100g'));
  const c = num(cell(cols, idx, 'carbohydrates_100g'));
  const f = num(cell(cols, idx, 'fat_100g'));
  for (const x of [kcal, p, c, f]) if (!Number.isFinite(x) || x < 0) return null;
  if (kcal > 950 || p + c + f > 105) return null;
  if (kcal === 0) {
    if (p + c + f === 0) return null;
    if (4 * p + 4 * c + 9 * f > 25) return null;
  }
  let fiber = num(cell(cols, idx, 'fiber_100g'));
  if (!Number.isFinite(fiber) || fiber < 0 || fiber > 100) fiber = 0;

  const brands = list(cell(cols, idx, 'brands'));
  const b = (brands[0] || '').slice(0, MAX_BRAND).trim();
  const keys = new Set();
  for (const t of list(cell(cols, idx, 'brands_tags'))) {
    const k = brandKey(t);
    if (k) keys.add(k);
  }
  for (const n of brands) {
    const k = brandKey(n);
    if (k) keys.add(k);
  }
  const scansRaw = num(cell(cols, idx, 'unique_scans_n'));
  const scans = Number.isFinite(scansRaw) && scansRaw > 0 ? scansRaw : 0;

  const per100 = [kcal, p, c, f, fiber];
  const sq = num(cell(cols, idx, 'serving_quantity'));
  let s;
  let v;
  if (Number.isFinite(sq) && sq > 0 && sq <= 1000) {
    const grams = r1(sq) || sq;
    s = [servingLabel(cell(cols, idx, 'serving_size')), grams];
    v = per100.map((x) => r1((x * grams) / 100));
  } else {
    s = ['100 g', 100];
    v = per100.map(r1);
  }
  const id = own(code);
  s[0] = own(s[0]);
  return { id, bc: id, n: own(name), b: own(b), s, v, scans, keys: [...keys].map(own) };
}

/**
 * Does a row belong to the wanted country? Its countries_tags must include `country`. For en:united-states and
 * en:canada a product tagged with several countries must also carry a US/Canada barcode (GS1 prefix 000-139,
 * or an EAN-8 starting with 0): Open Food Facts has many European and North African products with a stray
 * "United States" tag, and since scans are counted worldwide they would otherwise top a US list. Products tagged
 * with the wanted country alone are always kept (Aldi US, for one, uses 4099100... codes).
 * @param {string} code
 * @param {string} countriesCell comma list, e.g. "en:france,en:united-states"
 * @param {string} country e.g. "en:united-states"; '' keeps everything
 * @returns {boolean}
 */
export function inCountry(code, countriesCell, country) {
  if (!country) return true;
  const tags = list(countriesCell);
  if (!tags.includes(country)) return false;
  if (tags.length === 1 || (country !== 'en:united-states' && country !== 'en:canada')) return true;
  const c = String(code || '').trim();
  if (c.length === 8) return c[0] === '0';
  return c.length >= 12 && Number(c.padStart(13, '0').slice(0, 3)) <= 139;
}

/** De-duplication key: lowercase name + brand key. */
const dedupKey = (f) => `${f.n.toLowerCase()}|${brandKey(f.b)}`;
/** Most scanned first; ties by code so output is stable. */
const byScans = (a, b) => (b.scans || 0) - (a.scans || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A pack food without the transient fields. */
export function stripFood(f) {
  return { id: f.id, bc: f.bc, n: f.n, b: f.b, s: f.s, v: f.v };
}

/**
 * Top n foods by scans, de-duplicated on lowercase name + brand key (the most scanned copy wins).
 * @param {object[]} foods rowToFood results
 * @param {number} n
 * @returns {object[]} stripped pack foods, most scanned first
 */
export function selectPopular(foods, n) {
  const out = [];
  const seen = new Set();
  for (const f of [...foods].sort(byScans)) {
    if (out.length >= n) break;
    const k = dedupKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(stripFood(f));
  }
  return out;
}

/**
 * Foods of the wanted brands: a food matches when any of its brands_tags / brands has the same brandKey as a
 * wanted brand (it counts for the first wanted brand it matches). Per brand the top perBrand by scans are kept
 * (de-duplicated as in selectPopular); when more than `total` remain, brands take turns (each brand's best,
 * then each brand's second best, ...) so a small brand is not crowded out by a big one.
 * @param {object[]} foods rowToFood results
 * @param {string[]} brandNames
 * @param {{perBrand?: number, total?: number}} [opts]
 * @returns {object[]} stripped pack foods
 */
export function selectBrands(foods, brandNames, { perBrand = 1500, total = 20000 } = {}) {
  const wanted = [...new Set((brandNames || []).map(brandKey).filter(Boolean))];
  const groups = new Map(wanted.map((k) => [k, []]));
  for (const f of foods) {
    const keys = f.keys || [brandKey(f.b)];
    const k = wanted.find((w) => keys.includes(w));
    if (k) groups.get(k).push(f);
  }
  const seen = new Set();
  const lists = [];
  for (const k of wanted) {
    const picked = [];
    for (const f of groups.get(k).sort(byScans)) {
      if (picked.length >= perBrand) break;
      const dk = dedupKey(f);
      if (seen.has(dk)) continue;
      seen.add(dk);
      picked.push(f);
    }
    lists.push(picked);
  }
  const out = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < total; i++) {
    for (const l of lists) {
      if (i < l.length && out.length < total) out.push(stripFood(l[i]));
    }
  }
  return out;
}

/**
 * Stream the export (URL or local file), calling onRow(cols, idx) for each data row. Never buffers the file:
 * gunzip (multi-member safe) -> incremental UTF-8 decode -> line split. Cells are split on tab only (quotes are
 * data). Yields to the event loop every `yieldEvery` lines so a server stays responsive.
 * @param {object} o
 * @param {string} [o.url] export URL (gzip); ignored when `file` is given
 * @param {string} [o.file] local .csv.gz or .csv
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(cols: string[], idx: Record<string, number>) => any} o.onRow may return a promise
 * @param {AbortSignal} [o.signal]
 * @param {(line: string) => boolean} [o.lineFilter] cheap pre-check on the raw line; false skips the row
 * @param {(rows: number) => void} [o.onProgress] called every `progressEvery` data rows
 * @returns {Promise<{rows: number}>} rows = data rows read (before lineFilter)
 */
export async function streamExport({
  url = EXPORT_URL, file, fetchImpl = globalThis.fetch, onRow, signal, lineFilter, onProgress,
  progressEvery = 500000, yieldEvery = 5000
}) {
  let source;
  let gz;
  if (file) {
    source = createReadStream(file);
    gz = /\.gz$/i.test(file);
  } else {
    const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
    if (!res || !res.ok || !res.body) throw new Error(`export download failed: HTTP ${res ? res.status : '?'}`);
    source = Readable.fromWeb(res.body);
    gz = true;
  }
  let stream = source;
  if (gz) {
    stream = createGunzip({ chunkSize: 128 * 1024 });
    source.on('error', (e) => stream.destroy(e));
    source.pipe(stream);
  }
  const decoder = new StringDecoder('utf8');
  let rest = '';
  let idx = null;
  let rows = 0;
  let lines = 0;
  const handle = async (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (idx === null) {
      idx = {};
      line.replace(/^﻿/, '').split('\t').forEach((h, i) => {
        const k = h.trim();
        if (k && idx[k] === undefined) idx[k] = i;
      });
      return;
    }
    if (!line) return;
    rows++;
    if (onProgress && rows % progressEvery === 0) onProgress(rows);
    if (lineFilter && !lineFilter(line)) return;
    const r = onRow(line.split('\t'), idx);
    if (r && typeof r.then === 'function') await r;
  };
  try {
    for await (const chunk of stream) {
      if (signal && signal.aborted) throw signal.reason || new Error('aborted');
      const text = rest + decoder.write(chunk);
      const parts = text.split('\n');
      rest = parts.pop();
      for (const p of parts) {
        await handle(p);
        if (++lines % yieldEvery === 0) await new Promise((r) => setImmediate(r));
      }
    }
    const tail = rest + decoder.end();
    if (tail) await handle(tail);
  } finally {
    source.destroy();
    if (stream !== source) stream.destroy();
  }
  if (idx === null) throw new Error('export is empty');
  return { rows };
}

/** Today as YYYY-MM-DD (UTC). */
export function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * A products pack.
 * @param {{id: string, name: string, foods: object[], source?: string, now?: number}} o
 */
export function buildPack({ id, name, foods, source = 'https://world.openfoodfacts.org', now = Date.now() }) {
  return {
    format: PACK_FORMAT,
    kind: 'products',
    id,
    name,
    brand: '',
    source,
    generated: today(now),
    foods: foods.map(stripFood)
  };
}
