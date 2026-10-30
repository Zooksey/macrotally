# AI add: a Claude helper on your own server (v1.6.0)

Status: final. Implements the "AI add" button (in the add-food sheet since v1.6.2, section 9). Written 2026-10-29.

## 1. What it does

A button in the add-food sheet opens a sheet where the user types a description, attaches a photo, or both
("71g of these" + a photo of a Dot's pretzels bag). The app sends it to a small HTTP service the user runs
on their Unraid box behind an existing Cloudflare Tunnel. That service runs the Claude Code CLI headless
(`claude -p`) on the user's Max subscription. Claude identifies the food(s), reads the label from the photo
or looks it up on the web, and returns a schema-validated list of items.

The app then matches each item against the foods it already has (custom library, built-in list, restaurant
packs). A match is offered as "use the existing food" so no duplicate is created; when Claude's numbers
disagree with the stored ones the card says so and offers to correct a custom food. The user adjusts the
amount if needed and taps Add. A new item becomes a custom food in the library (so plain search finds it next
time) plus a diary entry.

Nothing about this runs unless the user has saved a helper URL and secret in Settings. The app works exactly
as before without it.

## 2. Verified facts the design relies on (tested 2026-10-29 on CLI 2.1.270)

- `claude -p "<prompt>" --output-format json --json-schema '<schema>'` returns the answer as
  `structured_output` (an object matching the schema) in the JSON printed to stdout. Other useful fields:
  `subtype` ("success" or an error subtype), `num_turns`, `duration_ms`, `total_cost_usd` (an estimate; a
  subscription is not billed).
- A photo is given by file path; Claude views it with its Read tool. Files inside the cwd need no extra grant.
- Flags that worked: `--model sonnet --max-turns 10 --tools "Read,WebSearch,WebFetch" --allowedTools
  "Read,WebSearch,WebFetch" --permission-mode dontAsk --no-session-persistence --append-system-prompt-file
  system.txt`. Add `--safe-mode` (keeps auth, drops CLAUDE.md, hooks, MCP, plugins, memory).
- The subscription login is used only when `ANTHROPIC_API_KEY` is NOT set. Never pass `--bare`: it skips
  OAuth and breaks subscription auth.
- Headless box without a browser: run `claude setup-token` once on a machine with a browser; it prints a
  one-year OAuth token. Put it in `CLAUDE_CODE_OAUTH_TOKEN` on the server.
- Two test runs (text only; text + image) each took about 20 s wall clock and 3 to 4 turns with Sonnet.

## 3. Server (`server/`)

Plain Node 22, no dependencies. Files:

- `server/ai-server.mjs`: the HTTP service (`node ai-server.mjs`). Exports its pure helpers so they can be
  unit-tested without starting a server: `corsHeaders(origin, allowed)`, `validateBody(body)` returning
  `{text, image, mime}` or throwing `{status, message}`, `buildArgs({schemaJson, systemPath, model, maxTurns})`,
  `parseClaudeOutput(stdout)` returning `{items}` or throwing. Only start listening when run as main.
- `server/system.txt`: the system prompt (section 5).
- `server/schema.json`: the JSON Schema (section 4).
- `server/Dockerfile`, `server/docker-compose.yml`, `server/.env.example`, `server/README.md`.
- `server/.gitignore` containing `.env`.

### 3.1 Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | required | From `claude setup-token`. Never logged. |
| `AI_SECRET` | required | Shared secret the app sends as `Authorization: Bearer …`. Refuse to start under 16 chars. |
| `AI_MODEL` | `sonnet` | Passed to `--model`. |
| `ALLOWED_ORIGINS` | `https://zooksey.github.io,http://localhost:8766,http://127.0.0.1:8766` | Comma list for CORS. |
| `PORT` | `8787` | Listen port (bind 0.0.0.0). |
| `AI_TIMEOUT_MS` | `85000` | Kill the CLI after this. Cloudflare's proxy gives up at 100 s. |
| `AI_MAX_TURNS` | `10` | `--max-turns`. |

The server deletes `ANTHROPIC_API_KEY` from the child's environment so the subscription is used.

### 3.2 Endpoints

All responses are JSON. CORS: if the request `Origin` is in `ALLOWED_ORIGINS`, answer with
`Access-Control-Allow-Origin: <that origin>`, `Vary: Origin`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
`Access-Control-Allow-Headers: Authorization, Content-Type`, `Access-Control-Max-Age: 86400`. `OPTIONS` gets 204.
Any other path gets 404.

Every non-OPTIONS request must carry `Authorization: Bearer <AI_SECRET>` (constant-time compare), else 401
`{"error":"bad secret"}`.

- `GET /v1/health` returns `{"ok":true,"version":"1.6.0","model":"sonnet"}`.
- `POST /v1/food` with body `{ "text": string, "image"?: string (base64, no data: prefix), "mime"?: "image/jpeg"|"image/png" }`.
  Limits: body at most 6 MB (413), text at most 2000 chars, at least one of text or image (400).
  Response 200: `{ "items": [Item…], "model": "sonnet", "seconds": 19.4 }`.
  Errors: 400 bad input; 401; 413; 429 `{"error":"busy"}` when a job is already running (one at a time, no
  queue); 502 `{"error":"no result","detail":"<subtype or first 300 chars of stderr>"}` when the CLI exits
  without `structured_output.items`; 504 `{"error":"timeout"}`.

### 3.3 Job

1. Make `os.tmpdir()/mt-ai-<random>/`. If an image was sent, decode it to `photo.jpg` (or `photo.png`) there.
2. Prompt (the user message), lines omitted when not applicable:
   ```
   Photo: ./photo.jpg (use Read to look at it).
   User says: "<text>"
   ```
3. `execFile('claude', args, { cwd: tmpDir, timeout: AI_TIMEOUT_MS, maxBuffer: 8 MB, env })` where args are
   the section 2 flags plus `--output-format json --json-schema <schema file contents>
   --append-system-prompt-file <abs path>/system.txt --safe-mode`. On Windows `claude` is a `.cmd` shim, so
   resolve `claude.cmd` there; Linux (Docker) is the primary target.
4. Parse stdout as JSON; take `structured_output.items`; sanity-filter each item (numbers finite and at least
   0, `per` in {serving, 100g}, strings trimmed, at most 8 items). Empty after filtering means 502.
5. Always remove the temp dir. Log one line per request: time, status, seconds, item count, text length,
   whether an image was sent. Never log the text, the image, or the token.

### 3.4 Docker / Unraid / Cloudflare

- `Dockerfile`: `FROM node:22-bookworm-slim`; `apt-get install -y --no-install-recommends ca-certificates curl`;
  `npm install -g @anthropic-ai/claude-code`; non-root user `app` with `HOME=/home/app`; `WORKDIR /app`; copy
  the server files; `ENV DISABLE_AUTOUPDATER=1 PORT=8787`; `EXPOSE 8787`; `CMD ["node","ai-server.mjs"]`.
- `docker-compose.yml`: service `macrotally-ai`, `build: .`, `env_file: .env`, `ports: ["8787:8787"]`,
  `restart: unless-stopped`, `tmpfs: [/tmp]`.
- `server/README.md`: get the token (`claude setup-token` on the PC), make `.env` from `.env.example`, build and
  run on Unraid (Compose Manager plugin, or `docker compose up -d --build` over SSH), add the Cloudflare
  Tunnel public hostname (Zero Trust, Networks, Tunnels, the tunnel, Public Hostname: `ai.<domain>` to
  `http://<unraid-ip>:8787`), then test with
  `curl -H "Authorization: Bearer $AI_SECRET" https://ai.<domain>/v1/health`. Mention the 100 s Cloudflare
  limit and that the free plan is enough. Say that the token is a login to the user's Claude account: keep
  `.env` private, rotate by re-running `setup-token`.

## 4. Result schema (`server/schema.json`)

```json
{ "type": "object", "required": ["items"],
  "properties": { "items": { "type": "array", "minItems": 1, "maxItems": 8, "items": {
    "type": "object",
    "required": ["name","brand","per","servingGrams","servingLabel","cal","p","c","f","fiber","grams","servings","confidence","source","notes"],
    "properties": {
      "name": {"type":"string"}, "brand": {"type":"string"},
      "per": {"type":"string","enum":["serving","100g"]},
      "servingGrams": {"type":["number","null"]}, "servingLabel": {"type":"string"},
      "cal": {"type":"number"}, "p": {"type":"number"}, "c": {"type":"number"}, "f": {"type":"number"}, "fiber": {"type":"number"},
      "grams": {"type":["number","null"]}, "servings": {"type":["number","null"]},
      "confidence": {"type":"string","enum":["label","web","estimate"]},
      "source": {"type":"string"}, "notes": {"type":"string"} } } } } }
```

Meaning, which matches `makeCustomFood` in js/foods.js exactly:
- `per: "serving"` with `servingGrams: 28`: nutrients are for one 28 g serving labelled `servingLabel`.
- `per: "serving"` with `servingGrams: null`: a servingOnly food (restaurant dish, unknown weight); nutrients
  are for one `servingLabel`.
- `per: "100g"`: nutrients per 100 g; `servingGrams` and `servingLabel` describe a typical serving if known.
- Amount eaten: `grams` when known or derivable (71 g); otherwise `servings` (1.5); if both are null the app
  defaults to 1 serving (or 100 g for a per-100g food with no serving).
- `confidence`: `label` means read from the manufacturer's label (photo or official site), `web` a third-party
  database, `estimate` Claude's estimate.

## 5. System prompt (`server/system.txt`)

```
You are a nutrition lookup helper for a calorie-tracking app. The user describes and/or photographs what
they ate and how much. Return one item per distinct food. Identify the exact product when there is one
(brand, flavour, variety); for generic foods (banana, rice) leave brand empty. Never invent a brand.
Prefer the manufacturer's nutrition label: read it from the photo if shown, otherwise use WebSearch and
WebFetch to find the official label or a reliable database. If nothing is findable, estimate from similar
foods and set confidence "estimate".
Report nutrients per labelled serving (per "serving" with servingGrams and a label like "1 oz (28 g)"),
per 100 g, or per serving of unknown weight (servingGrams null) for dishes and restaurant items.
Units: cal in kcal; p, c, f, fiber in grams. Round sensibly.
Amount: set grams to what the user ate in grams when stated or derivable (e.g. "71g of these"); otherwise
set servings (e.g. "two slices" means 2 with a per-slice serving). For a plate photo with no quantities,
estimate portions and use confidence "estimate".
Keep notes to one short sentence (what you assumed). Put the label or page you used in source.
```

## 6. App changes

### 6.1 State (js/store.js)

`state.ai = { url: '', secret: '', lastOk: null, lastError: null }` in defaults; deep-merge and repair it like
`feed` (strings stay strings, the two timestamps may be null).

### 6.2 `js/ai.js`

- `aiConfigured(state)`: url and secret both non-empty.
- `normalizeUrl(url)`: trims, strips trailing `/`, requires `https://` (or `http://localhost` /
  `http://127.0.0.1` for dev). Throws a readable error otherwise.
- `downscaleImage(file, { max = 1280, quality = 0.85 })`: Promise of `{ base64, mime: 'image/jpeg' }` via
  `createImageBitmap(file, { imageOrientation: 'from-image' })` plus canvas, falling back to `Image`.
- `askAi({ text, image, signal })`: POST `/v1/food`, 95 s client timeout combined with the caller's
  AbortSignal, maps HTTP errors to messages: 401 "The helper rejected the secret", 429 "The helper is busy,
  try again in a minute", 504 "The helper took too long", 502 "Claude didn't return a food", network or
  timeout "Can't reach the helper". Records `state.ai.lastOk` or `lastError` and saves.
- `testAi()`: GET `/v1/health`, same error mapping, returns `{version, model}`.
- `foodFromAiItem(item)`: `makeCustomFood({ name, brand, per, servingGrams, servingLabel, cal, p, c, f, fiber })`.
- `amountFromAiItem(item, food)`: `{ qty, unit }` using `unitOptions(food)`: grams known and food not
  servingOnly gives `{qty: grams, unit: g}`; else servings known with Claude's `servingGrams` known (and the
  food not servingOnly) gives a stored serving of that same weight if there is one, else `{qty: servings ×
  servingGrams, unit: g}` (the matched food's first serving may be a different size); else servings known gives
  the food's first serving unit with qty = servings; else `{qty: 1, unit: first serving}`, or `{qty: 100,
  unit: g}` when the food has no serving.
- `findExisting` also rejects a branded candidate for a brandless item ("banana" must not become a Five Guys
  "Banana" milkshake) unless that candidate is in the user's library.
- `confidenceLabel(c)`: "Label", "Web", "Estimate".
- `findExisting(item, food, pool)`: section 6.3.
- `compareNutrients(aiFood, existing)`: section 6.3.

### 6.3 Matching against the existing database (no second AI call)

Claude never sees the database. After the server answers, the app does the matching itself with the same
search pool the Add-food search uses (library, built-in list, enabled packs; recents and favorites included
as part of the library).

`findExisting(item, food, pool)`:
1. Query = `brand + ' ' + name` from the item. Run `rankFoods(query, pool, { limit: 12, localIds })` (js/foods.js).
2. A candidate survives when its name and brand tokens cover at least 60% of the item's name tokens (use
   `tokenize`; the item's brand words are taken out of its name first), and, when both have a brand, the brand
   tokens overlap at least one token (a brandless item never takes a branded built-in or pack food). For each
   survivor, its *head tokens* are the tokens of its name before the first comma (the whole name when there is
   no comma; "Grapes, red or green (...), raw" → "grapes"), minus its own brand tokens. A head token is
   accounted for when it is one of the item's name tokens, a synonym of one (`synonymsOf` in js/foods.js), or
   one of the item's brand tokens; the rest are `extra`. With `cmp = compareNutrients(food, candidate)`:
   - tier 0: no `extra`, and not comparable or `same`;
   - tier 1: no `extra`, comparable but not `same` (same thing, numbers differ: raw vs roasted chicken);
   - tier 2: `extra`, but comparable and `same` ("Nuts, almonds" for "almonds");
   - tier 3: `extra`, a library food, comparable, not `same` and not `far` (a saved food with descriptor words);
   - otherwise rejected ("Grape leaves" for "grapes", "Almond butter" for "almonds", "Banana bread" for
     "banana").
   Survivors sort by tier, then library foods first, then rank.
3. Returns `{ food: best, cmp } | null`, with the `cmp` computed for the best candidate.

`compareNutrients(aiFood, existing)`: compare per 100 g when neither is servingOnly, else per serving (the
first serving of each; if only one side is servingOnly, compare per serving when the other side has a serving,
otherwise return `{ comparable: false }`). Result `{ comparable, same, far, basis, diffs }` where `same` is true
when kcal is within 10% and each of p, c, f is within max(2 g, 15%). `diffs` lists `{ key, ai, existing }` for
the values outside that band (fiber is reported but never breaks `same`). `far` (computed independently, on the
same basis) means not plausibly the same food even allowing for source noise: kcal differ by more than 35% of
the larger value, or any macro's share of the energy (4p, 4c, 9f over their sum, when both sums are > 0)
differs by more than 0.20.

What the result card shows per item (section 6.4):
- No match: "New food" tag; Add creates the custom food.
- Match with `same`: card shows "Already in your foods: <name> · <brand>" with the existing food selected;
  the entry uses the existing food, nothing new is created. A "Use Claude's instead" link flips it to new.
- Match with differences: "Looks like <name> but the numbers differ" plus a two-column mini table of the
  differing values (Claude vs stored). Two choices: "Use stored" (entry uses the existing food) or, when the
  existing food is a custom food, "Update stored" (overwrite the existing food's per100 and serving with
  Claude's via the store's custom-food save, keeping the id, then use it; toast "Updated <name>"). For a
  built-in or pack food (read-only data files) the second choice is "Add corrected copy", which creates the
  custom food as usual. Default selection: "Update stored" / "Add corrected copy" when confidence is `label`;
  otherwise "Use stored" unless the stored food is `far` off, in which case Claude's version is the default.
- `not comparable`: treat as a match with `same` unknown: show "Already in your foods" with "Use stored"
  selected and a "Use Claude's instead" link.

### 6.4 Entry point: the add-food sheet (js/modals/food.js)

`openAddFood` shows an `.add-actions` row under the search box: "Scan barcode" (primary) and "AI add"
(`btn-ghost`, sparkle icon, `data-action="ai-add"`) side by side. The `ai-add` handler lives in
js/modals/ai.js (food.js does not import the AI modal; ai.js already imports `openCustomFood` from food.js, so
the dependency stays one-way; js/app.js imports js/modals/ai.js for its side effects). It reads the add-food
backdrop's `_ctx` (`{ meal, date }`) and calls `openAiAdd({ date, meal, replace: <add-food backdrop> })`;
without a ctx it falls back to today with the default meal. Uses the `sparkle` icon in js/ui.js.

### 6.5 `js/modals/ai.js`, the sheet

`openAiAdd({ date, meal, replace })`. A non-empty `meal` preselects that meal (kept even when it is not in the
meal list); otherwise the default below applies. `replace` (the add-food sheet) is closed together with the AI
sheet once items are logged; Cancel / close leaves it open. One modal with three states, re-rendered in place:

1. **Compose**: titled "AI add to <meal>" (the meal comes from the add-food sheet; there is no meal picker in
   the AI sheet since v1.6.3. The fallback when opened without one: the meal of the most recent entry on that
   date if it was added within the last 2 h, else by hour: before 10:30 the first meal, before 15:00 the second,
   before 20:00 the third, else the fourth); `<textarea>` with placeholder "What did you eat? e.g. 71 g of
   Dot's pretzels"; photo row with "Take photo" (`<input type="file" accept="image/*" capture="environment">`)
   and "Choose photo" (no capture), a thumbnail with a remove button once chosen; primary button "Ask Claude"
   enabled when text or photo is present. If the helper is not configured, show instead "Set up the AI helper
   in Settings" with a button that navigates to Settings.
2. **Waiting**: spinner, "Asking Claude… usually 20 to 40 s", Cancel (aborts the fetch).
3. **Result**: one card per item with a checkbox (on), name and brand, a confidence badge
   (`.ai-badge.label|web|estimate`), the `source` (muted, one line, ellipsis), the match block from section
   6.3, an amount input plus unit select (from `unitOptions` of whichever food is selected), and the macros for
   that amount (live via `nutrientsFor`). A text link "Edit details" opens `openCustomFood({ food, meal,
   date })` for Claude's version on top; if that saves, drop the item from the list and toast. Below the list:
   a "Not right? Tell Claude" field with "Ask again" (re-sends the original text and photo with a trailing
   line `Correction: <text>`), and the primary button "Add N to <meal>", which for each checked item resolves
   the chosen food (existing, updated, or new custom saved through the store's custom-food function), then
   `addEntry(date, { ...buildEntry(food, qty, unit), meal })`; toast "Added N items", close, re-render.
   Errors return to Compose with the message in a `.error` line and the inputs intact.

Keep the photo and text in memory for Ask again; discard on close. Max text 2000 chars.

### 6.6 Settings card "AI helper" (js/views/settings.js)

After the Weight feed card. Form `save-ai`: URL (placeholder `https://ai.example.com`), Secret
(`type="password"`), Save. Button `ai-test` shows "Connected · v1.6.0 · sonnet" or the error. Status line:
"Last answer <relative time>" / "Last error: …" / "Not set up". One sentence under the card: "Runs Claude on
your own server; see the README for setup." Clearing both fields and saving turns it off.

