# Google Drive backup — feature spec (addendum to SPEC.md)

Goal: each user can connect their own Google account and have MacroTally keep a backup of their data in a hidden, app-private folder of their own Google Drive (the Drive "appDataFolder"). No server. Backups happen automatically about once a day when the app is opened, plus "Back up now" and "Restore from Drive" buttons. Works for anyone who opens the hosted link; nothing touches the app owner's account.

Everything stays static and relative-path. The only new third-party script is Google Identity Services (GIS), loaded lazily from `https://accounts.google.com/gsi/client` and never cached by the service worker (it is cross-origin, so the existing `sw.js` rule already excludes it).

## Configuration

New file `js/config.js`:

```js
/** App-level configuration. Values here are public (a web OAuth client ID is not a secret). */
export const config = {
  /** Google OAuth 2.0 Web client ID from console.cloud.google.com. Leave '' to hide the Google Drive backup feature. */
  googleClientId: ''
};
```

When `googleClientId` is empty, the Settings card shows a short "not set up by the app owner" note (see UI) and no Google scripts are loaded.

## State (store.js)

Add to `defaults()` (and the nested merge on load):

```js
drive: {
  connected: false,
  email: '',            // account email, for display and as login hint
  fileId: null,         // Drive file id of macrotally-backup.json in appDataFolder
  autoBackup: true,
  lastBackupAt: null,   // ISO timestamp string of the last successful upload from THIS device
  lastError: null       // string shown in the Settings card until the next success
}
```

Rules:
- `exportJSON()` output and `importJSON()` input still carry the whole state, **but** `importJSON()` and `restoreFromDrive()` must keep the device's current `state.drive` block (connection belongs to the device, not the backup). Implement by saving `const keep = state.drive` before `replaceState` and reassigning afterward.
- `resetAll()` clears `drive` too (default values).

## js/drive.js (LOGIC) — exports

```js
export const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email';
export const BACKUP_FILENAME = 'macrotally-backup.json';

/** true when config.googleClientId is non-empty. */
export function driveConfigured(): boolean

/** Lazily injects the GIS script once; resolves to window.google.accounts.oauth2. Rejects with a friendly Error if it cannot load. */
export async function loadGIS(): Promise<object>

/** Obtain an access token.
 *  interactive=true  → may show Google's popup (call only from a user gesture); uses prompt 'consent' the first time (no email yet) else ''.
 *  interactive=false → prompt '' with `hint: state.drive.email`; must resolve/reject within ~8 s (timer) and NEVER leave the UI waiting; reject with Error('SILENT_AUTH_FAILED') when the popup would be needed.
 *  Tokens are kept in module memory with their expiry (expires_in from GIS); a cached unexpired token is returned without calling GIS.
 *  Implementation: google.accounts.oauth2.initTokenClient({ client_id, scope: DRIVE_SCOPES, callback, error_callback }) once; call tokenClient.requestAccessToken({ prompt, hint }). */
export async function getAccessToken({ interactive = false } = {}): Promise<string>

/** Connect flow from a user gesture: getAccessToken({interactive:true}) → GET https://www.googleapis.com/oauth2/v3/userinfo (Bearer) → state.drive.connected = true, email, lastError = null → save. Then runs backupNow({interactive:true}) so there is an immediate first backup. Returns { email }. */
export async function connectDrive(): Promise<{ email: string }>

/** Revokes the current token via google.accounts.oauth2.revoke when one is cached (ignore failures), clears the in-memory token, and resets state.drive to defaults (connected false). save(). Does not delete the file in Drive. */
export async function disconnectDrive(): Promise<void>

/** Find the backup file in appDataFolder. GET https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&q=name='macrotally-backup.json'
 *  Returns { id, modifiedTime, size } | null and caches id in state.drive.fileId. */
export async function findBackupFile(token): Promise<{id, modifiedTime, size}|null>

/** Upload the current state.
 *  - body = exportJSON()
 *  - if a file exists (state.drive.fileId or findBackupFile): PATCH https://www.googleapis.com/upload/drive/v3/files/{id}?uploadType=media  (Content-Type: application/json)
 *    on 404 → clear fileId and fall through to create
 *  - else create: POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart with a multipart/related body: part 1 metadata JSON { name: BACKUP_FILENAME, parents: ['appDataFolder'], mimeType: 'application/json' }, part 2 the JSON content.
 *  - on success: state.drive.fileId = id, lastBackupAt = new Date().toISOString(), lastError = null; save(); return { at }
 *  - on 401 once: drop cached token, retry with getAccessToken({interactive}) a single time
 *  - on failure: state.drive.lastError = friendly message; save(); rethrow
 *  silent/interactive is passed through to getAccessToken. */
export async function backupNow({ interactive = false } = {}): Promise<{ at: string }>

/** Download: GET https://www.googleapis.com/drive/v3/files/{id}?alt=media → text. Returns { text, modifiedTime, summary } where summary = { days: Object.keys(obj.diary).length, entries: total entries, weights: obj.weights.length, foods: Object.keys(obj.foods).length } computed from a parsed copy (throw Error('Backup file is not valid') if it fails to parse or lacks .diary). Does NOT apply it. */
export async function fetchBackup({ interactive = true } = {}): Promise<{ text, modifiedTime, summary }>

/** Apply a fetched backup: keep = state.drive; importJSON(text); state.drive = keep; save(). */
export function applyBackup(text): void

/** true when connected, autoBackup on, and lastBackupAt is null or older than 20 hours. */
export function backupDue(): boolean

/** Called by app.js on start (after refreshExpenditure) and on visibilitychange → visible.
 *  If driveConfigured() && backupDue(): try backupNow({interactive:false}); swallow errors (they land in state.drive.lastError, with 'SILENT_AUTH_FAILED' mapped to 'Tap to sign in again and back up'). Never throws. Then requestRender() if anything changed.
 *  Guard against concurrent runs with a module-level promise. */
export async function autoBackupIfDue(): Promise<void>
```

