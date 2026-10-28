# Food packs (restaurant menus) — spec

Goal: ship restaurant menus (Taco Bell first) as searchable, offline food lists, and let anyone import
their own pack from a JSON file. Nutritionix publishes a public per-chain menu table
(`https://www.nutritionix.com/<slug>/menu/premium`, e.g. `taco-bell`) that powers the chains' own
nutrition panels; a build tool turns that page into a pack file. A saved copy of the Taco Bell page is
at `data/packs/.nutritionix-taco-bell.sample.html` (fixture; delete it from the repo before committing
if it is larger than 200 KB — it is, so do not commit it).

## 1. Pack file format `macrotally-pack/1`

```json
{
  "format": "macrotally-pack/1",
  "id": "taco-bell",
  "name": "Taco Bell",
  "brand": "Taco Bell",
  "source": "https://www.nutritionix.com/taco-bell/menu/premium",
  "generated": "2026-10-28",
  "foods": [
    { "id": "166727", "n": "Burrito Supreme - Beef", "cat": "Burritos", "s": ["1 burrito", null], "v": [390, 16, 52, 14, 8] }
  ]
}
```

- `id`: lowercase slug `[a-z0-9-]+`. `name`: shown in Settings. `brand`: set on every food (searchable).
- `foods[]`: `id` unique within the pack (string); `n` display name; `cat` optional section name;
  `s` = `[servingLabel, grams|null]`; `v` = `[kcal, protein g, carbs g, fat g, fiber g]` **per serving**.
- Validation (loader and importer): `format` must equal `macrotally-pack/1`, `id`/`name` non-empty strings,
  `foods` an array; a food is dropped when `id`/`n` missing or `v` not an array of >= 4 finite numbers >= 0.
  An imported pack with zero valid foods is rejected with a message.

## 2. Food model: per-serving foods (`servingOnly`)

Restaurant items have no gram weight. A Food gets an optional flag `servingOnly: true`, meaning:
- `per100` holds the nutrients of **one serving** (the name "per100" is kept for compatibility).
- `servings` is exactly `[{ label, grams: 100 }]`, `defaultGrams` is 100 (so `nutrientsFor`/`buildEntry`
  need no change: qty 1 x 100 g -> one serving).
- `unitOptions(food)` returns only `food.servings` (no g / oz) when `servingOnly`.
- `buildEntry` copies `servingOnly: true` onto the entry when the food has it.
- UI must not show grams for these: food rows show `390 kcal / serving` (use the serving label without the
  leading "1 ", e.g. `/ burrito`, when the label starts with "1 "); the detail preview omits the `· N g`;
  the "Per 100 g:" line becomes `Per 1 burrito:`; diary rows show `1 burrito` without `· 100 g`
  (diary.js `unitText` checks `e.servingOnly`); the food rebuilt from an entry for editing
  (diary.js ~line 178) carries `servingOnly` and `servings: [{label, grams: 100}]`.
- Pack conversion (`packFoodToFood(pack, f)` exported from js/packs.js): when `s[1]` is a positive number,
  build a normal per-100 g food (`per100 = v x 100 / grams`, rounded to 2 dp;
  `servings = [{ label: "<label> (<g> g)", grams }]`). When `s[1]` is null -> `servingOnly` food as above.
  Food fields: `id: "pack:<packId>:<foodId>"`, `source: 'pack'`, `packId`, `brand: pack.brand`,
  `category: cat || ''`, `barcode: null`.
- `makeCustomFood`: when `per === 'serving'` and no serving grams are given, produce a `servingOnly`
  custom food (label from `servingLabel` or "1 serving") instead of throwing. The custom-food form's
  serving-grams field becomes optional with hint "leave blank if unknown". Editing such a food re-opens
  with grams blank.

## 3. Loader `js/packs.js`

- `BUNDLED_INDEX = new URL('../data/packs/index.json', import.meta.url)`; index is `{ "packs": ["taco-bell.json"] }`.
- `loadPacks()` (idempotent, never throws; retry on failure like `builtin.js`): fetch the index, then each
  bundled pack; convert; also convert every pack in `state.packs` (user-imported, raw pack JSON keyed by id).
  `packFoods()` sync accessor of all converted foods; `preloadPacks()` fire-and-forget (call from app.js
  beside `preloadBuiltinFoods`). `listPacks()` -> `[{ id, name, count, generated, bundled: boolean }]`.
