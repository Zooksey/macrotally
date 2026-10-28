# Better search — feature spec (addendum to SPEC.md)

Problem: text search depends entirely on Open Food Facts' `search.pl`, which throttles (~10 searches/min per address), fails under load, ranks poorly, and is weak for generic foods ("chicken breast", "banana"). Barcode lookups are fine.

Three changes:

1. **Built-in generic food list** shipped with the app (`data/foods.json`), searched instantly and offline.
2. **USDA FoodData Central as a first-class live source**, with a shared key in `js/config.js` (per-user key in Settings overrides it), merged with Open Food Facts results, and used as a barcode fallback.
3. **Client-side ranking** of all results (library, built-in, USDA, Open Food Facts) by match quality, completeness and popularity, with de-duplication.

Everything stays static and relative-path. No new third-party scripts.

---

## 1. Built-in food list

### File `data/foods.json` (generated, committed; target 150–400 KB uncompressed)

```json
{
  "version": 1,
  "source": "USDA FoodData Central, Foundation + SR Legacy (public domain)",
  "generated": "2026-10-28",
  "foods": [
    { "id": "usda:171077", "n": "Chicken, breast, skinless, boneless, raw", "c": "Poultry", "p100": [120, 22.5, 0, 2.6, 0], "s": [["1 breast", 174], ["1 oz", 28.35]] }
  ]
}
```

