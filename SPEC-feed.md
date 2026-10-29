# Weight feed from a smart scale (Apple Health → GitHub gist) — spec (v1.5.0)

Goal: weigh-ins that a scale app pushes into Apple Health reach MacroTally with no typing. Web apps cannot
read HealthKit, so an iPhone Shortcut automation copies recent weight samples into a secret GitHub gist
once a day, and the app pulls the gist when it opens. Nothing but the user's own GitHub account holds the
data. The app only needs the gist id (reads are unauthenticated: api.github.com allows browser requests,
60/hour per IP).

## 1. State (`js/store.js`)

Top-level `feed`, deep-merged like profile/goal/bank; carried in backups:

```js
feed: { gistId: '', lastSync: null, lastCount: 0, lastError: null, imported: {} }
```

- `gistId` string (32 hex chars, or blank = off). `lastSync` ISO datetime of the last successful fetch.
  `lastCount` weigh-ins added by the last sync. `lastError` message of the last failed sync or null.
- `imported`: `{ 'YYYY-MM-DD': kg }` of the weigh-ins the feed wrote, so a later feed value for the
  same day may update a feed-written weigh-in but never one the user typed. Pruned to the last 400 days.

## 2. Module `js/feed.js` (new; precached in sw.js SHELL)

```js
/**
 * Parse weigh-in lines. One sample per line; a line holds a date (YYYY-MM-DD, YYYY/MM/DD or M/D/YYYY,
 * optionally followed by a time like 07:12, 7:12 AM or T07:12:00) and a number with an optional unit
 * (lb, lbs, pound(s), kg, kilogram(s); case-insensitive). Separators: spaces, commas, tabs, semicolons.
 * Lines without both a date and a number are skipped (headers, blanks). A number without a unit uses
 * defaultUnit ('imperial' → lb, 'metric' → kg). Returns samples sorted by date then time.
 * @returns {{date:string, time:string|null, kg:number}[]}
 */
export function parseWeightLines(text, defaultUnit)

/**
 * Pick one sample per day: the earliest time of that day (morning weigh-ins are the standard; a sample
 * without a time sorts after timed ones). @returns {{date:string, kg:number}[]}
 */
export function dailyWeights(samples)

/**
 * Merge feed weigh-ins into state.weights (pure logic, exported for tests; mutates state, does not save):
 * for each {date, kg}: skip if the date has a weigh-in that the feed did not write (not in
 * feed.imported); add when the date has none; update when feed.imported[date] exists and differs by
 * ≥ 0.05 kg. Records feed.imported[date] = kg for every added/updated day. Only dates ≤ today.
 * @returns {{added:number, updated:number}}
 */
export function mergeFeedWeights(state, daily)

/** Extract the text of the first file of a gist API response (prefer names ending .txt/.csv/.json). */
export function gistText(json): string

/**
 * Fetch the gist and merge. Skips silently when feed.gistId is blank or offline. Unless force, runs at
 * most once per 30 minutes (lastSync) and never concurrently. Fetch
 * https://api.github.com/gists/<id> with Accept application/vnd.github+json and cache 'no-store'; a
 * non-2xx sets feed.lastError ("Gist not found (404)"; "GitHub rate limit, try later (403)") and
 * resolves. On success: parse, dailyWeights, mergeFeedWeights, set lastSync/lastCount/lastError=null,
 * save, and when added+updated > 0: toast "N weigh-ins from the scale" and requestRender().
 * @returns {Promise<{added:number, updated:number}|null>}
 */
export async function syncWeightFeed({ force = false } = {})
```

After a merge that changed weights, call `refreshExpenditure(state)` is NOT needed (it runs on its own
schedule); do not call it.

## 3. App hooks (`js/app.js`)

`syncWeightFeed()` fire-and-forget at start (after the first render) and in `onVisible` when the day
changed or the app became visible (the 30-minute rule keeps it cheap).

## 4. Settings card "Weight feed" (settings.js, after "Google Drive backup" or after "Food packs"; pick
the spot that reads naturally, next to the other sync features)

