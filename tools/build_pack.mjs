// Builds a MacroTally restaurant food pack (format macrotally-pack/1, see SPEC-packs.md) from a chain's
// public Nutritionix menu table, https://www.nutritionix.com/<slug>/menu/premium. Node 18+, no dependencies.
//
// Usage (from the project root):
//   node tools/build_pack.mjs --nutritionix taco-bell --name "Taco Bell" [--brand "Taco Bell"]
//                             [--out data/packs/taco-bell.json] [--skip "Section A,Section B"] [--dry]
//                             [--drop "<regex>"]... [--from saved-page.html]
// --skip drops whole menu sections (comma-separated, case-insensitive exact names; recorded in the pack as
// "skipped"). --drop leaves out items whose cleaned name matches a case-insensitive JavaScript regex (may be
// given more than once; recorded in the pack as "dropped"). --from parses a saved copy of the page instead of fetching it. --dry prints per-section
// counts and the first 10 items instead of writing.
//
// The page is treated as untrusted data: it is only scanned with regular expressions and copied field by
// field into plain strings and numbers.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORMAT = 'macrotally-pack/1';

// ---------- HTML helpers ----------

/** Named entities seen on Nutritionix pages (anything else numeric is decoded generically). */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', reg: '®', trade: '™', copy: '©',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', ndash: '–', mdash: '—', hellip: '…', deg: '°',
  frac12: '½', frac14: '¼', frac34: '¾', eacute: 'é', egrave: 'è', aacute: 'á', iacute: 'í',
  oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç'
};

/**
 * Windows-1252 characters for numeric references 0x80-0x9F, as browsers decode them (HTML spec);
 * some chain pages write e.g. "&#145;N" or "&#150;". Unassigned codes (0x81, 0x8D, 0x8F, 0x90, 0x9D) are dropped.
 */
const CP1252 = '€\0‚ƒ„…†‡ˆ‰Š‹Œ\0Ž\0\0‘’“”•–—˜™š›œ\0žŸ';

/**
 * Decode HTML character references.
 * @param {string} s
 * @returns {string}
 */
export function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code >= 0x80 && code <= 0x9f) return CP1252[code - 0x80].replace('\0', '');
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const ch = ENTITIES[ref.toLowerCase()];
    return ch === undefined ? m : ch;
  });
}

/** @param {string} html */
const textOf = (html) => unescapeHtml(html.replace(/<[^>]*>/g, ''));

/**
 * Clean a menu item name: tags stripped, entities decoded, ®/™/U+FFFD removed, asterisk-wrapped markers
 * ("*Local Specialty*") and stray footnote asterisks ("*Naked - Wing") removed, whitespace collapsed.
 * A mark glued between two words ("Tajín®Taco") becomes a space so the words stay apart.
 * @param {string} html
 * @returns {string}
 */
