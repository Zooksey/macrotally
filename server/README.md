# MacroTally AI helper (server)

A small HTTP service that lets MacroTally's **AI add** button ask Claude what you ate. It runs the Claude Code
CLI headless (`claude -p`) on **your own Claude Pro or Max subscription**, on a machine you control (the steps
below use an Unraid box behind a Cloudflare Tunnel). The app sends a description and/or a photo; Claude reads the
label from the photo or looks it up on the web and returns a list of foods with their nutrition, which the app
shows for you to confirm.

Plain Node 22, no dependencies. Files: `ai-server.mjs` (the service), `schema.json` (the answer format),
`system.txt` (Claude's instructions), `Dockerfile`, `docker-compose.yml`, `.env.example`.

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

Do not set `ANTHROPIC_API_KEY`: the server removes it for the CLI anyway, because with it set Claude would bill
the API instead of using your subscription.

## 3. Build and run on Unraid

Copy this `server/` folder to the Unraid box (for example `/mnt/user/appdata/macrotally-ai/`), then either:

- **Compose Manager plugin** (Apps tab → "Docker Compose Manager"): add a new stack, point it at that folder (or
  paste `docker-compose.yml`), put the `.env` next to it, and click **Compose Up**.
- **Over SSH**: `cd /mnt/user/appdata/macrotally-ai && docker compose up -d --build`.

Check it from the Unraid shell:

```sh
curl -H "Authorization: Bearer $AI_SECRET" http://localhost:8787/v1/health
# {"ok":true,"version":"1.6.1","model":"sonnet"}
```

`docker compose logs -f` in that folder (or the container's log in the Unraid UI) shows one line per request: time, status,
seconds, item count, text length and number of photos (`images=N`). The text, photos and token are never logged.

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
**Save** → **Test**. It should say "Connected · v1.6.1 · sonnet". The **AI add** button in the add-food sheet (tap + on a meal)
then works.

If the app is hosted somewhere other than the default origins (your own GitHub Pages user, a custom domain), add
that origin (scheme + host, no path) to `ALLOWED_ORIGINS`, or the browser will block the answers.

## API

All responses are JSON. Every request except `OPTIONS` needs `Authorization: Bearer <AI_SECRET>` (else 401
`{"error":"bad secret"}`).

- `GET /v1/health` → `{"ok":true,"version":"1.6.1","model":"sonnet"}`
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

## Running it on a PC (for development)

`AI_SECRET=<16+ chars> node ai-server.mjs` in this folder. If `CLAUDE_CODE_OAUTH_TOKEN` is not set, the CLI's own
login is used (run `claude` once and sign in); the server only warns. On Windows the npm `claude.cmd` shim is
resolved to the `claude.exe` it launches, so no shell is involved; set `CLAUDE_BIN` to the CLI's full path if it
cannot be found.