- `id`: `usda:<fdcId>` (same id scheme as live USDA results so the two de-duplicate).
- `n`: name as in USDA `description` (keep USDA's comma style; the UI shows it as-is). `c`: USDA food category description.
- `p100`: `[kcal, protein_g, carbs_g, fat_g, fiber_g]` per 100 g, numbers rounded to 1 decimal, missing → 0. Skip foods with no energy value and no macros.
- `s`: up to 4 household portions `[label, grams]` from USDA `foodPortions` (`portionDescription` or `measureUnit.name` + `amount`, `gramWeight`); skip "Quantity not specified"; grams rounded to 1 decimal. May be `[]`.

### Generator `tools/build_foods.mjs` (Node, no dependencies)

- Uses the FoodData Central API with an API key from the `USDA_API_KEY` environment variable (never hard-code it in the script). Endpoints:
  - `GET https://api.nal.usda.gov/fdc/v1/foods/list?dataType=Foundation&pageSize=200&pageNumber=N` and the same with `dataType=SR%20Legacy` to enumerate ids (the list endpoint returns `fdcId`, `description`, `foodCategory`, `foodNutrients` with `number`, `amount`).
  - `POST https://api.nal.usda.gov/fdc/v1/foods` with body `{ "fdcIds": [...up to 20], "format": "abridged" }` is NOT enough for portions; use `format: "full"` (or `GET /food/{id}`) only for foods that survive the filter, to collect `foodPortions`. Batch 20 ids per request. Stay well under the key's 1,000 requests/hour: sleep ~250 ms between requests, retry once on 429 after 30 s, and print progress.
- Nutrient numbers: 208 energy kcal (fallback 957/958), 203 protein, 205 carbs, 204 fat, 291 fiber.
- Inclusion filter (keep the list useful and small). Keep all Foundation foods. For SR Legacy keep only these categories: Dairy and Egg Products; Spices and Herbs (only the 40 most common by name match of a small allow-list such as salt, pepper, cinnamon, garlic powder, etc.); Fats and Oils; Poultry Products; Soups, Sauces, and Gravies (skip); Sausages and Luncheon Meats; Breakfast Cereals (skip, branded is better); Fruits and Fruit Juices; Pork Products; Vegetables and Vegetable Products; Nut and Seed Products; Beef Products; Beverages (keep only milk, coffee, tea, juices, water, beer, wine, spirits basics); Finfish and Shellfish Products; Legumes and Legume Products; Lamb, Veal, and Game Products; Baked Products (keep bread, bagel, tortilla, pita, English muffin, basics only); Sweets (keep sugar, honey, syrup, chocolate, jam basics); Cereal Grains and Pasta; Fast Foods (skip); Meals, Entrees, and Side Dishes (skip); Snacks (keep popcorn, pretzels, chips basics); Restaurant Foods (skip); Baby Foods (skip); American Indian/Alaska Native Foods (skip).
  Also skip descriptions containing: "with salt" when an unsalted twin exists is NOT required (keep it simple), but skip entries containing "USDA Commodity", "formulated", "babyfood", "infant", "School Lunch", "industrial".
  Within Beef/Pork/Lamb/Poultry, SR Legacy has thousands of cut×grade×cooking combinations: keep entries whose description has at most 7 comma-separated parts and does not contain "trimmed to 1/8" or "trimmed to 1/4" or "select" or "choice" grade qualifiers, and prefer "all grades". Target ≤ 3,500 foods total.
- De-duplicate by lowercased description (keep the Foundation one).
- Sort alphabetically by `n`. Write pretty-printed with 1-space indent? No: write compact JSON (no whitespace) to keep size down.
- Print a summary: counts per category, total, file size.
- Add `npm`-free usage line in README: `USDA_API_KEY=... node tools/build_foods.mjs` (PowerShell: `$env:USDA_API_KEY='...'; node tools/build_foods.mjs`).

### Loader `js/builtin.js` (LOGIC)

```js
/** Lazily fetch ./data/foods.json once; resolves to Food[] (converted to the app's Food shape, source 'builtin'). Returns [] on failure (never throws). */
export async function loadBuiltinFoods(): Promise<Food[]>
/** Synchronous access after load; [] before. */
export function builtinFoods(): Food[]
/** Kick off loading in the background (called from app.js at start). */
export function preloadBuiltinFoods(): void
```
Conversion: `{ id, source: 'builtin', barcode: null, name: n, brand: '', category: c, per100: {cal,p,c,f,fiber}, servings: s.map(([label, grams]) => ({label: `${label} (${grams} g)`, grams})), defaultGrams: first serving grams or 100 }`.
Precache `./data/foods.json` and `./js/builtin.js` in `sw.js`; bump `VERSION` to `'v4'`.

---

## 2. USDA as a first-class source

- `js/config.js`: add `usdaApiKey: '<the key the owner supplies>'` with a comment that it is a free public key shared by everyone using this deployment and can be regenerated at fdc.nal.usda.gov.
- Effective key = `state.profile.usdaKey` if non-empty, else `config.usdaApiKey`. Settings copy for the USDA field becomes "USDA API key (optional: your own key; a shared one is built in)".
- `searchFoods(query, { usdaKey, region })`: run Open Food Facts and USDA **in parallel** always (when an effective key exists). USDA request: `dataType=Foundation,SR Legacy,Branded&pageSize=25`. Each source's failure is swallowed as long as the other produced results; only when both fail (or the only source fails) throw the Open Food Facts error (current behaviour, keep the "scanning still works" tip when no key at all).
- Live USDA results that duplicate a built-in food (same `usda:<id>`) are dropped in favour of the built-in one.
- **Barcode fallback** in `lookupBarcode(code, { usdaKey })`: when Open Food Facts returns nothing and a key exists, `GET /foods/search?query=<digits>&dataType=Branded&pageSize=5` and accept a result whose `gtinUpc`, with leading zeros stripped, equals the scanned code with leading zeros stripped. Convert with `foodFromUSDA`. Update the two existing callers (scanner modal and the typed-barcode path in the add-food modal) to pass the effective key.
- Open Food Facts search: add `unique_scans_n` to `OFF_FIELDS`; `foodFromOFF` stores it as `pop` (number, default 0). Keep the region subdomain and `sort_by=unique_scans_n`.

---

## 3. Ranking and merging (`js/foods.js`)

```js
/** Tokenize: lowercase, strip punctuation, split on whitespace, drop empty. */
export function tokenize(s): string[]
/** Score a food for a query, 0 = no match. */
export function scoreFood(query, food, { localIds = new Set() } = {}): number
/** Rank + de-duplicate a mixed list of foods for a query. Returns the sorted list (best first), max `limit`. */
export function rankFoods(query, foods, { limit = 40, localIds } = {}): Food[]
/** Search the built-in list + the user's library synchronously (no network). Returns ranked Food[]. */
export function searchLocal(query, { library, builtin, recents, favorites }): Food[]
```

Scoring (keep it simple, deterministic, documented in JSDoc):
- `name = tokenize(food.name)`, `brand = tokenize(food.brand)`, `q = tokenize(query)`. If `q` is empty → 0.
- Coverage: for each query token, +3 if some name token starts with it (prefix match), +1.5 if only a brand token does, +0.5 if it appears inside a name token (substring). If any query token matches nothing → score × 0.25 (rather than 0, so misspellings still surface).
- Phrase bonus: +4 if `food.name.toLowerCase()` contains the whole trimmed lowercased query; +3 more if the name starts with it.
- Position: +2 if the first query token matches the first name token.
- Completeness: −3 if `per100.cal` is 0 and `p/c/f` are all 0; −1 if `per100.cal` is 0.
- Length penalty: −0.05 per name token beyond 6 (long USDA descriptions rank below short ones at equal match).
- Popularity: + `Math.log10(1 + (food.pop || 0))` × 0.8 (Open Food Facts scans); built-in foods get +1.5 flat (they are curated); library foods (`localIds` has the id) get +3, favorites +2 more, recents +1 more (pass these via `localIds`/options as you see fit; keep the signature above but you may add optional fields).
- De-duplication key: `food.barcode` when present, else `${tokenize(name).join(' ')}|${tokenize(brand).join(' ')}`; keep the higher-scored one.

---

## UI (`js/modals/food.js`)

- On input (after the 650 ms debounce) **and immediately on each keystroke for local results**: render `searchLocal(...)` instantly under one combined "Results" heading (library items are marked with a small "★" if favorite or a "library" tag; built-in with a "USDA" tag; keep `foodRow` but allow a tag string). Then, after the debounce, run `searchFoods` and re-render the combined, re-ranked list `rankFoods(q, [...local, ...api])`. While the network search runs, show a small "Searching…" line under the local results instead of replacing them; on network error show the error line under the local results (not instead of them). If there are no local results and the network fails, show the error as today.
- Add-food sheet with an empty query: keep the Recent / Favorites / My foods segmented tabs as today.
- The typed-barcode path (8–14 digits) stays, now with the USDA fallback via `lookupBarcode`.
- `app.js`: call `preloadBuiltinFoods()` at start (fire-and-forget).

## Tests (`tools/test_calc.mjs`, add cases)
- `tokenize`, `scoreFood` ordering: for query "chicken breast", a food named "Chicken, breast, skinless, boneless, raw" outranks "Chicken breast sandwich" (no, both match; ensure the shorter, phrase-matching one wins) and outranks "Pork chop" (0.25 factor). Library boost beats built-in boost at equal match. De-duplication by barcode.
- `foodFromOFF` keeps `pop` from `unique_scans_n`.
- `searchLocal` with a tiny builtin list returns ranked results and never throws on odd input (empty string, symbols).

## Acceptance (reviewer)
- `data/foods.json` exists, ≤ 400 KB, ≥ 1,500 foods, valid JSON, every food has id/n/c/p100 (5 numbers)/s.
- Typing "chicken breast" shows built-in results instantly (offline too), then merged live results; "oats" shows Quaker/Bob's Red Mill near the top; "nurri" (a branded shake) finds it via live sources.
- Scanning a barcode that Open Food Facts lacks but USDA Branded has returns the USDA product.
- With network blocked, search still returns library + built-in results with a quiet error line.
- Unit tests pass; `node --check` clean; `sw.js` VERSION bumped.
