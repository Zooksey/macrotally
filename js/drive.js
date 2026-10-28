// MacroTally — optional Google Drive backup (appDataFolder) via Google Identity Services + Drive REST.
// No gapi client library: plain fetch with a Bearer token. Nothing here touches the network
// unless config.googleClientId is set.
import { config } from './config.js';
import { state, save, defaults, exportJSON, importJSON } from './store.js';
import { requestRender } from './ui.js';

/** OAuth scopes: the app-private Drive folder plus the account email (for display and as login hint). */
export const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email';
/** Name of the single backup file kept in appDataFolder. */
export const BACKUP_FILENAME = 'macrotally-backup.json';

const GIS_URL = 'https://accounts.google.com/gsi/client';
const APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const SILENT_AUTH_FAILED = 'SILENT_AUTH_FAILED';
const SILENT_TIMEOUT_MS = 8000;
const FETCH_TIMEOUT_MS = 15000;
const GIS_LOAD_TIMEOUT_MS = 15000;
const DUE_MS = 20 * 60 * 60 * 1000;

/**
 * true when config.googleClientId is non-empty.
 * @returns {boolean}
 */
export function driveConfigured() {
  return typeof config.googleClientId === 'string' && config.googleClientId.trim() !== '';
}

function notConfiguredError() {
  return new Error('Google Drive backup is not set up');
}

// ---------- Google Identity Services ----------

let gisPromise = null;

function gisReady() {
  const g = globalThis.google;
  return g && g.accounts && g.accounts.oauth2 ? g.accounts.oauth2 : null;
}

/**
 * Lazily injects the GIS script once; resolves to window.google.accounts.oauth2.
 * @returns {Promise<object>}
 * @throws {Error} friendly message if the script cannot load (or the feature is not configured).
 */
export async function loadGIS() {
  if (!driveConfigured()) throw notConfiguredError();
  const ready = gisReady();
  if (ready) return ready;
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      let timer = null;
      const fail = () => {
        clearTimeout(timer);
        s.remove();
        gisPromise = null; // allow a retry later
        reject(new Error('Could not load Google sign-in. Are you online?'));
      };
      s.src = GIS_URL;
      s.async = true;
      s.defer = true;
      s.onload = () => {
        clearTimeout(timer);
        const oauth2 = gisReady();
        if (oauth2) resolve(oauth2);
        else fail();
      };
      s.onerror = fail;
      timer = setTimeout(fail, GIS_LOAD_TIMEOUT_MS);
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

let tokenClient = null;
/** Cached access token: { value, exp } (exp in ms since epoch, with a safety margin). */
let cachedToken = null;
/** Handlers of the token request currently waiting for GIS ({ ok, fail }), or null. */
let waiting = null;
/** The single in-flight token request promise, or null. */
let inflight = null;
/** true while a just-connected account has an existing Drive backup the user has not decided about (no auto overwrite). */
let holdAuto = false;

function validToken() {
  return cachedToken && Date.now() < cachedToken.exp ? cachedToken.value : null;
}

function cancelledError(message) {
  const err = new Error(message);
  err.cancelled = true;
  return err;
}

function onTokenResponse(resp) {
  const w = waiting;
  if (!resp || resp.error || !resp.access_token) {
    const code = resp && resp.error;
    const err = code === 'access_denied'
      ? cancelledError('Sign-in was cancelled.')
      : new Error(`Google sign-in failed${code ? ` (${code})` : ''}`);
    if (w) w.fail(err);
    return;
  }
  const oauth2 = gisReady();
  if (oauth2 && typeof oauth2.hasGrantedAllScopes === 'function' && !oauth2.hasGrantedAllScopes(resp, APPDATA_SCOPE)) {
    if (w) w.fail(new Error('MacroTally needs permission to keep its backup in your Google Drive. Connect again and leave the Drive box ticked.'));
    return;
  }
  const secs = Number(resp.expires_in) > 0 ? Number(resp.expires_in) : 3600;
  cachedToken = { value: resp.access_token, exp: Date.now() + Math.max(60, secs - 60) * 1000 };
  if (w) w.ok(resp.access_token);
}

function onTokenError(err) {
  const w = waiting;
  if (!w) return;
  const type = err && err.type;
  if (type === 'popup_closed') w.fail(cancelledError('Sign-in popup was closed'));
  else if (type === 'popup_failed_to_open') w.fail(new Error('Could not open the Google sign-in window. Allow pop-ups for this site and try again.'));
  else w.fail(new Error('Google sign-in failed'));
}

function ensureTokenClient(oauth2) {
  if (!tokenClient) {
    tokenClient = oauth2.initTokenClient({
      client_id: config.googleClientId.trim(),
      scope: DRIVE_SCOPES,
      callback: onTokenResponse,
      error_callback: onTokenError
    });
  }
  return tokenClient;
}

function requestToken(interactive) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const h = {
      ok: (value) => finish(null, value),
      // Any GIS-side failure in silent mode means a popup/consent would be needed.
      fail: (err) => finish(interactive ? err : new Error(SILENT_AUTH_FAILED))
    };
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (waiting === h) waiting = null;
      if (err) reject(err);
      else resolve(value);
    }
    if (!interactive) timer = setTimeout(() => finish(new Error(SILENT_AUTH_FAILED)), SILENT_TIMEOUT_MS);
    loadGIS().then((oauth2) => {
      if (settled) return;
      const client = ensureTokenClient(oauth2);
      waiting = h;
      const email = (state.drive && state.drive.email) || '';
      const opts = { prompt: interactive && !email ? 'consent' : '' };
      if (email) opts.hint = email;
      client.requestAccessToken(opts);
    }).catch((err) => finish(err)); // script load failure: report as-is (not an auth problem)
  });
}