- Form `data-submit="save-feed"`: input "Gist id" (placeholder "32 characters from the gist's address",
  `autocomplete=off`, `spellcheck=false`), accepts a pasted full gist URL and keeps the id
  (`/([0-9a-f]{20,40})/i` last match); blank clears the feed (and `imported` stays so nothing is lost).
  Save → toast "Weight feed saved" and `syncWeightFeed({ force: true })`.
- Status line when gistId set: `Last sync <relative/short datetime> · N weigh-ins` or
  `Sync failed: <lastError>` (class `warn`) or `Not synced yet`. Button "Sync now" (ghost,
  `data-action="feed-sync"`) → `syncWeightFeed({ force: true })` then toast with the result
  (`No new weigh-ins` when 0).
- Hint with a short description and "See the README for the Shortcut that fills the gist from Apple
  Health." (plain text; the README is on GitHub).

## 5. README section "Weight feed from a smart scale (Apple Health)" — after "Google Drive backup"

Write it for the phone owner, in the README's existing style. Content:
1. What it does and the data path (scale → Apple Health → Shortcut → secret gist → app). Privacy: the gist
   is unlisted; anyone with its id could read dates and weights; nothing else is stored.
2. One-time setup:
   - GitHub: create a **secret** gist at gist.github.com with a file named `weights.txt` containing one
     line of anything; note the id in its address. Create a **classic** personal access token
     (Settings → Developer settings → Personal access tokens → Tokens (classic)) with only the `gist`
     scope; fine-grained tokens cannot edit gists. Copy it once.
   - MacroTally: Settings → Weight feed → paste the gist id → Save.
   - Shortcuts app, new shortcut "Scale to MacroTally" with these actions, in order:
     1. **Find Health Samples** — Type: Weight; add filter Start Date "is in the last" 30 days; Sort by
        Start Date; Limit off.
     2. **Repeat with Each** (Health Samples):
        a. **Format Date** — Date: Repeat Item's Start Date; Format: Custom; Format String `yyyy-MM-dd HH:mm`.
        b. **Text** — `[Formatted Date] [Repeat Item]` (the sample renders as e.g. "180.4 lb").
     3. **Combine Text** — Repeat Results, with New Lines.
     4. **Get Contents of URL** — `https://api.github.com/gists/<gist id>`; Method PATCH; Headers:
        `Authorization` = `Bearer <token>`, `Accept` = `application/vnd.github+json`; Request Body JSON:
        key `files` → Dictionary → key `weights.txt` → Dictionary → key `content` → Combined Text.
   - Run it once by hand (allow Health access to Weight when asked), then tap Sync now in the app.
   - Automation: Shortcuts → Automation → New → Time of Day, e.g. 09:00, Daily → Run Immediately (no
     confirmation) → pick the shortcut.
3. Notes: one weigh-in per day is kept (the earliest); a weigh-in typed in the app is never overwritten;
   today's weigh-in appears after the next run; "Sync now" fetches at once; the shortcut sends 30 days each
   time so missed days backfill.

## 6. SPEC.md, tests, caching, versions

- SPEC.md: `feed` in the state shape, a short js/feed.js section, the Settings card in Views, PWA list.
- `tools/test_feed.mjs` (new, same style as test_calc.mjs, which shows how to stub localStorage/toast):
  parseWeightLines with mixed formats ("2026-10-29 07:12 180.4 lb", "2026-10-28T06:58:00 181.0 lb",
  "10/27/2026, 182.2", "2026-10-26 82.1 kg", header line, blank line, "Oct 25" junk skipped); default unit
  by profile; dailyWeights earliest-per-day with an untimed sample; mergeFeedWeights add/skip-manual/update
  feed-written/ignore future dates/imported recorded and pruned; gistText file preference.
- sw.js SHELL adds `./js/feed.js`. Versions (architect): sw VERSION v10, APP_VERSION 1.5.0.
