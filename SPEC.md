# MacroTally — architecture & module spec

A free, account-less replacement for MacroFactor. Static progressive web app (PWA): plain HTML/CSS/JS ES modules, **no build step, no framework, no backend**. Hosted on GitHub Pages (or any static host). All user data lives in the browser's `localStorage` on the user's device. Food lookups go directly from the device to public APIs (Open Food Facts, optional USDA FoodData Central).

Must work on **iOS Safari (home-screen PWA)** and **Android Chrome**. Mobile-first UI, dark mode via `prefers-color-scheme`. Everything must work when served from a sub-path (e.g. `https://user.github.io/macrotally/`), so **all URLs are relative** (`./js/app.js`, `./sw.js`, never `/js/...`).

## Core features (priority order)
1. Barcode scanning → food lookup (Open Food Facts) → log it.
2. Portion scaling by weight (grams / oz / servings) with live macro preview.
3. Daily macro tracking (calories, protein, carbs, fat; fiber tracked but secondary) against targets, per meal.
4. Goal setting: lose/maintain/gain, target weight, rate per week, protein & fat preferences → calorie + macro targets.
5. Body-weight logging with **trend weight** (exponentially weighted moving average) and chart.
6. **Adaptive expenditure** (TDEE) estimated from logged intake vs trend-weight change, refreshed weekly, which drives the calorie target (this is the MacroFactor "algorithm").
7. Backup export/import (JSON file). Install as PWA (offline app shell).

## File layout

```
index.html
manifest.webmanifest
sw.js
css/app.css
js/store.js          state, persistence, dates, units        (LOGIC)
js/calc.js           trend, expenditure, targets, totals     (LOGIC)
js/foods.js          Open Food Facts / USDA lookup + scaling (LOGIC)
js/scanner.js        camera barcode scanning                 (LOGIC)
js/charts.js         inline-SVG line + bar charts            (LOGIC)
js/feed.js           weight feed: Apple Health → Shortcut → GitHub gist → weights (LOGIC)
js/ui.js             DOM helpers, action registry, modals    (UI)
js/app.js            bootstrap, router, tab bar, render loop (UI)
js/views/diary.js    (UI)
js/views/weight.js   (UI)
js/views/plan.js     (UI)
js/views/settings.js (UI)
js/modals/food.js    add-food search, food detail/amount, custom food editor, scanner modal (UI)
js/modals/setup.js   first-run wizard (UI)
icons/icon-192.png, icons/icon-512.png, icons/icon.svg
tools/make_icons.py  generates the PNGs with only the Python stdlib (zlib/struct), no PIL
README.md
```

Code style: ES2020 modules, `const`/`let`, no semicolons-optional debates (use semicolons), 2-space indent, small pure functions, JSDoc on every export. No external dependencies except the ZXing barcode library loaded lazily from a CDN by `scanner.js` as a fallback.

---

## js/store.js (LOGIC)

```js
export const KG_PER_LB = 0.45359237;
export const STORAGE_KEY = 'macrotally_v1';

// Dates are ALWAYS 'YYYY-MM-DD' local-date strings.
export function todayStr(d = new Date()): string
export function parseDate(s: string): Date          // local midnight
export function addDays(s: string, n: number): string
export function daysBetween(a: string, b: string): number   // b - a, integer
export function uid(): string

export function defaults(): State                   // fresh default state (see shape below)
export let state: State                             // live binding; mutate in place then save()
export function save(): void                        // JSON → localStorage; swallow quota errors but console.warn
export function replaceState(obj: object): void     // state = Object.assign(defaults(), obj) ; save()
export function resetAll(): void                    // state = defaults(); save()
export function exportJSON(): string                // pretty JSON of state
export function importJSON(text: string): void      // parse; throw Error('Not a MacroTally backup') unless obj.diary && obj.version; replaceState

// Units (profile.units is 'metric' | 'imperial')
export function toKg(value: number, units): number       // imperial → lb to kg
export function fromKg(kg: number, units): number
export function weightUnit(units): 'kg' | 'lb'
export function fmtWeight(kg: number, units, digits = 1): string   // "182.4 lb" / "82.7 kg"

// Diary / foods / weights helpers (all call save())
export function getDay(date): { entries: Entry[] }  // creates if missing (does NOT save on create)
export function addEntry(date, entry: Entry): void  // push + touchRecent(entry.foodId) + save
export function updateEntry(date, entryId, patch): void
export function removeEntry(date, entryId): void
export function touchRecent(foodId): void           // move to front, max 40
export function toggleFavorite(foodId): boolean     // returns new favorite status
export function saveFood(food: Food): void          // state.foods[food.id] = food; save
export function deleteFood(foodId): void
export function addWeight(date, kg): void           // replace same-date entry, keep sorted asc by date
export function removeWeight(date): void
```