- `importPack(text)` -> parses, validates (section 1), stores `state.packs[id] = pack` (replacing an older
  copy; a user pack with the same id as a bundled pack overrides it), saves, refreshes the converted list,
  returns `{ id, name, count }`; throws `Error` with a user-readable message on bad input.
- `removePack(id)` deletes a user pack, saves, refreshes.
- store.js: `packs: {}` default; `merge` ensures object; `importJSON` (backup restore) keeps the `packs`
  object from the backup if present. Backups therefore carry user packs.

## 4. Search and ranking

- `modals/food.js` `localResults` passes `builtin: [...builtinFoods(), ...packFoods()]`.
- `scoreFood`: the existing `source === 'builtin'` bonus applies to `'pack'` too (brand tokens already
  match via the brand-prefix rule, so "taco bell burrito" finds pack items).
- Result tag / badge for `source === 'pack'`: the pack `brand` (e.g. "Taco Bell"); library badge likewise.
- Logged pack foods are saved into the library by `saveFood` as today (they keep `source: 'pack'`).

## 5. Settings card "Food packs" (settings.js, after "Food sources")

- Lists `listPacks()`: `Name · N items · updated <generated>`; bundled ones labelled "built in",
  user ones get a "Remove" ghost-danger button (confirmDialog first).
- "Import food pack" button -> hidden `<input type="file" accept=".json,application/json">` -> `importPack`
  -> toast `Imported <name> (<count> items)`; errors toast with the message.
- Hint: "A pack is a JSON file of menu items (see README). Imported packs are stored on this device and
  included in backups."

## 6. Build tool `tools/build_pack.mjs` (Node >= 18, no deps)

```
node tools/build_pack.mjs --nutritionix taco-bell --name "Taco Bell" [--brand "Taco Bell"] [--out data/packs/taco-bell.json] [--dry] [--from file.html]
```
- Fetches `https://www.nutritionix.com/<slug>/menu/premium` with a plain `fetch` (no browser user-agent
  spoofing; if the request is refused, print the status and exit 1). `--from` parses a saved HTML file
  instead of fetching. Decode as UTF-8.
- Export `parseNutritionixMenu(html)` -> `{ foods: [...pack foods], sections: [...] }` so it is testable:
  - Column order comes from the `<thead>` sort links (`?sort=calories|total_fat|saturated_fat|trans_fat|
    cholesterol|sodium|total_carb|fibers|sugars|added_sugars|protein`), not fixed indexes.
  - `<tr class="subCategory">...<h3>Section</h3>` sets the current section.
  - Item rows: id from `id="z...-item-(\d+)-..."` on the `a.nmItem`; name = anchor text, tags stripped,
    entities unescaped, `®`/`™`/U+FFFD removed, whitespace collapsed. Values: `<td class="col">` text,
    inner tags stripped, commas removed, `<1` -> 0.5, blank -> 0. Rows with no calories value or a
    duplicate id are skipped.
  - Serving label heuristic from name/section (lowercase match, first hit wins):
    `taco` -> "1 taco", `burrito` -> "1 burrito", `quesadilla` -> "1 quesadilla", `bowl` -> "1 bowl",
    `nachos`/`fries`/`chips` -> "1 order", `(N oz)` in name -> "1 drink (N oz)", drinks/beverage/coffee
    sections -> "1 drink", `piece`/`pc` with a number -> "1 order", otherwise "1 serving". `s = [label, null]`.
  - `v = [calories, protein, total_carb, total_fat, fibers]`.
- Writes the pack (section 1) with `generated` = today (UTC date), `source` = the URL. `--dry` prints
  counts per section and the first 10 items instead of writing.
- README: new section "Restaurant food packs" (how to find a chain's slug on nutritionix.com, build,
  import a personal pack, the format). Keep the existing style.

## 7. Caching / versions

- sw.js SHELL adds `./js/packs.js`, `./data/packs/index.json`, `./data/packs/taco-bell.json`;
  VERSION -> `v7`. `js/update.js` APP_VERSION -> `1.2.0`.

## 8. Tests

- `tools/test_calc.mjs`: pack conversion (null grams -> servingOnly with per100 = v; 150 g -> per100 scaled),
  `importPack` rejects wrong format / zero valid foods and stores a good pack, `unitOptions` for
  servingOnly has no g/oz, `buildEntry` carries `servingOnly`, `makeCustomFood` without grams.
- `tools/test_pack_tool.mjs` (new, same style): `parseNutritionixMenu` on an inline fixture with a
  subCategory row, a `<1` cell, a comma value and a duplicate id.