/**
 * Obtain an access token. A cached unexpired token is returned without calling GIS.
 * interactive=true may show Google's popup (call only from a user gesture);
 * interactive=false never waits more than ~8 s and rejects with Error('SILENT_AUTH_FAILED') when a popup would be needed.
 * Only one token request is in flight at a time.
 * @param {{interactive?: boolean}} [opts]
 * @returns {Promise<string>}
 */
export async function getAccessToken({ interactive = false } = {}) {
  if (!driveConfigured()) throw notConfiguredError();
  const cached = validToken();
  if (cached) return cached;
  if (inflight) {
    try {
      await inflight;
    } catch {
      // fall through
    }
    const after = validToken();
    if (after) return after;
    if (!interactive) throw new Error(SILENT_AUTH_FAILED);
    if (inflight) throw new Error('Google sign-in is already in progress');
  }
  const p = requestToken(interactive);
  inflight = p;
  try {
    return await p;
  } finally {
    if (inflight === p) inflight = null;
  }
}

function dropToken() {
  cachedToken = null;
}

// ---------- Drive REST ----------

/**
 * fetch with Bearer auth, a 15 s timeout and friendly errors. Reads the whole body.
 * @returns {Promise<{status: number, text: string}>}
 */
async function driveFetch(url, token, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let res;
    let text;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
        signal: ctrl.signal
      });
      text = await res.text();
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('Google Drive took too long to respond. Try again.');
      throw new Error('Could not reach Google Drive. Are you online?');
    }
    if (res.ok) return { status: res.status, text };
    let err;
    if (res.status === 401) err = new Error('Google sign-in expired. Sign in again.');
    else if (res.status === 403) err = new Error('Google Drive refused the request (check that the Drive API is enabled for this app).');
    else err = new Error(`Google Drive error (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Run fn(token); on a 401 drop the cached token and retry once with a fresh one. */
async function withToken(interactive, fn) {
  const token = await getAccessToken({ interactive });
  try {
    return await fn(token);
  } catch (err) {
    if (!err || err.status !== 401) throw err;
    dropToken();
    const fresh = await getAccessToken({ interactive });
    return fn(fresh);
  }
}

/**
 * Find the backup file in appDataFolder (newest if there are several) and cache its id in state.drive.fileId.
 * @param {string} token
 * @returns {Promise<{id: string, modifiedTime: string, size: string|number}|null>}
 */
export async function findBackupFile(token) {
  const q = encodeURIComponent(`name='${BACKUP_FILENAME}'`);
  const fields = encodeURIComponent('files(id,name,modifiedTime,size)');
  const res = await driveFetch(`${FILES_URL}?spaces=appDataFolder&fields=${fields}&q=${q}`, token);
  const data = parseJSON(res.text);
  const files = data && Array.isArray(data.files) ? data.files.filter((f) => f && f.id) : [];
  files.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  const f = files[0] || null;
  const id = f ? f.id : null;
  if (state.drive.fileId !== id) {
    state.drive.fileId = id;
    save();
  }
  return f ? { id: f.id, modifiedTime: f.modifiedTime || null, size: f.size == null ? null : f.size } : null;
}

async function uploadState(token) {
  const body = exportJSON();
  let id = state.drive.fileId;
  if (!id) {
    const found = await findBackupFile(token);
    id = found ? found.id : null;
  }
  if (id) {
    try {
      await driveFetch(`${UPLOAD_URL}/${encodeURIComponent(id)}?uploadType=media&fields=id`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      return id;
    } catch (err) {
      if (!err || err.status !== 404) throw err;
      state.drive.fileId = null;
    }
  }
  const boundary = `macrotally-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const meta = { name: BACKUP_FILENAME, parents: ['appDataFolder'], mimeType: 'application/json' };
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(meta),
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    body,
    `--${boundary}--`,
    ''
  ].join('\r\n');
  const res = await driveFetch(`${UPLOAD_URL}?uploadType=multipart&fields=id`, token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: multipart
  });
  const data = parseJSON(res.text);
  if (!data || !data.id) throw new Error('Google Drive did not return the backup file');
  return data.id;
}