State shape:

```js
{
  version: 1,
  onboarded: false,
  profile: { name:'', sex:'male'|'female', birthYear:1990, heightCm:175, units:'imperial'|'metric', activity:1.4, usdaKey:'' },
  // activity: 1.2 sedentary, 1.4 light, 1.55 moderate, 1.7 active, 1.9 very active — used only for the INITIAL expenditure
  goal: {
    mode: 'lose'|'maintain'|'gain',
    targetWeightKg: null|number,
    rateKgPerWeek: 0.45,          // MAGNITUDE; sign comes from mode
    proteinPerKg: 1.8,            // g protein per kg bodyweight (trend)
    fatPct: 0.28,                 // fraction of calories from fat
    macroMode: 'auto'|'manual',
    manual: { cal:2000, p:150, c:200, f:65 },
    startDate: null|string
  },
  expenditure: { kcal:null|number, method:'formula'|'adaptive'|null, updatedAt:null|string, detail:null|object, history:[{date,kcal,method}] },
  bank: { on:false, since:null|string, targets:{ [date]: kcal } },
  // calorie bank (deep-merged like profile/goal; backups carry it): since = first day counted (set to today when
  // switched on and by Reset); targets = per-day snapshots of the base calorie target (snapshotTarget), pruned
  // before since and after 400 days; a past day without a snapshot uses today's base target
  weights: [ { date:'YYYY-MM-DD', kg:number } ],   // sorted asc, one per date
  foods: { [foodId]: Food },                        // local library: custom foods + any food that was ever logged/favorited (cached copies of API foods)
  diary: { [date]: { entries: Entry[] } },
  recents: [foodId],                                // most recent first
  favorites: [foodId],
  meals: ['Breakfast','Lunch','Dinner','Snacks'],
  feed: { gistId:'', lastSync:null|string, lastCount:0, lastError:null|string, imported:{ [date]: kg } }
  // weight feed (deep-merged like profile/goal; backups carry it): gistId = secret gist id ('' = off);
  // lastSync = ISO datetime of the last successful fetch; lastCount = weigh-ins added/updated by it;
  // lastError = message of the last failed sync; imported = weigh-ins the feed wrote, so a later feed value may
  // update them but never a typed one; pruned to the last 400 days (see js/feed.js)
}
```

```js
// Food — nutrients are ALWAYS normalized to per 100 g.
Food = {
  id: string,              // 'off:<barcode>' | 'usda:<fdcId>' | 'custom:<uid>'
  source: 'off'|'usda'|'custom',
  barcode: string|null,
  name: string, brand: string,
  per100: { cal:number, p:number, c:number, f:number, fiber:number },
  servings: [ { label: string, grams: number } ],   // e.g. {label:'1 serving (30 g)', grams:30}, {label:'1 scoop', grams:31}
  defaultGrams: number     // amount preselected in the UI (serving grams if known, else 100)
}

// Entry — a logged food on a day. Stores a nutrient snapshot so later edits to the food don't rewrite history.
Entry = {
  id: string, foodId: string, name: string, brand: string,
  meal: string,            // one of state.meals
  qty: number,             // quantity of unit
  unit: { label: string, grams: number },  // 'g'→grams:1, 'oz'→28.3495, or a serving
  grams: number,           // qty * unit.grams
  cal:number, p:number, c:number, f:number, fiber:number
}
```

---

## js/calc.js (LOGIC)