HTTP helper: one `driveFetch(url, token, init)` with a 15 s AbortController timeout and friendly errors: network TypeError → 'Could not reach Google Drive. Are you online?'; 401 → throw an Error with `.status = 401` so backupNow can retry; 403 → 'Google Drive refused the request (check that the Drive API is enabled for this app).'; other → `Google Drive error (HTTP n)`.

Do not use the `gapi` client library; plain `fetch` with `Authorization: Bearer` is enough.

## UI

### Settings (views/settings.js) — new card placed directly above the existing "Backup" card

Title "Google Drive backup".

- `!driveConfigured()`: muted text "Not set up. The app owner needs to add a Google client ID in js/config.js (see README)." — nothing else.
- configured, not connected: one paragraph "Keeps a copy of your data in a private folder of your own Google Drive and refreshes it about once a day when you open the app. Nothing is shared with anyone else." + primary button **Connect Google Drive** (`data-action="drive-connect"`).
- connected: "Connected as {email}" · "Last backup: {relative time or 'never from this device'}" · if lastError: red small text. Toggle (checkbox, `data-change="drive-auto"`) "Back up automatically". Buttons: **Back up now** (`drive-backup`), **Restore from Drive** (`drive-restore`, ghost), **Disconnect** (`drive-disconnect`, ghost/danger text).
- Handlers show progress via `toast` ("Backing up…", "Backed up to Google Drive", errors as `toast(msg, {kind:'error'})`) and `requestRender()` after each.
- Restore flow: `fetchBackup()` → `confirmDialog` with the backup's date (local format) and summary ("Replace everything on this device with the Drive backup from Oct 28, 2026 3:12 PM? It has 41 logged days, 310 entries, 38 weigh-ins and 52 foods.", danger:true, okLabel 'Replace') → `applyBackup(text)` → toast → `location.reload()`.
- Connect: on error show the message; a special case: if the error message mentions 'popup' or the token flow was closed by the user, toast "Sign-in was cancelled."

### Diary banner (views/diary.js)

If `driveConfigured() && state.drive.connected && state.drive.lastError` show a slim tappable banner under the summary card: "Google Drive backup needs attention · Tap to back up" (`data-action="drive-backup"`). Also show it (text "Backup overdue · Tap to back up") when `backupDue()` and lastBackupAt is more than 3 days old or null. Reuse the Settings handler (register the actions in `modals`-style shared module or in settings.js, which is already imported by app.js; just make sure the action names are registered exactly once).

### app.js

After the existing start-up `refreshExpenditure` and render, call `autoBackupIfDue()` (fire-and-forget). In the existing `visibilitychange` handler, also call it when the page becomes visible.

### README

Add a section "Google Drive backup (optional, for the app owner)" with these steps, written for someone who has never used Google Cloud:
1. Go to https://console.cloud.google.com/ and create a project (e.g. "MacroTally").
2. APIs & Services → Library → enable **Google Drive API**.
3. APIs & Services → OAuth consent screen: External; app name "MacroTally", your email as support and developer contact; add scopes `.../auth/drive.appdata` and `.../auth/userinfo.email`; save. Then under Audience/Publishing status click **Publish app** (these scopes are non-sensitive so no review is required; while in "Testing" only listed test users can sign in).
4. APIs & Services → Credentials → Create credentials → OAuth client ID → Web application; Authorized JavaScript origins: `https://YOUR-USER.github.io` and `http://localhost:8765` (for local testing). No redirect URIs needed.
5. Copy the client ID into `js/config.js`, bump `VERSION` in `sw.js`, commit and push.
Also note: the data goes to each user's own Drive in a hidden app folder; the owner never sees it; disconnecting does not delete the file (users can remove it under Google Drive → Settings → Manage apps).

Also list `js/config.js` and `js/drive.js` in `sw.js`'s precache list.

## Acceptance checks (reviewer)
- With `googleClientId: ''`: no request to accounts.google.com is ever made; Settings shows the not-set-up note; diary shows no banner; `node --check` clean; unit tests still pass.
- With a client ID set (manual test by the owner): Connect shows Google's consent popup, then "Connected as …", first backup succeeds; Back up now updates "Last backup"; Restore shows the summary dialog and reloads with the restored data; Disconnect returns to the not-connected card; reopening the app the next day backs up silently.