function friendlyMessage(err) {
  const msg = err && err.message ? err.message : 'Backup failed';
  return msg === SILENT_AUTH_FAILED ? 'Tap to sign in again and back up' : msg;
}

/**
 * Connect flow from a user gesture: interactive token → userinfo email → connected → first backup.
 * If a backup already exists in this account's Drive, the first backup is skipped and it is returned as
 * `existing` so the UI can offer to restore it instead of overwriting it.
 * @returns {Promise<{email: string, existing: ({id: string, modifiedTime: string, size: *}|null)}>}
 */
export async function connectDrive() {
  const token = await getAccessToken({ interactive: true });
  const res = await driveFetch(USERINFO_URL, token);
  const info = parseJSON(res.text) || {};
  const email = typeof info.email === 'string' ? info.email : '';
  holdAuto = true; // no silent auto backup until we know whether Drive already holds a backup
  Object.assign(state.drive, { connected: true, email, lastError: null });
  save();
  let existing;
  try {
    existing = await withToken(true, (t) => findBackupFile(t));
  } catch (err) {
    holdAuto = false;
    state.drive.lastError = friendlyMessage(err);
    save();
    throw err;
  }
  if (existing) return { email, existing };
  holdAuto = false;
  await backupNow({ interactive: true });
  return { email, existing: null };
}

/**
 * Revoke the cached token (failures ignored), forget it, and reset state.drive to defaults. The Drive file is kept.
 * @returns {Promise<void>}
 */
export async function disconnectDrive() {
  const token = validToken() || (cachedToken && cachedToken.value);
  const oauth2 = gisReady();
  if (token && oauth2 && typeof oauth2.revoke === 'function') {
    try {
      oauth2.revoke(token, () => {});
    } catch {
      // ignore
    }
  }
  cachedToken = null;
  holdAuto = false;
  state.drive = defaults().drive;
  save();
}

/**
 * Upload the current state to the backup file (create it if missing). Retries once on 401.
 * On failure stores a friendly message in state.drive.lastError and rethrows.
 * @param {{interactive?: boolean}} [opts]
 * @returns {Promise<{at: string}>}
 */
export async function backupNow({ interactive = false } = {}) {
  if (!driveConfigured()) throw notConfiguredError();
  if (!state.drive.connected) throw new Error('Connect Google Drive first');
  const d = state.drive; // if the user disconnects mid-upload, results land on the discarded block
  try {
    const id = await withToken(interactive, (t) => uploadState(t));
    const at = new Date().toISOString();
    Object.assign(d, { fileId: id, lastBackupAt: at, lastError: null });
    holdAuto = false;
    save();
    return { at };
  } catch (err) {
    d.lastError = friendlyMessage(err);
    save();
    throw err;
  }
}