```js
export const KCAL_PER_KG = 7700;

/** EWMA trend. weights sorted asc. Gap-aware: effective alpha = 1 - (1-alpha)^gapDays so weekly weigh-ins still move the trend.
 *  returns [{date, kg, trend}] */
export function trendSeries(weights, alpha = 0.1)
export function latestTrend(weights): {date,kg,trend}|null

export function bmr({ sex, kg, cm, age }): number          // Mifflin-St Jeor
export function initialExpenditure(profile, kg): number     // round(bmr * profile.activity); age from birthYear

export function dayTotals(day): { cal, p, c, f, fiber }     // sums entries; day may be undefined → zeros

/** Adaptive TDEE over the window ending at endDate (inclusive), default 21 days.
 *  intake: calories on days that have ≥1 entry (unlogged days are ignored, not treated as zero)
 *  weight: trend value at the last weigh-in in window minus trend at the first weigh-in in window, using the FULL trendSeries
 *  tdee = avgIntake - deltaKg * KCAL_PER_KG / spanDays
 *  Returns null unless loggedDays ≥ 7, ≥ 2 weigh-ins in window, spanDays ≥ 7.
 *  returns { kcal, avgIntake, deltaKg, spanDays, loggedDays } (kcal/avgIntake rounded) */
export function estimateExpenditure(state, endDate, windowDays = 21)

/** Called on every app start and by the "Recalculate" button.
 *  - If expenditure.kcal is null: initialize from initialExpenditure(profile, latest trend kg or 75), method 'formula'.
 *  - Else if force or ≥7 days since updatedAt: est = estimateExpenditure(state, yesterday);
 *      if est: kcal = clamp(round(0.5*old + 0.5*est.kcal), 1000, 6000), method 'adaptive', detail = est
 *      always set updatedAt = today, push {date,kcal,method} to history (cap 200)
 *  Returns true if a change was made. Caller saves. */
export function refreshExpenditure(state, { force = false } = {}): boolean

/** Signed weekly rate in kg from goal (negative for lose, 0 for maintain). */
export function signedRate(goal): number

/** Daily targets.
 *  manual mode → { ...goal.manual, source:'manual' }
 *  auto: cal = round10(expenditure + signedRate*KCAL_PER_KG/7), floored at 1200 (female) / 1500 (male) with floored:true
 *        p = round(proteinPerKg * trendKg)   (trendKg from latestTrend, else targetWeightKg, else 75)
 *        f = round(fatPct * cal / 9)
 *        c = round((cal - 4p - 9f) / 4); if c < 0 → c = 0 and f = max(0, round((cal - 4p)/9))
 *  returns { cal, p, c, f, floored, source } */
export function targets(state)

/** Projection to goal weight. returns null if maintain/no target/rate 0/already past target,
 *  else { weeks, date } (date = today + weeks*7 days, weeks rounded to 1 decimal) */
export function projection(state)

/** Weekly intake summary for charts: for the last `days` days ending today returns
 *  [{date, cal, logged:boolean}] */
export function intakeSeries(state, days = 14)

/** Record today's base calorie target: state.bank.targets[date] = targets(state).cal; drop keys older than
 *  bank.since or older than 400 days. Returns the value. Caller saves. Called at app start (after
 *  refreshExpenditure), after save-goal, after recalc, and when the bank is switched on or reset. */
export function snapshotTarget(state, date = todayStr()): number

/** Calorie bank as of `date`: tally of finished days from bank.since up to but excluding min(date, today).
 *  null when bank.on is false or since is null. Days oldest first: a day with no entries resets (balance = 0,
 *  resetDate = that day, the days list restarts after it); a day with entries adds
 *  diff = round(target − eaten), target = bank.targets[day] ?? targets(state).cal.
 *  returns { balance, since, from, resetDate, days:[{date, target, eaten, diff, balance}] }
 *  from = first counted day (day after the last reset, or since); days = counted days oldest first */
export function bankStatus(state, date = todayStr())
```

---

## js/foods.js (LOGIC)

