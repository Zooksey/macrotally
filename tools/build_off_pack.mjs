// Builds a MacroTally products pack (format macrotally-pack/1, kind "products") from the Open Food Facts full
// export (https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz, ~1.5 GB gzip TSV, updated
// daily). The export is streamed, never stored. Node 22, no dependencies. Row rules: see server/off-pack.mjs.
//
// Usage (from the project root):
//   node tools/build_off_pack.mjs --popular 12000 --country en:united-states --out data/packs/off-popular-us.json
//   node tools/build_off_pack.mjs --brands "Kellogg's,Fairlife" [--country en:united-states] --out my-brands.json
// Options:
//   --from <file>     read a local copy (.csv.gz or plain .csv) instead of downloading
//   --max-kb <kb>     popular mode: lower n until the written file is at most this size
//   --id, --name      override the pack id / name (defaults: off-popular-us / "Popular products (US)", or
//                     my-brands / "Brands you use")
//   --dry             print counts and the first 15 foods instead of writing
// Popular mode keeps only products scanned at least once (unique_scans_n >= 1), most scanned first.
// Country rule (inCountry in server/off-pack.mjs): for en:united-states a product tagged with several countries
// must have a US/Canada barcode.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { EXPORT_URL, brandKey, buildPack, inCountry, rowToFood, selectBrands, selectPopular, streamExport } from '../server/off-pack.mjs';

const USAGE = `Usage:
  node tools/build_off_pack.mjs --popular <n> [--country en:united-states] --out <file> [--max-kb <kb>]
  node tools/build_off_pack.mjs --brands "Brand A,Brand B" [--country <tag>] --out <file>
  common: [--from <export.csv.gz|.csv>] [--id <id>] [--name <name>] [--dry]`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'dry') out.dry = true;
    else {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      out[key] = argv[++i];
    }
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
  const popularN = args.popular !== undefined ? Number(args.popular) : null;
  const brandNames = typeof args.brands === 'string' ? args.brands.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if ((popularN === null) === (brandNames === null) || (popularN !== null && !(popularN > 0)) || (brandNames && !brandNames.length)) {
    console.error(`Give either --popular <n> or --brands "<list>".\n${USAGE}`);
    process.exit(1);
  }
  if (!args.dry && !args.out) {
    console.error(`--out is required (or use --dry).\n${USAGE}`);
    process.exit(1);
  }
  const country = typeof args.country === 'string' ? args.country.trim() : '';
  const id = args.id || (popularN ? 'off-popular-us' : 'my-brands');
  const name = args.name || (popularN ? 'Popular products (US)' : 'Brands you use');

  const foods = [];
  let kept = 0;
  const t0 = Date.now();
  console.log(`Reading ${args.from ? resolve(args.from) : EXPORT_URL}${country ? ` (country ${country})` : ''}`);
  const { rows } = await streamExport({
    url: EXPORT_URL,
    file: args.from ? resolve(args.from) : undefined,
    lineFilter: country ? (line) => line.includes(country) : undefined,
    onProgress: (n) => console.log(`  ${(n / 1e6).toFixed(1)}M rows, ${kept} kept, ${((Date.now() - t0) / 1000).toFixed(0)} s`),
    onRow: (cols, idx) => {
      if (!inCountry(cols[idx.code], cols[idx.countries_tags], country)) return;
      const f = rowToFood(cols, idx);
      if (!f) return;
      if (popularN && f.scans < 1) return;
      foods.push(f);
      kept++;
    }
  });
  console.log(`Read ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(0)} s; ${kept} usable products.`);

  let n = popularN;
  let selected = popularN ? selectPopular(foods, n) : selectBrands(foods, brandNames);
  const make = (list) => JSON.stringify(buildPack({ id, name, foods: list, source: 'https://world.openfoodfacts.org' })) + '\n';
  let json = make(selected);
  const maxBytes = Number(args['max-kb']) > 0 ? Number(args['max-kb']) * 1024 : null;
  if (popularN && maxBytes && Buffer.byteLength(json) > maxBytes) {
    // Largest prefix of the ranked list that fits (binary search).
    let lo = 1;
    let hi = selected.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(make(selected.slice(0, mid))) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    n = lo;
    selected = selected.slice(0, n);
    json = make(selected);
    console.log(`Lowered n to ${n} to fit ${args['max-kb']} KB.`);
  }

  if (brandNames) {
    for (const b of brandNames) console.log(`  ${b}: ${selected.filter((f) => brandKey(f.b) === brandKey(b)).length} (by first brand)`);
  }
  const scansById = new Map(foods.map((f) => [f.id, f.scans]));
  const scans = selected.map((f) => scansById.get(f.id) || 0);
  console.log(`Selected ${selected.length} foods (scans ${scans.length ? Math.min(...scans) : 0} to ${scans.length ? Math.max(...scans) : 0}).`);
  if (args.dry) {
    for (const f of selected.slice(0, 15)) console.log(`  ${f.bc}  ${f.n}  [${f.b}]  ${f.s[0]} ${f.s[1]} g  ${JSON.stringify(f.v)}`);
    console.log('Dry run: nothing written.');
    return;
  }
  const out = resolve(args.out);
  JSON.parse(json);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  const size = statSync(out).size;
  console.log(`Wrote ${out}: ${selected.length} foods, ${(size / 1024).toFixed(1)} KB (${(gzipSync(json).length / 1024).toFixed(1)} KB gzipped).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