export function cleanName(html) {
  return textOf(html)
    .replace(/(?<=[\p{L}\p{N}])[®™\uFFFD](?=[\p{L}\p{N}])/gu, ' ')
    .replace(/[®™\uFFFD]/gu, '')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Numeric value of a table cell: tags stripped, commas removed, "<1" -> 0.5 (generally "<N" -> N / 2),
 * blank -> 0. Returns null when the cell is not a number at all.
 * @param {string} html
 * @returns {number|null}
 */
export function cellValue(html) {
  const t = textOf(html).replace(/,/g, '').replace(/\s+/g, '');
  if (!t) return 0;
  const less = /^<(\d+(?:\.\d+)?)$/.exec(t);
  if (less) return Number(less[1]) / 2;
  const n = Number(t.replace(/(mg|g|kcal|cal)$/i, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
}

// ---------- Serving labels ----------

/**
 * Serving label guessed from the item name and section (lowercase match, first hit wins).
 * The brand words "taco bell" are ignored so "Taco Bell Diablo Sauce" is not a taco.
 * @param {string} name
 * @param {string} section
 * @returns {string}
 */
export function servingLabel(name, section) {
  const n = name.toLowerCase().replace(/taco bell/g, '');
  const sec = section.toLowerCase().replace(/taco bell/g, '');
  const both = `${n} | ${sec}`;
  if (/taco/.test(both)) return '1 taco';
  if (/burrito/.test(both)) return '1 burrito';
  if (/quesadilla/.test(both)) return '1 quesadilla';
  if (/bowl/.test(both)) return '1 bowl';
  if (/nachos|fries|chips/.test(both)) return '1 order';
  const oz = /\((\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\.?\)/.exec(n) || /\((\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\.?\)/.exec(sec);
  if (oz) return `1 drink (${oz[1]} oz)`;
  if (/drink|beverage|coffee|caf[eé]|soda|beer|wine|spirits/.test(sec)) return '1 drink';
  if (/\d+\s*-?\s*(?:piece|pc)s?\b/.test(n)) return '1 order';
  return '1 serving';
}

// ---------- Parser ----------

/** Nutritionix sort keys of the columns a pack needs. */
const NEEDED = ['calories', 'protein', 'total_carb', 'total_fat', 'fibers'];

/**
 * @typedef {{ id: string, n: string, cat?: string, s: [string, null], v: number[] }} PackFood
 * @typedef {{ name: string, count: number, skipped?: true }} PackSection
 */

/** @param {string} s */
const skipParts = (s) => s.split(',').map((x) => x.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);

/**
 * Split a `--skip` value ("Section A,Section B") into lowercase tokens.
 * @param {string} arg
 * @returns {string[]}
 */
export function splitSkip(arg) {
  return skipParts(arg);
}

/**
 * Whether a section is named by the skip tokens (case-insensitive exact match). Section names that
 * themselves contain commas ("Cantina Beer, Wine and Spirits") match when their comma-separated parts
 * appear as consecutive tokens, so they can be listed in a comma-separated --skip value as written.
 * @param {string} name
 * @param {string[]} tokens
 * @returns {boolean}
 */
export function sectionSkipped(name, tokens) {
  const parts = skipParts(name);
  if (!parts.length || !tokens.length) return false;
  if (tokens.includes(parts.join(', '))) return true;
  for (let i = 0; i + parts.length <= tokens.length; i++) {
    if (parts.every((p, j) => tokens[i + j] === p)) return true;
  }
  return false;
}

/**
 * Parse a Nutritionix "menu/premium" page into pack foods.
 * Column order comes from the <thead> sort links; `<tr class="subCategory">` rows set the section;
 * rows are identified by the `-item-<id>-` part of the a.nmItem id (food id "<id>"), or by
 * `-ingredient-<id>-` (fountain drinks; food id "i<id>"). Rows without a calories value, with an id
 * already seen, or in a section named by `opts.skip` (tokens from splitSkip) are skipped; skipped
 * sections are still listed, with `skipped: true` and count 0. Rows whose cleaned name matches one of
 * `opts.drop` (RegExp, or strings compiled case-insensitively) are left out and returned in `dropped`;
 * like skipped rows, they do not claim their id, and section counts include kept rows only.
 * @param {string} html
 * @param {{ skip?: string[], drop?: (string|RegExp)[] }} [opts]
 * @returns {{ foods: PackFood[], sections: PackSection[], dropped: { id: string, n: string, cat?: string }[] }}
 */
export function parseNutritionixMenu(html, opts = {}) {
  const skip = Array.isArray(opts.skip) ? opts.skip.map((t) => String(t).trim().toLowerCase()) : [];
  const drop = (Array.isArray(opts.drop) ? opts.drop : [])
    .map((r) => (r instanceof RegExp ? new RegExp(r.source, r.flags.replace(/[gy]/g, '')) : new RegExp(String(r), 'i')));
  /** @type {{ id: string, n: string, cat?: string }[]} */
  const dropped = [];
  const thead = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(html);
  if (!thead) throw new Error('No <thead> found: is this a Nutritionix menu page?');
  /** @type {Record<string, number>} */
  const col = {};
  const ths = thead[1].match(/<th\b[\s\S]*?<\/th>/gi) || [];
  ths.forEach((th, i) => {
    const m = /(?:[?&]|&amp;)sort=([a-z_]+)/i.exec(th);
    if (m && !(m[1] in col)) col[m[1]] = i;
  });
  const missing = NEEDED.filter((k) => !(k in col));
  if (missing.length) throw new Error(`Menu table is missing column(s): ${missing.join(', ')}`);

  const bodyStart = thead.index + thead[0].length;
  const body = html.slice(bodyStart);
  /** @type {PackFood[]} */
  const foods = [];
  /** @type {PackSection[]} */
  const sections = [];
  const seen = new Set();
  /** @type {PackSection|null} */
  let section = null;

  for (const tr of body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)) {
    const attrs = tr[1];
    const inner = tr[2];
    if (/\bclass="[^"]*\bsubCategory\b/i.test(attrs)) {
      const h3 = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(inner);
      const name = h3 ? textOf(h3[1]).replace(/\s+/g, ' ').trim() : '';
      section = name ? { name, count: 0 } : null;
      if (section && sectionSkipped(name, skip)) section.skipped = true;
      if (section) sections.push(section);
      continue;
    }
    if (section && section.skipped) continue;
    const a = /<a\b([^>]*\bclass="[^"]*\bnmItem\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i.exec(inner);
    if (!a) continue;
    const idm = /\bid="z[^"]*?-(item|ingredient)-(\d+)-/i.exec(a[1]);
    if (!idm) continue;
    const id = (idm[1].toLowerCase() === 'ingredient' ? 'i' : '') + idm[2];
    if (seen.has(id)) continue;
    const n = cleanName(a[2]);
    if (!n) continue;
    const cells = inner.match(/<td\b[^>]*>[\s\S]*?<\/td>/gi) || [];
    const cell = (key) => {
      const c = cells[col[key]];
      return c === undefined ? null : cellValue(c.replace(/^<td\b[^>]*>|<\/td>$/gi, ''));
    };
    const kcalCell = cells[col.calories];
    if (kcalCell === undefined || !textOf(kcalCell.replace(/^<td\b[^>]*>|<\/td>$/gi, '')).trim()) continue;
    const kcal = cell('calories');
    if (kcal === null) continue;
    if (drop.some((re) => re.test(n))) {
      dropped.push(section ? { id, n, cat: section.name } : { id, n });
      continue;
    }
    seen.add(id);
    const v = [kcal, cell('protein') ?? 0, cell('total_carb') ?? 0, cell('total_fat') ?? 0, cell('fibers') ?? 0];
    /** @type {[string, null]} */
    const s = [servingLabel(n, section ? section.name : ''), null];
    if (section) section.count++;
    foods.push(section ? { id, n, cat: section.name, s, v } : { id, n, s, v });
  }
  return { foods, sections, dropped };
}

// ---------- CLI ----------

/**
 * Minimal `--key value` / `--flag` parser; `--drop` may repeat and is collected into an array.
 * @param {string[]} argv
 * @returns {Record<string, string|boolean|string[]>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean|string[]>} */
  const out = { drop: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const key = a.slice(2);
    if (key === 'dry') { out.dry = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
    if (key === 'drop') /** @type {string[]} */ (out.drop).push(val);
    else out[key] = val;
    i++;
  }
  return out;
}

const USAGE = 'Usage: node tools/build_pack.mjs --nutritionix <slug> --name "<Chain name>" [--brand "<Brand>"] ' +
  '[--out data/packs/<slug>.json] [--skip "Section A,Section B"] [--drop "<regex>"]... [--dry] [--from saved-page.html]';

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }
  const slug = typeof args.nutritionix === 'string' ? args.nutritionix : '';
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!/^[a-z0-9-]+$/.test(slug) || !name) {
    console.error('--nutritionix <slug> (lowercase letters, digits and dashes) and --name are required.');
    console.error(USAGE);
    process.exit(1);
  }
  const brand = typeof args.brand === 'string' && args.brand.trim() ? args.brand.trim() : name;
  const out = typeof args.out === 'string' ? resolve(args.out) : resolve(ROOT, 'data', 'packs', `${slug}.json`);
  const url = `https://www.nutritionix.com/${slug}/menu/premium`;
  const skip = typeof args.skip === 'string' ? splitSkip(args.skip) : [];
  const dropArgs = /** @type {string[]} */ (args.drop);
  for (const r of dropArgs) {
    try {
      new RegExp(r, 'i');
    } catch (err) {
      console.error(`--drop is not a valid regular expression: ${err.message}`);
      process.exit(1);
    }
  }

  let html;
  if (typeof args.from === 'string') {
    html = readFileSync(resolve(args.from), 'utf8');
    console.log(`Parsing ${args.from} (${(html.length / 1024).toFixed(0)} KB)`);
  } else {
    console.log(`Fetching ${url}`);
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.error(`Request failed: ${err.message}`);
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`Request refused: HTTP ${res.status} ${res.statusText}`);
      console.error('Save the page from a browser and rerun with --from <file.html>.');
      process.exit(1);
    }
    html = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  }

  let parsed;
  try {
    parsed = parseNutritionixMenu(html, { skip, drop: dropArgs });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { foods, sections, dropped } = parsed;
  const skipped = sections.filter((s) => s.skipped).map((s) => s.name);
  const unmatched = skip.filter((t) => !skipped.some((n) => n.toLowerCase().split(',').map((p) => p.trim()).includes(t) ||
    n.toLowerCase() === t));
  if (unmatched.length) console.warn(`WARNING: --skip names not found on the page: ${unmatched.join(', ')}`);
  if (!foods.length) {
    console.error('No menu items found: the page layout may have changed.');
    process.exit(1);
  }

  console.log('Per section:');
  for (const s of sections) console.log(`  ${s.skipped ? ' skip' : String(s.count).padStart(5)}  ${s.name}`);
  const noSection = foods.filter((f) => !f.cat).length;
  if (noSection) console.log(`  ${String(noSection).padStart(5)}  (no section)`);
  if (dropArgs.length) console.log(`Dropped by --drop: ${dropped.length} items.`);
  console.log(`Total: ${foods.length} items.`);

  if (args.dry) {
    console.log('First 10 items:');
    for (const f of foods.slice(0, 10)) console.log(`  ${f.id}  ${f.n}  [${f.cat ?? ''}]  ${f.s[0]}  ${JSON.stringify(f.v)}`);
    console.log('Dry run: nothing written.');
    return;
  }

  // Validate before writing (same rules as the app's loader).
  for (const f of foods) {
    const ok = typeof f.id === 'string' && f.id && typeof f.n === 'string' && f.n &&
      Array.isArray(f.v) && f.v.length === 5 && f.v.every((x) => Number.isFinite(x) && x >= 0) &&
      Array.isArray(f.s) && typeof f.s[0] === 'string' && f.s[1] === null;
    if (!ok) throw new Error(`Invalid food entry: ${JSON.stringify(f)}`);
  }

  const pack = {
    format: FORMAT,
    id: slug,
    name,
    brand,
    source: url,
    ...(skipped.length ? { skipped } : {}),
    ...(dropArgs.length ? { dropped: dropArgs } : {}),
    generated: new Date().toISOString().slice(0, 10),
    foods
  };
  const json = JSON.stringify(pack);
  JSON.parse(json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json + '\n');
  console.log(`Wrote ${out} (${(statSync(out).size / 1024).toFixed(1)} KB).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