Open Food Facts (OFF): base `https://world.openfoodfacts.org`.
- Product: `GET /api/v2/product/{barcode}.json?fields=code,product_name,product_name_en,brands,serving_size,serving_quantity,nutriments,quantity`
- Search: `GET /cgi/search.pl?search_terms={q}&search_simple=1&action=process&json=1&page_size=25&fields=<same>`
- OFF nutriment keys: `energy-kcal_100g` (kcal), `energy_100g` (kJ — divide by 4.184 if kcal missing), `proteins_100g`, `carbohydrates_100g`, `fat_100g`, `fiber_100g`; per-serving variants end in `_serving`. `serving_quantity` is grams (number or numeric string); `serving_size` is free text like "30 g", "1 cup (240 ml)", "2 oz".
- If per-100g values are all missing but `_serving` values exist and serving grams are known, derive per 100 g.

USDA FoodData Central (optional, only when `profile.usdaKey` is non-empty): `GET https://api.nal.usda.gov/fdc/v1/foods/search?api_key=KEY&query=q&pageSize=20&dataType=Foundation,SR Legacy,Branded`. Each `foods[i].foodNutrients[j]` has `nutrientNumber` ('208' energy kcal, '203' protein, '205' carbs, '204' fat, '291' fiber) and `value` per 100 g. Branded foods have `servingSize` + `servingSizeUnit` ('g'|'ml'|'GRM'|'MLT') and `householdServingFullText`. Name = `description`, brand = `brandOwner || brandName || ''`.

```js
export const UNIT_G  = { label: 'g',  grams: 1 };
export const UNIT_OZ = { label: 'oz', grams: 28.3495 };

export function parseServingGrams(servingSize: string|null, servingQuantity: any): number|null
export function foodFromOFF(product): Food|null      // null if no usable nutrients
export function foodFromUSDA(item): Food|null
/** Looks up barcode: tries code as-is, then (13 digits starting with '0' → drop it), (12 digits → prefix '0'). */
export async function lookupBarcode(code: string): Promise<Food|null>
/** OFF search, plus USDA search when usdaKey given; USDA failures are swallowed. Dedup by id. Each fetch has an 12 s AbortController timeout. */
export async function searchFoods(query: string, { usdaKey = '' } = {}): Promise<Food[]>
/** Scale per-100g nutrients to grams. returns {cal,p,c,f,fiber} (unrounded) */
export function nutrientsFor(food: Food, grams: number)
/** All unit options for a food: [...food.servings, UNIT_G, UNIT_OZ] */
export function unitOptions(food: Food): {label, grams}[]
/** Build an Entry (without id/meal) from food + qty + unit */
export function buildEntry(food: Food, qty: number, unit: {label,grams}): Omit<Entry,'id'|'meal'>
/** Make a custom Food. per === 'serving' means the nutrient numbers given are for `servingGrams` grams; per === '100g' means per 100 g. */
export function makeCustomFood({ id = null, name, brand = '', barcode = null, per: 'serving'|'100g', servingGrams, servingLabel = '1 serving', cal, p, c, f, fiber = 0 }): Food
```

Errors from `fetch` should surface as thrown `Error` with a friendly message ("No internet connection?" on TypeError).

---

## js/scanner.js (LOGIC)

```js
/** Starts camera + decoding on the given <video>. Prefers native BarcodeDetector when getSupportedFormats() includes 'ean_13';
 *  otherwise lazily loads ZXing UMD from https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js (global `ZXing`)
 *  and uses new ZXing.BrowserMultiFormatReader(hints, 300).decodeFromStream(stream, video, cb).
 *  Formats: EAN-13, EAN-8, UPC-A, UPC-E, Code-128.
 *  getUserMedia constraints: { video: { facingMode: { ideal: 'environment' }, width:{ideal:1280}, height:{ideal:720} }, audio:false }.
 *  video must have playsinline + muted set. Native path polls detector.detect(video) every 200 ms.
 *  onCode(code) is called at most once, after the scanner has stopped itself. onStatus(text) gets progress messages.
 *  Rejects with a friendly Error if the camera is unavailable/denied or not in a secure context.
 *  Resolves to a stop() function that is idempotent and releases the camera. */
export async function startScanner(video: HTMLVideoElement, onCode: (code:string)=>void, onStatus: (s:string)=>void): Promise<() => void>
export function scannerSupported(): boolean   // isSecureContext && navigator.mediaDevices?.getUserMedia
```