/**
 * Download the backup without applying it.
 * @param {{interactive?: boolean}} [opts]
 * @returns {Promise<{text: string, modifiedTime: string|null, summary: {days: number, entries: number, weights: number, foods: number}}>}
 */
export async function fetchBackup({ interactive = true } = {}) {
  if (!driveConfigured()) throw notConfiguredError();
  return withToken(interactive, async (token) => {
    const file = await findBackupFile(token);
    if (!file) throw new Error('No backup found in your Google Drive yet.');
    let res;
    try {
      res = await driveFetch(`${FILES_URL}/${encodeURIComponent(file.id)}?alt=media`, token);
    } catch (err) {
      if (err && err.status === 404) {
        state.drive.fileId = null;
        save();
        throw new Error('No backup found in your Google Drive yet.');
      }
      throw err;
    }
    const obj = parseJSON(res.text);
    if (!obj || typeof obj !== 'object' || !obj.diary || typeof obj.diary !== 'object') throw new Error('Backup file is not valid');
    const days = Object.values(obj.diary);
    const summary = {
      days: days.length,
      entries: days.reduce((n, day) => n + (day && Array.isArray(day.entries) ? day.entries.length : 0), 0),
      weights: Array.isArray(obj.weights) ? obj.weights.length : 0,
      foods: obj.foods && typeof obj.foods === 'object' ? Object.keys(obj.foods).length : 0
    };
    return { text: res.text, modifiedTime: file.modifiedTime, summary };
  });
}

/**
 * Apply a fetched backup, keeping this device's Drive connection block.
 * @param {string} text
 * @throws {Error} 'Not a MacroTally backup' when invalid.
 * @returns {void}
 */
export function applyBackup(text) {
  const keep = state.drive;
  importJSON(text);
  state.drive = keep;
  save();
}

/**
 * true when connected, auto backup on, and the last backup from this device is missing or older than 20 hours.
 * @returns {boolean}
 */
export function backupDue() {
  const d = state.drive;
  if (!d || !d.connected || !d.autoBackup) return false;
  if (!d.lastBackupAt) return true;
  const t = Date.parse(d.lastBackupAt);
  return !Number.isFinite(t) || Date.now() - t > DUE_MS;
}

let autoRun = null;
/** Earliest time (ms) for the next automatic token request after a failed one, to avoid repeated popups. */
let nextAutoAttempt = 0;
const AUTO_RETRY_MS = 6 * 60 * 60 * 1000;

/** true while the browser would allow a popup: a user gesture happened in the last few seconds. */
function inGesture() {
  const ua = globalThis.navigator && globalThis.navigator.userActivation;
  return !!(ua && ua.isActive);
}

/**
 * Automatic daily backup. Never throws; errors land in state.drive.lastError. Re-renders if anything changed.
 * Google only mints tokens through a popup, and browsers block popups outside a user gesture, so:
 * - with a cached, unexpired token the upload runs silently any time (start, becoming visible);
 * - otherwise the token request runs only inside a gesture window (we are called after every render that a
 *   tap caused), and a failure pauses automatic attempts for 6 hours; the diary banner covers the rest.
 * Concurrent calls share one run.
 * @returns {Promise<void>}
 */
export async function autoBackupIfDue() {
  if (autoRun) return autoRun;
  autoRun = (async () => {
    try {
      if (!driveConfigured() || holdAuto || !backupDue()) return;
      if (!validToken()) {
        if (!inGesture() || Date.now() < nextAutoAttempt) return;
        nextAutoAttempt = Date.now() + AUTO_RETRY_MS;
      }
      const before = `${state.drive.lastBackupAt}|${state.drive.lastError}`;
      try {
        await backupNow({ interactive: false });
        nextAutoAttempt = 0;
      } catch (err) {
        const msg = friendlyMessage(err);
        if (state.drive.connected && state.drive.lastError !== msg) {
          state.drive.lastError = msg;
          save();
        }
      }
      if (`${state.drive.lastBackupAt}|${state.drive.lastError}` !== before) requestRender();
    } catch (err) {
      console.warn('MacroTally: auto backup failed', err);
    }
  })();
  try {
    await autoRun;
  } finally {
    autoRun = null;
  }
}