### 6.7 Misc

- css/app.css: `.add-actions`, `.ai-badge` (three colours), `.ai-item`, `.ai-match`, the mini diff table, the
  thumbnail; reuse the existing spinner if there is one.
- sw.js: add `./js/ai.js` and `./js/modals/ai.js` to SHELL; VERSION `v11`. js/update.js APP_VERSION `1.6.0`.
- README: new section "AI add (a Claude helper on your own server)" after the weight feed section: what it
  does, that it needs a Claude Pro/Max subscription and the user's own server, a pointer to server/README.md,
  the app-side steps (Settings, AI helper, URL and secret, Test), what the confirm card shows including the
  duplicate check.
- SPEC.md: one paragraph plus a pointer to this file.

## 7. Tests

- `tools/test_ai.mjs` (node, like test_feed.mjs): `foodFromAiItem` for the three `per` cases (per100 scaling,
  servingOnly flag, serving label); `amountFromAiItem` for grams, servings, neither, and per-100g with no
  serving; `normalizeUrl` accept and reject; `confidenceLabel`; `findExisting` (library match beats pack match,
  brand mismatch rejected, 60% token rule, head words must be the item's (grapes not grape leaves), numbers
  pick the variant (grilled chicken → roasted; raw only → far), same numbers forgive a category head word
  ("Nuts, almonds"), library food with descriptor words (tier 3; not the user's → null; "Banana bread" → null));
  `compareNutrients` (same within band, kcal 12% off flagged, servingOnly vs weighed not comparable, `far`).
- `tools/test_ai_server.mjs`: `corsHeaders` allow and deny; `validateBody` (missing both, too long text, bad
  mime, oversize base64); `parseClaudeOutput` (good, missing structured_output, bad numbers filtered, more
  than 8 items cut); `buildArgs` contains the lockdown flags and never `--bare`.
- Manual: run `node server/ai-server.mjs` locally (AI_SECRET set, PORT 8787) and the app on 8766; in the
  browser pane configure Settings, Test, then "AI add" with the text "Dot's pretzels original, 71g" (no photo)
  and confirm an entry lands in the diary. Then ask the same thing again and confirm the card offers the
  food created the first time as "Already in your foods" instead of making a second one.

## 8. Several photos per ask (v1.6.1)

A product usually needs two pictures: the front of the pack (name, brand, flavour) and the Nutrition Facts panel.
Up to 4 photos go with one ask.

Server:
- Body gains `images: [{ "data": "<base64>", "mime": "image/jpeg"|"image/png" }, …]` (at most 4 entries, each
  at most 4 MB of base64). The old `image` + `mime` pair still works as a one-photo shorthand; sending both is
  a 400. `MAX_BODY` becomes 12 MB.
- Files are written as `photo1.jpg`, `photo2.jpg`, … in the temp dir. Prompt line:
  `Photos: ./photo1.jpg, ./photo2.jpg (use Read on each; they show the same food: packaging, nutrition panel, plate).`
  The single-photo line stays as it was.
- `system.txt` gains one paragraph: when a photo shows a Nutrition Facts panel, read the numbers from it
  (confidence `label`, source "nutrition panel in photo") and take the product name, brand and flavour from the
  other photos or the text; do not search the web when the panel is readable.
- Log `image=yes` becomes `images=N`. Server `VERSION` 1.6.1.

App:
- `ctx.photos` (array, max 4) replaces `ctx.photo`. "Choose photo" input gets `multiple`. Both photo buttons
  hide once 4 are attached. Thumbnails render in a row, each with its own remove button. Ask again re-sends all
  of them.
- `askAi({ text, images, signal })` sends `images: [{data, mime}]` (nothing when empty). `downscaleImage` is
  applied to each file; a file that fails is skipped with a toast and the others stay.
- APP_VERSION 1.6.1, sw VERSION v12.

Tests: `validateBody` with `images` (count limit, bad entry, both forms given, shorthand still accepted);
`buildPrompt` with several photos; `askAi` body shape with two images.

## 9. Entry point moved to the add-food sheet (v1.6.2)

The "AI add" pill on the diary header is gone; the button now sits next to "Scan barcode" in the add-food
sheet (section 6.4), so the meal is the one whose + was tapped. Logging closes both sheets; cancelling the AI
sheet returns to the add-food sheet. APP_VERSION 1.6.2, sw VERSION v13. No server change.

## 10. Out of scope

Queueing more than one job, Cloudflare Access, streaming progress, sending candidates to Claude, editing name
and brand inline (use Edit details).

## 11. Smarter matching (v1.6.6)

"Grapes" matched "Grape leaves, canned": the top-ranked candidates tied on score and the matcher never looked
at the nutrients. Now a candidate's head words (name before the first comma, minus its brand) must be the
item's own words, synonyms or brand, unless the numbers agree (`same`) or it is a close library food; among
the survivors the nutrients pick the variant (tiers, section 6.3). `compareNutrients` reports `far`, and a
non-label match that is far off defaults to Claude's version. APP_VERSION 1.6.6, sw VERSION v17.