---

## js/charts.js (LOGIC)

Return SVG **strings** (inline in templates). Responsive via `viewBox` + `width="100%"`, class `chart`. Use CSS classes `grid` (gridlines) and `tick` (axis labels) so CSS can theme them; series colors are passed as CSS color strings like `var(--p)`.

```js
/** series: [{ points:[{x:number,y:number}], color, width=2, dots=false, dash=false }]
 *  xLabels: [{x, label}] drawn along the bottom. yFmt formats tick labels. 4 "nice" y ticks.
 *  Returns '<div class="chart-empty">No data yet</div>' when there are no points. */
export function lineChart({ series, width = 360, height = 200, yFmt = v => String(Math.round(v)), xLabels = [] }): string
/** bars: [{ label, value, color, muted=false }], optional horizontal reference line `line: {value, color, label}` */
export function barChart({ bars, line = null, width = 360, height = 160, yFmt }): string
export function niceTicks(min, max, count = 4): number[]
```

---

## js/feed.js (LOGIC)

Weigh-ins from a smart scale without typing. Web apps cannot read HealthKit, so an iPhone Shortcut automation
writes the last 30 days of Health weight samples into a secret GitHub gist once a day (one `yyyy-MM-dd HH:mm
180.4 lb` line per sample; recipe in README) and the app pulls the gist when it opens. Reads are unauthenticated
(api.github.com allows browser requests, 60/hour per IP).

```js
export function parseWeightLines(text, defaultUnit): { date, time: 'HH:MM'|null, kg }[]
  // one sample per line: date YYYY-MM-DD | YYYY/MM/DD | M/D/YYYY, optional time (07:12, 7:12 AM, T07:12:00[±hh:mm]),
  // a number with optional unit lb/lbs/pound(s)/kg/kilogram(s) (no unit → defaultUnit); separators space , tab ;
  // lines without a valid date and a plausible weight (20–400 kg) are skipped; sorted by date then time (untimed last)
export function dailyWeights(samples): { date, kg }[]   // earliest sample per day
export function mergeFeedWeights(state, daily): { added, updated }
  // mutates, does not save; dates ≤ today only. No weigh-in → add (unless the feed wrote that day and the user
  // deleted it). Weigh-in the feed wrote and still unchanged → update when the new value differs by ≥ 0.05 kg.
  // Any other weigh-in (typed, or retyped over a feed day) is left alone. Records feed.imported[date] = kg for
  // every added/updated day; prunes imported to the last 400 days.
export function gistText(json): string     // content of the first gist file, preferring *.txt/*.csv/*.json
export function parseGistId(input): string // last /[0-9a-f]{20,40}/i run of an id or pasted gist URL, lowercased
export async function syncWeightFeed({ force = false } = {}): Promise<{added, updated}|null>
  // no-op when gistId blank or offline; unless force at most once per 30 min (lastSync and last attempt);
  // never concurrent (a second call shares the running one); never rejects. GET api.github.com/gists/<id>
  // (Accept application/vnd.github+json, cache 'no-store', 15 s timeout). Non-2xx → lastError "Gist not found
  // (404)" / "GitHub rate limit, try later (403)" / "GitHub error (HTTP n)", network → "Could not reach GitHub",
  // resolves null. Success → parse (profile units), dailyWeights, merge, lastSync/lastCount/lastError=null, save;
  // when added+updated > 0 toast "N weigh-ins from the scale" + requestRender(). Does not call refreshExpenditure.
```

## js/ui.js (UI)

