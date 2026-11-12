# MacroTally AI helper (server)

A small HTTP service that lets MacroTally's **AI add** button ask Claude what you ate. It runs the Claude Code
CLI headless (`claude -p`) on **your own Claude Pro or Max subscription**, on a machine you control (the steps
below use an Unraid box behind a Cloudflare Tunnel). The app sends a description and/or a photo; Claude reads the
label from the photo or looks it up on the web and returns a list of foods with their nutrition, which the app
shows for you to confirm.

It also relays the app's product text search to Open Food Facts (`GET /v1/search`, see below) and keeps a
"Brands you use" food pack built from the Open Food Facts product export for the brands you log most.

Plain Node 22, no dependencies. Files: `ai-server.mjs` (the service), `off-pack.mjs` (reads the Open Food Facts
export and builds product packs), `schema.json` (the answer format), `system.txt` (Claude's instructions),
`Dockerfile`, `docker-compose.yml`, `.env.example`.

## 1. Get a login token (on your PC)

The server has no browser, so it logs in with a long-lived token instead:

1. Install the CLI on a PC with a browser: `npm install -g @anthropic-ai/claude-code`.
2. Run `claude setup-token`, sign in with the Claude account that has the subscription, and copy the token it
   prints (valid for one year).

**The token is a login to your Claude account.** Anyone who has it can use your subscription. Keep `.env`
private (it is git-ignored), never paste the token into the app, and rotate it by running `claude setup-token`
again and replacing the value (then restart the container).

## 2. Make `.env`

Copy `.env.example` to `.env` next to it and fill in:

- `CLAUDE_CODE_OAUTH_TOKEN`: the token from step 1.
- `AI_SECRET`: a random string of at least 16 characters. The app sends it with every request; the server refuses
  to start without it. Make one with
  `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
- Optional: `AI_MODEL` (default `sonnet`), `ALLOWED_ORIGINS` (where the app is hosted; default
  `https://zooksey.github.io,http://localhost:8766,http://127.0.0.1:8766`), `PORT` (8787), `AI_TIMEOUT_MS`
  (85000), `AI_MAX_TURNS` (10).
- Optional, for search and the brand pack: `DATA_DIR` (`/data`, where the brand list, pack and servings index are saved; the
  Dockerfile sets it), `SEARCH_RATE_PER_MIN` (30 searches per minute per client IP; all clients together are
  also capped at 120 Open Food Facts calls per minute), `EXPORT_URL` (the Open Food Facts export,
  `https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz`), `PACK_COUNTRY`
  (`en:united-states`; empty means every country).

Do not set `ANTHROPIC_API_KEY`: the server removes it for the CLI anyway, because with it set Claude would bill
the API instead of using your subscription.

## 3. Build and run on Unraid

Copy this `server/` folder to the Unraid box (for example `/mnt/user/appdata/macrotally-ai/`) and create the
data folder the container saves into (`docker-compose.yml` mounts `./data` at `/data`). The server runs as the
container user `app`, **uid 1001 / gid 1001**, so that folder must be writable by uid 1001:

```sh
cd /mnt/user/appdata/macrotally-ai && mkdir -p data && chown 1001:1001 data
```

(If Docker creates `./data` itself it is owned by root and the server cannot write to it: it still starts and
answers searches and AI requests, but the brand endpoints answer 503 `{"error":"no data dir"}` until the
folder is fixed; it re-checks about once a minute.) Then either:

- **Compose Manager plugin** (Apps tab → "Docker Compose Manager"): add a new stack, point it at that folder (or
  paste `docker-compose.yml`), put the `.env` next to it, and click **Compose Up**.
- **Over SSH**: `cd /mnt/user/appdata/macrotally-ai && docker compose up -d --build`.

Check it from the Unraid shell:

```sh
curl -H "Authorization: Bearer $AI_SECRET" http://localhost:8787/v1/health
# {"ok":true,"version":"1.8.1","model":"sonnet","brands":0,"pack":null,"servings":null,"building":false,"lastBuildError":null}
```

`docker compose logs -f` in that folder (or the container's log in the Unraid UI) shows one line per request: time, status,
seconds, item count, text length and number of photos (`images=N`); searches log only the query length (`q=N`),
the region and the hit count. The text, photos, search words and token are never logged.

To update the CLI, rebuild: `docker compose build --no-cache && docker compose up -d`.

## 4. Publish it through your Cloudflare Tunnel

In the Cloudflare dashboard: **Zero Trust** → **Networks** → **Tunnels** → your tunnel → **Public Hostname** →
**Add a public hostname**:

- Subdomain `ai`, your domain, so the address is `https://ai.<domain>`.
- Service type **HTTP**, URL `http://<unraid-ip>:8787`.

Then test from anywhere:

```sh
curl -H "Authorization: Bearer $AI_SECRET" https://ai.<domain>/v1/health
```

The free Cloudflare plan is enough. Cloudflare's proxy gives up on a request after 100 seconds, which is why the
server stops Claude after 85 s (`AI_TIMEOUT_MS`); most answers take 10 to 30 s. Grocery retailer sites (Kroger,
Walmart, Target, Instacart, Amazon and similar) stall automated fetches for a full minute instead of refusing
them, so the server denies fetches to those domains (`BLOCKED_DOMAINS` in ai-server.mjs) and the prompt caps
research at two searches and two fetches.

Without the dashboard: for a tunnel that runs with a token (dashboard-managed), the same two things can be done
over the API with a token that has **Account · Cloudflare Tunnel · Edit** and **Zone · DNS · Edit**:
`PUT /accounts/<account>/cfd_tunnel/<tunnel>/configurations` with the existing `config` plus an ingress rule
`{ "hostname": "ai.<domain>", "service": "http://<unraid-ip>:8787" }` inserted before the catch-all, and
`POST /zones/<zone>/dns_records` with `{ "type": "CNAME", "name": "ai", "content": "<tunnel>.cfargotunnel.com",
"proxied": true }`. Ids come from `GET /zones` and `GET /accounts/<account>/cfd_tunnel?is_deleted=false`.

## 5. Connect the app

In MacroTally: **Settings** → **AI helper** → URL `https://ai.<domain>`, the same secret as `AI_SECRET` →
**Save** → **Test**. It should say "Connected · v1.8.0 · sonnet". The **AI add** button in the add-food sheet (tap + on a meal)
then works.

If the app is hosted somewhere other than the default origins (your own GitHub Pages user, a custom domain), add
that origin (scheme + host, no path) to `ALLOWED_ORIGINS`, or the browser will block the answers.

## API

All responses are JSON. Every request except `OPTIONS` and `GET /v1/search` needs
`Authorization: Bearer <AI_SECRET>` (else 401 `{"error":"bad secret"}`).

- `GET /v1/health` →
  `{"ok":true,"version":"1.8.1","model":"sonnet","brands":12,"pack":{"generated":"2026-11-11","foods":2140,"brands":["Kellogg's","Fairlife"]},"servings":{"count":1850000,"builtAt":"2026-11-11T08:02:00.000Z"},"building":false,"lastBuildError":null}`
  (`pack` is `null` until the first brand pack is built, `servings` is `null` until the first servings index is
  built).
- `POST /v1/food` with
  `{ "text": "71g of these", "images": [{ "data": "<base64, no data: prefix>", "mime": "image/jpeg" }, ...] }`
  (text up to 2000 characters; up to 4 images, each up to 4 MB of base64, `mime` `image/jpeg` or `image/png`;
  body up to 12 MB; at least one of text or an image) →
  `{ "items": [...], "model": "sonnet", "seconds": 19.4 }`. Each item follows `schema.json`.
  Several photos are taken to show the same food (say the front of the pack and the Nutrition Facts panel).
  The older one-photo form `{ "text": "...", "image": "<base64>", "mime": "image/jpeg" }` still works; sending
  both `image` and `images` is a 400.
  Errors: 400 bad input, 413 too large, 429 `{"error":"busy"}` (one job at a time, no queue), 502
  `{"error":"no result","detail":"..."}`, 504 `{"error":"timeout"}`.

### Product search relay (no secret)

- `GET /v1/search?q=<text>&region=us` → `{"products":[{"code":"0038000199929","product_name":"Rice Krispies",
  "brands":"Kellogg's","nutriments":{"energy-kcal_100g":375,"proteins_100g":7.5,"carbohydrates_100g":87.5,
  "fat_100g":0},"unique_scans_n":5,"partial":true}, ...],"source":"search-a-licious","cached":false}`
  (up to 25 products, only those with a barcode and a name; a nutriment key is present only when Open Food Facts
  has it). The search service sends no serving sizes, so the server adds them from its servings index (see
  below): a product found there also has `"serving_size":"28 g","serving_quantity":28`, so the app can show
  calories per serving; others have neither. `partial` stays true either way: the app still looks the barcode up
  for the full label.
  `q` is 2 to 100 characters (else 400 `{"error":"bad query"}`). `region` (`us`, `ca`, `gb`/`uk`, `ie`, `au`,
  `nz`, `fr`, `de`, `es`, `it`) limits results to products sold there; anything else means worldwide.
  The words are passed on as plain text (query syntax such as `field:` or quotes is removed).

  It relays Open Food Facts' search service (`search.openfoodfacts.org`), which answers quickly and reliably but
  sends no CORS header, so the browser cannot call it directly. **It is open without the secret by design**: it
  only returns public Open Food Facts data, CORS limits browser use to `ALLOWED_ORIGINS`, each client IP
  (Cloudflare's `CF-Connecting-IP`, else the first `X-Forwarded-For`, else the socket) may make
  `SEARCH_RATE_PER_MIN` searches per minute and all clients together at most 120 Open Food Facts calls per minute
  (429 `{"error":"rate limited"}`), answers are cached in memory for 6 hours (500 searches) and sent with
  `Cache-Control: public, max-age=3600`. An Open Food Facts failure or an 8 s timeout is 502 `{"error":"upstream"}`.

### Brands you use and the servings index (secret required)

The app sends the brands you log most; the server builds a food pack of those brands' US products from the
Open Food Facts export (a ~1.5 GB file, streamed and never stored; a build takes several minutes and the server
keeps answering meanwhile). The same pass also builds the servings index used by the search relay: the serving
size in grams of every product in the export (all countries) that has one, keyed by barcode (about 12 bytes per
product, in memory and on disk). Files in `DATA_DIR`: `brands.json`, `brand-pack.json`, `build-state.json`,
`servings.idx` (the index; a missing or unreadable file is ignored and rebuilt).

- `PUT /v1/brands` with `{"brands":[{"name":"Kellogg's","n":14},{"name":"Fairlife","n":9}]}` (at most 300 brands,
  names up to 60 characters, `n` = how often you logged it; body up to 64 KB) replaces the saved list
  (de-duplicated by brand: "Kellogg's" and "Kelloggs" are one) → `{"ok":true,"count":2}`.
- `GET /v1/brands` → `{"brands":[...],"updated":"2026-11-11T18:00:00.000Z"}`.
- `GET /v1/brand-pack` → the pack (`macrotally-pack/1`, `kind: "products"`, id `my-brands`, each food with its
  barcode `bc` and brand `b`; up to 1500 products per brand and 20000 in all) with an `ETag`; send it back as
  `If-None-Match` to get 304 when nothing changed. 404 `{"error":"no pack yet"}` before the first build.
- `POST /v1/brand-pack/rebuild` → 202 `{"started":true}`, or 200 `{"started":false,"running":true}` when a build
  is already running. With no brands saved the build makes only the servings index (no pack).
- Automatic builds: checked 2 minutes after start and then hourly. A build runs when none is running and either
  there is no servings index or it is more than 7 days old (brands or not), or brands are saved and there is no
  pack yet, or the pack is more than 7 days old, or the brand list changed and the last attempt was more than
  20 hours ago. Every build writes a new servings index; it writes the pack only when brands are saved. After a
  failed build (`lastBuildError` in health) the next try waits at least 6 hours.
- Without a writable `DATA_DIR` these endpoints answer 503 `{"error":"no data dir"}`; search and AI still work.

## Running it on a PC (for development)

`AI_SECRET=<16+ chars> node ai-server.mjs` in this folder. If `CLAUDE_CODE_OAUTH_TOKEN` is not set, the CLI's own
login is used (run `claude` once and sign in); the server only warns. On Windows the npm `claude.cmd` shim is
resolved to the `claude.exe` it launches, so no shell is involved; set `CLAUDE_BIN` to the CLI's full path if it
cannot be found.
