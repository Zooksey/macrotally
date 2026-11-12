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
 *
 * The same pass can also build a servings index (barcode -> serving grams, every country) for the helper's
 * search relay: createServingCollector, encodeServingIndex / decodeServingIndex, lookupServing.
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

/** Largest serving_quantity (grams) taken as a serving; anything bigger is treated as missing. */
export const MAX_SERVING_G = 1000;

/**
 * Serving grams from a serving_quantity cell: a finite number > 0 and <= MAX_SERVING_G, rounded to 0.1 g (a value
 * that rounds to 0 is kept as is); 0 when blank, non-numeric or out of range. Shared by rowToFood and the
 * servings index so both read a row the same way.
 * @param {string|number} text
 * @returns {number}
 */
export function servingGrams(text) {
  const sq = num(text);
  if (!Number.isFinite(sq) || sq <= 0 || sq > MAX_SERVING_G) return 0;
  return r1(sq) || sq;
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
  const grams = servingGrams(cell(cols, idx, 'serving_quantity'));
  let s;
  let v;
  if (grams > 0) {
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

// ---------- servings index (barcode -> serving grams) ----------

/** Servings index file magic (8 bytes), followed by uint32 LE count, count float64 LE codes, count float32 LE grams. */
export const SERVING_MAGIC = 'MTSRV001';
const SERVING_HEAD = 12;

/**
 * Collects (barcode, serving grams) pairs in growable typed arrays (12 bytes per entry, no per-row objects or
 * strings). add() takes a code of 8 to 14 digits and grams > 0 and <= MAX_SERVING_G (anything else is skipped);
 * finish() returns the entries sorted by code, a code seen twice keeping its first grams (call it once: it frees
 * the collector, and add() returns false afterwards).
 * @param {number} [initial] starting capacity
 * @returns {{add: (code: string, grams: number) => boolean, readonly size: number,
 *   finish: () => {codes: Float64Array, grams: Float32Array}}}
 */
export function createServingCollector(initial = 1 << 16) {
  let cap = Math.max(16, initial | 0);
  let codes = new Float64Array(cap);
  let grams = new Float32Array(cap);
  let n = 0;
  let done = false;
  return {
    add(code, g) {
      if (done) return false;
      const c = typeof code === 'string' ? code.trim() : '';
      if (!/^\d{8,14}$/.test(c)) return false;
      if (typeof g !== 'number' || !Number.isFinite(g) || g <= 0 || g > MAX_SERVING_G) return false;
      if (n === cap) {
        cap *= 2;
        const nc = new Float64Array(cap);
        nc.set(codes);
        codes = nc;
        const ng = new Float32Array(cap);
        ng.set(grams);
        grams = ng;
      }
      codes[n] = Number(c);
      grams[n] = g;
      n++;
      return true;
    },
    get size() {
      return n;
    },
    finish() {
      // Stable LSD radix sort on the code (integers < 10^14 < 2^48: three 16-bit digits), carrying each entry's
      // insertion index; stable, so within a run of equal codes the first entry comes first and is the one kept.
      // About ten times faster than a comparator sort on millions of entries, so the event loop is not held long.
      let keys = codes.slice(0, n);
      codes = new Float64Array(0);
      let ord = new Uint32Array(n);
      for (let i = 0; i < n; i++) ord[i] = i;
      let keys2 = new Float64Array(n);
      let ord2 = new Uint32Array(n);
      const count = new Uint32Array(65537);
      for (const div of [1, 65536, 4294967296]) {
        count.fill(0);
        for (let i = 0; i < n; i++) count[(Math.floor(keys[i] / div) % 65536) + 1]++;
        for (let d = 1; d <= 65536; d++) count[d] += count[d - 1];
        for (let i = 0; i < n; i++) {
          const pos = count[Math.floor(keys[i] / div) % 65536]++;
          keys2[pos] = keys[i];
          ord2[pos] = ord[i];
        }
        [keys, keys2] = [keys2, keys];
        [ord, ord2] = [ord2, ord];
      }
      const outC = new Float64Array(n);
      const outG = new Float32Array(n);
      let m = 0;
      for (let k = 0; k < n; k++) {
        if (m && outC[m - 1] === keys[k]) continue;
        outC[m] = keys[k];
        outG[m] = grams[ord[k]];
        m++;
      }
      grams = new Float32Array(0);
      n = 0;
      cap = 0;
      done = true;
      return { codes: outC.slice(0, m), grams: outG.slice(0, m) };
    }
  };
}

/**
 * Servings index -> file bytes (SERVING_MAGIC, uint32 LE count, float64 LE codes, float32 LE grams).
 * @param {{codes: Float64Array, grams: Float32Array}} idx
 * @returns {Buffer}
 */
export function encodeServingIndex(idx) {
  const n = idx.codes.length;
  const buf = Buffer.alloc(SERVING_HEAD + n * 12);
  buf.write(SERVING_MAGIC, 0, 'latin1');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  dv.setUint32(8, n, true);
  const g0 = SERVING_HEAD + n * 8;
  for (let i = 0; i < n; i++) {
    dv.setFloat64(SERVING_HEAD + i * 8, idx.codes[i], true);
    dv.setFloat32(g0 + i * 4, idx.grams[i], true);
  }
  return buf;
}

/**
 * File bytes -> servings index, or null when the bytes are not a valid index (wrong magic or length, codes not
 * strictly ascending, grams not positive).
 * @param {Uint8Array} buf
 * @returns {{codes: Float64Array, grams: Float32Array}|null}
 */
export function decodeServingIndex(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < SERVING_HEAD) return null;
  if (Buffer.from(buf.buffer, buf.byteOffset, 8).toString('latin1') !== SERVING_MAGIC) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const n = dv.getUint32(8, true);
  if (buf.length !== SERVING_HEAD + n * 12) return null;
  const codes = new Float64Array(n);
  const grams = new Float32Array(n);
  const g0 = SERVING_HEAD + n * 8;
  for (let i = 0; i < n; i++) {
    const c = dv.getFloat64(SERVING_HEAD + i * 8, true);
    const g = dv.getFloat32(g0 + i * 4, true);
    if (!(c >= 0) || (i && !(c > codes[i - 1])) || !(g > 0)) return null;
    codes[i] = c;
    grams[i] = g;
  }
  return { codes, grams };
}

/**
 * Serving grams for a barcode (binary search on its numeric value, so leading zeros do not matter), or 0 when the
 * code is not in the index, empty or not all digits.
 * @param {{codes: Float64Array, grams: Float32Array}|null} idx
 * @param {string|number} code
 * @returns {number}
 */
export function lookupServing(idx, code) {
  if (!idx || !idx.codes || !idx.codes.length) return 0;
  const s = String(code ?? '').trim();
  if (!/^\d{1,14}$/.test(s)) return 0;
  const x = Number(s);
  const { codes } = idx;
  let lo = 0;
  let hi = codes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = codes[mid];
    if (v === x) return idx.grams[mid];
    if (v < x) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

/** Cell `col` of a tab-separated line, found without splitting the whole line ('' when the line is shorter). */
function cellAt(line, col) {
  let start = 0;
  for (let i = 0; i < col; i++) {
    const t = line.indexOf('\t', start);
    if (t < 0) return '';
    start = t + 1;
  }
  const end = line.indexOf('\t', start);
  return end < 0 ? line.slice(start) : line.slice(start, end);
}

/**
 * Stream the export (URL or local file), calling onRow(cols, idx) for each data row. Never buffers the file:
 * gunzip (multi-member safe) -> incremental UTF-8 decode -> line split. Cells are split on tab only (quotes are
 * data). Yields to the event loop every `yieldEvery` lines so a server stays responsive.
 * With `servings`, every data row (before lineFilter) also feeds its code and serving_quantity (read with
 * servingGrams) to the collector; only those two cells are read, the line is not split.
 * @param {object} o
 * @param {string} [o.url] export URL (gzip); ignored when `file` is given
 * @param {string} [o.file] local .csv.gz or .csv
 * @param {typeof fetch} [o.fetchImpl]
 * @param {(cols: string[], idx: Record<string, number>) => any} [o.onRow] may return a promise; without it rows
 *   are only counted (and fed to `servings`)
 * @param {ReturnType<typeof createServingCollector>} [o.servings] servings index collector
 * @param {AbortSignal} [o.signal]
 * @param {(line: string) => boolean} [o.lineFilter] cheap pre-check on the raw line; false skips the row
 * @param {(rows: number) => void} [o.onProgress] called every `progressEvery` data rows
 * @returns {Promise<{rows: number}>} rows = data rows read (before lineFilter)
 */
export async function streamExport({
  url = EXPORT_URL, file, fetchImpl = globalThis.fetch, onRow, servings, signal, lineFilter, onProgress,
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
  let codeCol = -1;
  let sqCol = -1;
  const handle = async (raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (idx === null) {
      idx = {};
      line.replace(/^﻿/, '').split('\t').forEach((h, i) => {
        const k = h.trim();
        if (k && idx[k] === undefined) idx[k] = i;
      });
      if (servings && idx.code !== undefined && idx.serving_quantity !== undefined) {
        codeCol = idx.code;
        sqCol = idx.serving_quantity;
      }
      return;
    }
    if (!line) return;
    rows++;
    if (onProgress && rows % progressEvery === 0) onProgress(rows);
    if (sqCol >= 0) {
      const sq = cellAt(line, sqCol);
      if (sq) {
        const g = servingGrams(sq);
        if (g > 0) servings.add(cellAt(line, codeCol), g);
      }
    }
    if (!onRow) return;
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