```js
export const esc = (s) => string           // HTML-escape; null/undefined → ''
export function fmt(n, digits = 0): string // number formatting, '–' for null/NaN
export function dateLabel(date): string    // 'Today', 'Yesterday', 'Tomorrow', else 'Tue, Oct 28'
export const actions = {}                  // name → handler(el, event)
export function on(name, handler): void
export function bindGlobalEvents(): void   // delegated listeners on document:
   // click  → closest [data-action]  → actions[name](el, e)   (preventDefault)
   // submit → form[data-submit]      → actions[name](form, e) (preventDefault)
   // input  → [data-input]           → actions[name](el, e)
   // change → [data-change]          → actions[name](el, e)
export function openModal(html, { cls = '', sticky = false, onClose = null } = {}): HTMLElement   // appends a .modal-backdrop > .modal.sheet to #modal-root; stacked modals allowed; backdrop click closes unless sticky; returns the backdrop element
export function closeModal(backdrop = topmost): void   // runs onClose
export function closeAllModals(): void
export function toast(message, { ms = 2200, kind = 'info'|'error' } = {}): void
export function requestRender(): void      // dispatches 'render' on document; app.js listens
export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}): Promise<boolean>   // modal-based, not window.confirm
```
`ui.js` registers `on('close-modal', el => closeModal(el.closest('.modal-backdrop')))`.

---

## js/app.js (UI)

- Imports store/calc/ui and all views/modals (importing a view module registers its actions).
- `const current = { tab: 'diary', date: todayStr() }` exported as `nav`.
- On start: `refreshExpenditure(state)` then `save()`; if `!state.onboarded` open the setup wizard (sticky); `bindGlobalEvents()`; register service worker `./sw.js` (ignore failures); listen for `beforeinstallprompt` and stash it on `window.__installPrompt`; render; then `syncWeightFeed()` fire-and-forget (also on every `visibilitychange` → visible; its 30-minute rule keeps that cheap).
- `render()`: `#app` innerHTML = views[current.tab](); update `#tabbar` active state. Listen to `document` 'render' event → render(). Also re-render on `visibilitychange` → visible if date changed (new day).
- Tab bar: 4 tabs Diary / Weight / Plan / Settings with inline SVG icons, `data-action="tab" data-tab="diary"`.
- Hash routing optional; not required.

## Views (UI)

**Diary** (`views/diary.js`, export `diaryView()`):
- Top bar: ‹ / date label (+ "Today" link when not today) / ›.
- Summary card: big calories eaten, "of N kcal" (when the calorie bank is on, one line below from `bankStatus(state, date)`: "Bank +340 kcal" green / "Bank −200 kcal" red / "Bank 0 kcal" muted; targets unchanged), remaining (red "over" when negative), progress bar, three macro bars (Protein/Carbs/Fat) with `eaten / target g`. Fiber shown small below.
- If no weigh-in today: small "Log today's weight" inline form (number input in user units + Save).
- One section per meal: entry rows (name, brand small, "qty unit · g", cal, tiny p/c/f), tap row → food detail modal in edit mode; "+ Add food" button per meal → add-food modal.
- Tiny footer note on first use: "Log everything you eat; unlogged days are ignored by the expenditure estimate, partial days drag it down."

**Weight** (`views/weight.js`, export `weightView()`):
- Header stats: trend weight (big), latest scale weight, change over last 7 and 30 days (trend-based), progress toward target.
- Range chips 30 / 90 / 180 / All → `lineChart` with raw weights as dots (muted) and trend as line (accent). xLabels: ~4 evenly spaced dates.
- Log weight form (date defaults to today, number in user units).
- List of last 30 entries with delete.

**Plan** (`views/plan.js`, export `planView()`):
- Expenditure card: current kcal/day, method badge (Initial estimate / Adaptive), last updated, detail line ("Avg intake 2,140 · trend −0.9 lb over 14 d · 12 logged days"), "Recalculate now" button (calls refreshExpenditure force → toast result or reason it couldn't: "Needs ≥7 logged days and 2 weigh-ins ≥7 days apart in the last 3 weeks"). Small line chart of expenditure history if ≥2 points.
- Targets card: calories, protein, carbs, fat (from `targets`), floored warning, projection ("≈ 14 weeks · Feb 3").
- Calorie bank card (right after Targets): checkbox row "Keep a calorie bank" (data-change="bank-toggle"; on → since = today if null, snapshotTarget, toast "Calorie bank on"; off keeps since/targets, toast "Calorie bank off"). When on: "Bank +340 kcal · since Mon 27 Oct" (from `bankStatus(state)`), muted "Reset on Wed 29 Oct (no food logged)" when resetDate is set, ledger of counted days newest first (max 60): "Tue 28 · 1,820 / 2,000 · +180", or "Nothing counted yet. Finished days are added the next day."; "Reset bank" ghost button (data-action="bank-reset", hidden when nothing counted) → confirmDialog "Start the bank again from today?" → since = today, snapshot, toast "Bank reset". Hint explains the rules. Targets card and intake chart are unchanged.
- Goal form (data-submit="save-goal"): mode select; target weight; rate per week (user units, magnitude) with hint of % of bodyweight/week and preset buttons 0.25% / 0.5% / 0.75% / 1% that fill the rate; protein (g per lb when imperial, g per kg when metric — convert on save); fat %; macro mode auto/manual; manual cal/p/c/f fields (shown when manual). Save → store, toast, rerender.
- Intake bar chart: last 14 days (`intakeSeries`) with target line; unlogged days muted.

**Settings** (`views/settings.js`, export `settingsView()`):
- Profile form: name (optional), sex, birth year, height (cm, or ft+in when imperial), units, activity select. Save.
- Food sources: USDA API key input + link to https://fdc.nal.usda.gov/api-key-signup (free), note that Open Food Facts is always on.
- Meals: editable comma list (optional, keep simple).
- Install: if `window.__installPrompt` show "Install app" button; else show iOS/Android add-to-home-screen instructions.
- Weight feed (after Google Drive backup): form `data-submit="save-feed"` with a "Gist id" input (accepts a pasted gist URL, keeps the id via `parseGistId`; an unrecognisable value → error toast; blank switches the feed off and keeps `imported`; a changed id clears lastSync/lastCount/lastError). Save → toast "Weight feed saved" and `syncWeightFeed({ force: true })`. When an id is set: status line `Last sync 5 min ago · N weigh-ins`, `Sync failed: <lastError>` (class `warn`) or `Not synced yet`, and a ghost "Sync now" button (`data-action="feed-sync"`, forced sync, toast "No new weigh-ins" when nothing changed). Hint points to the README Shortcut recipe.
- Backup: "Export backup" (Blob download `macrotally-backup-YYYY-MM-DD.json`), "Import backup" (file input, `data-change="import-file"`, confirm before replace), "Erase all data" (confirmDialog danger).
- About: short text, privacy note (no server, data on this device only), version.

## Modals (UI)

`modals/food.js` exports `openAddFood(meal, date)`, `openFoodDetail(food, { meal, date, entry = null })`, `openCustomFood({ barcode = null, food = null, meal, date })`, `openScanner({ meal, date })`.

- **Add food** sheet: search input (autofocus, debounced 350 ms, min 2 chars, shows spinner + "Searching Open Food Facts…"), big "Scan barcode" button (disabled with hint if `!scannerSupported()`), segmented tabs Recent / Favorites / My foods (custom), results list rows (name, brand, kcal per 100 g, serving hint), "+ Create custom food". Tapping a row → `openFoodDetail`. Search errors → inline message. Check the local library first for matches by name (instant), then API.
- **Food detail** sheet: name/brand, qty input + unit select (`unitOptions`), live-updating macro summary (cal big; p/c/f/fiber), favorite toggle (★), per-100g line. Buttons: "Add to {meal}" (or "Save changes" + "Delete" in edit mode). On add: `saveFood(food)` (cache in library), `addEntry`, close ALL modals, toast "Added", `requestRender`. For custom foods add an "Edit food" link → `openCustomFood({food})`.
- **Custom food** sheet: name, brand, barcode (prefilled from scan), serving label + serving grams, "Nutrition is per: [serving] [100 g]" toggle, cal/p/c/f/fiber inputs (numeric, inputmode decimal). Save → `makeCustomFood` → `saveFood` → `openFoodDetail`. Editing an existing custom food keeps its id.
- **Scanner** sheet: `<video playsinline muted>` full-width with a framed viewfinder overlay, status text, manual barcode form (`inputmode="numeric"`) + "Look up", Cancel. `onClose` must call stop(). On code: status "Looking up…"; check `state.foods` for a food with that barcode (custom or cached) first; else `lookupBarcode`; found → close scanner, `openFoodDetail`; not found → confirmDialog "Not in Open Food Facts. Create it?" → `openCustomFood({barcode})`.

`modals/setup.js` exports `openSetup()`: sticky wizard, single form: units, sex, birth year, height, current weight, activity, goal mode, target weight, rate per week (default 0.5%/wk of current weight, shown in user units). Submit → profile, `addWeight(today)`, goal, `refreshExpenditure(state, {force:true})` (initializes), `onboarded = true`, save, close, requestRender, toast "You're set. Log your first meal!".

## CSS (css/app.css, UI)

Tokens on `:root`: `--bg --card --text --muted --line --accent --accent-ink --p --c --f --danger --radius --tabbar-h`, redefined under `@media (prefers-color-scheme: dark)`. Suggested light: bg #f4f5f7, card #fff, text #16181d, muted #6b7280, line #e5e7eb, accent #2e7d5b, p #3b82f6, c #f59e0b, f #ef4444, danger #dc2626. Dark: bg #0e1013, card #181b20, text #e8eaed, muted #9aa0a6, line #2a2f37, accent #3ea57a.
System font stack. Body padding-bottom for tab bar + `env(safe-area-inset-bottom)`. Cards `.card` with radius 14 px. Buttons `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.icon-btn`. Inputs full width, 16 px font (prevents iOS zoom). `.sheet` modals slide up from bottom, max-height 92vh, scrollable, rounded top corners; on screens ≥ 700 px wide, center them as dialogs (max-width 480 px). `.bar` progress bars, `.macro` blocks, `.row` list rows with chevron, `.segmented` tabs, `.chip`. `.chart` svg: `.grid` stroke var(--line); `.tick` fill var(--muted) font-size 11px. `.scanner video { width:100%; aspect-ratio: 4/3; object-fit: cover; background:#000 }` + `.scan-frame` overlay. Respect `prefers-reduced-motion`.

## PWA (LOGIC)

- `manifest.webmanifest`: name "MacroTally", short_name "MacroTally", start_url "./", scope "./", display "standalone", background_color/theme_color matching dark bg, icons 192 & 512 PNG (purpose any) + icon.svg.
- `index.html` (UI): meta viewport with `viewport-fit=cover`, theme-color, apple-mobile-web-app-capable, apple-mobile-web-app-status-bar-style black-translucent, apple-touch-icon → `./icons/icon-192.png`, link manifest, `<div id="app"></div><nav id="tabbar"></nav><div id="modal-root"></div><div id="toast-root"></div>`, `<script type="module" src="./js/app.js">`.
- `sw.js`: `const VERSION = 'v1'`; precache the app shell (index.html, css, all js, manifest, icons) on install; on activate delete old caches + `clients.claim()`; fetch: same-origin GET → network-first falling back to cache (so updates arrive but offline still works); cross-origin → network only (do not cache API calls, including the weight feed's api.github.com gist reads). Navigation requests fall back to cached `./index.html`. The SHELL list includes every module, `./js/feed.js` among them.
- `tools/make_icons.py`: stdlib-only PNG writer producing 192 and 512 px icons: dark-green (#2e7d5b) rounded square with a white ring (like a macro ring) and a filled accent arc; also write `icons/icon.svg` equivalent. Run it once and commit the PNGs.

## Testing checklist (reviewer runs)
- Fresh load → setup wizard → diary shows targets.
- Search "oats" → add 80 g → totals update; edit to 1 serving; delete.
- Scanner modal opens (camera may be unavailable on desktop → friendly message), manual barcode `737628064502` (Thai Kitchen rice noodles) looks up on OFF.
- Custom food with per-serving entry → per100 computed correctly (e.g. 30 g serving with 120 kcal → 400 kcal/100 g).
- Weight: log several days → trend line; 7/30-day deltas.
- Plan: presets fill rate; targets update; manual mode; Recalculate shows reason when insufficient data; with seeded data computes adaptive TDEE.
- Export then Import round-trips; Erase resets.
- Settings → Weight feed: a public gist id syncs ("Last sync just now · 0 weigh-ins"); a wrong id shows "Sync failed: Gist not found (404)"; `node tools/test_feed.mjs` passes.
- Served from a sub-path with no absolute URLs; `sw.js` registers; no console errors.
