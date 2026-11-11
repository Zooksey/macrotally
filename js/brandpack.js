/**
 * MacroTally — "Brands you use": the brands of the packaged products you log (state.brands, counted by addEntry in
 * js/store.js) are sent to your own AI helper (`PUT /v1/brands`, top 300 by count, `{ name, n }` only), which builds a
 * pack of those brands' products. The pack (`GET /v1/brand-pack`, id `my-brands`) is fetched at most once per 20 h
 * (and on demand), stored as JSON text with its ETag in Cache Storage (cache `macrotally-data`; memory only when the
 * Cache API is missing, never in localStorage) and handed to js/packs.js as a remote pack, so it searches and scans
 * like any other pack and can be switched off. Nothing here runs unless the AI helper is set up; every failure is
 * silent (retried on the next change or start). No DOM access, so it runs under Node for the tests.
 */
import { state, save, onBrandsChange } from './store.js';
import { aiConfigured, aiUrl } from './ai.js';
import { setRemotePack, remotePackInfo } from './packs.js';

/** Id of the helper's pack. */
export const BRAND_PACK_ID = 'my-brands';
/** Cache Storage name for app data that must outlive app updates (sw.js keeps it). */
export const DATA_CACHE = 'macrotally-data';
/** Cache key of the stored pack (a URL nothing ever fetches). */
const PACK_KEY = 'https://macrotally.invalid/data/brand-pack.json';
/** Most brands sent to the helper. */
export const MAX_BRANDS = 300;
/** Minimum time between automatic pack checks. */
const CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Debounce of the brand sync after a change. */
const SYNC_DELAY_MS = 5000;
const TIMEOUT_MS = 20000;

/** The stored pack in memory: { text, etag }, or null. */
let stored = null;
/** Promise of the one-time load of the stored copy. */
let storedLoad = null;
let checking = null;
let syncing = null;
let syncAgain = false;
let syncTimer = null;
let started = false;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The brand list sent to the helper: state.brands sorted by count (then most recent, then name), at most
 * MAX_BRANDS, as `{ name, n }`.
 * @param {object} [s] app state
 * @returns {{name: string, n: number}[]}
 */
export function brandPayload(s = state) {
  const list = Object.values(isObj(s && s.brands) ? s.brands : {})
    .filter((b) => isObj(b) && typeof b.name === 'string' && b.name.trim() && Number(b.n) >= 1);
  list.sort((a, b) => Number(b.n) - Number(a.n) || String(b.last || '').localeCompare(String(a.last || '')) || a.name.localeCompare(b.name));
  return list.slice(0, MAX_BRANDS).map((b) => ({ name: b.name.trim(), n: Math.floor(Number(b.n)) }));
}

/** fetch with a timeout; resolves to the Response or null on a network error / timeout. */
async function helperFetch(path, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${aiUrl(state)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${String(state.ai.secret).trim()}`, ...headers },
      body,
      signal: ctrl.signal,
      cache: 'no-store'
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send the brand list to the helper (`PUT /v1/brands`) when the AI helper is set up and the list changed since the
 * last successful send (state.brandSync.sent). Never throws.
 * @param {{force?: boolean}} [opts] force: send even when unchanged
 * @returns {Promise<'off'|'unchanged'|'sent'|'failed'>}
 */
export function syncBrands({ force = false } = {}) {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    let result;
    do {
      syncAgain = false;
      result = await syncOnce(force);
    } while (syncAgain);
    return result;
  })().finally(() => { syncing = null; });
  return syncing;
}

async function syncOnce(force) {
  if (!aiConfigured(state)) return 'off';
  const brands = brandPayload(state);
  const json = JSON.stringify(brands);
  const sent = String((state.brandSync && state.brandSync.sent) || '');
  if (!force && (json === sent || (!brands.length && !sent))) return 'unchanged';
  const res = await helperFetch('/v1/brands', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brands })
  });
  if (!res || !res.ok) return 'failed';
  if (!isObj(state.brandSync)) state.brandSync = { sent: '', sentAt: null, packCheckedAt: null };
  state.brandSync.sent = json;
  state.brandSync.sentAt = new Date().toISOString();
  save();
  return 'sent';
}

/** Sync the brand list about 5 s after the last change (fire-and-forget). */
export function scheduleBrandSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncBrands(); }, SYNC_DELAY_MS);
  if (syncTimer && typeof syncTimer.unref === 'function') syncTimer.unref(); // Node (tests): never keeps the process alive
}

/** The data cache, or null when the Cache API is unavailable. */
async function dataCache() {
  try {
    if (typeof caches === 'undefined' || !caches || typeof caches.open !== 'function') return null;
    return await caches.open(DATA_CACHE);
  } catch {
    return null;
  }
}

/** Hand pack JSON text to packs.js; returns its summary, or null when it is not a valid my-brands pack. */
function apply(text) {
  try {
    return setRemotePack(BRAND_PACK_ID, JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Load the stored pack (Cache Storage, else the copy kept in memory) into packs.js, without any network request.
 * Runs once; later calls return the same promise. Never throws.
 * @returns {Promise<boolean>} true when a stored pack was applied
 */
export function loadStoredBrandPack() {
  if (!storedLoad) {
    storedLoad = (async () => {
      const cache = await dataCache();
      if (cache) {
        try {
          const res = await cache.match(PACK_KEY);
          if (res) stored = { text: await res.text(), etag: (res.headers && res.headers.get('ETag')) || '' };
        } catch {
          // An unreadable copy is ignored; the next check downloads a new one.
        }
      }
      return !!(stored && apply(stored.text));
    })();
  }
  return storedLoad;
}

async function store(text, etag) {
  stored = { text, etag };
  const cache = await dataCache();
  if (!cache || typeof Response !== 'function') return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers.ETag = etag;
    await cache.put(PACK_KEY, new Response(text, { headers }));
  } catch {
    // Kept in memory for this session.
  }
}

/**
 * Ask the helper for a new "Brands you use" pack (`GET /v1/brand-pack` with If-None-Match), at most once per 20 h
 * unless forced. 200 → validated, stored and shown; 304 / 404 (no pack yet) / 503 / network errors change nothing.
 * Never throws.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<'off'|'fresh'|'updated'|'unchanged'|'none'|'failed'>} fresh = checked less than 20 h ago
 */
export function refreshBrandPack({ force = false } = {}) {
  if (checking) return checking;
  checking = checkOnce(force).finally(() => { checking = null; });
  return checking;
}

async function checkOnce(force) {
  if (!aiConfigured(state)) return 'off';
  const last = Date.parse((state.brandSync && state.brandSync.packCheckedAt) || '');
  if (!force && Number.isFinite(last) && Date.now() - last < CHECK_INTERVAL_MS && Date.now() >= last) return 'fresh';
  await loadStoredBrandPack();
  const headers = {};
  if (stored && stored.etag && remotePackInfo(BRAND_PACK_ID)) headers['If-None-Match'] = stored.etag;
  const res = await helperFetch('/v1/brand-pack', { headers });
  if (!res) return 'failed';
  if (!isObj(state.brandSync)) state.brandSync = { sent: '', sentAt: null, packCheckedAt: null };
  state.brandSync.packCheckedAt = new Date().toISOString();
  save();
  if (res.status === 304) return 'unchanged';
  if (res.status === 404) return 'none';
  if (res.status !== 200) return 'failed';
  let text;
  try {
    text = await res.text();
  } catch {
    return 'failed';
  }
  if (!apply(text)) return 'failed';
  await store(text, (res.headers && res.headers.get('ETag')) || '');
  return 'updated';
}

/**
 * Summary of the "Brands you use" pack on this device, or null when there is none yet.
 * @returns {{id:string, name:string, count:number, generated:string}|null}
 */
export function brandPackInfo() {
  return remotePackInfo(BRAND_PACK_ID);
}

/**
 * Forget the stored pack (memory, packs.js and Cache Storage), e.g. when all data is erased. Never throws.
 * @returns {Promise<void>}
 */
export async function clearBrandPack() {
  stored = null;
  storedLoad = Promise.resolve(false);
  setRemotePack(BRAND_PACK_ID, null);
  const cache = await dataCache();
  if (cache) {
    try {
      await cache.delete(PACK_KEY);
    } catch {
      // ignore
    }
  }
}

/**
 * Start-up (app.js): load the stored pack without network, then, with the AI helper set up, send the brand list if
 * it changed and check for a new pack (at most once per 20 h). Later brand changes are synced about 5 s after they
 * happen. Fire-and-forget; never rejects.
 * @param {{onUpdate?: Function}} [opts] onUpdate: called when a pack was loaded or updated (e.g. to re-render)
 * @returns {Promise<void>}
 */
export async function startBrandPack({ onUpdate = null } = {}) {
  if (!started) {
    started = true;
    onBrandsChange(scheduleBrandSync);
  }
  const changed = () => { if (typeof onUpdate === 'function') onUpdate(); };
  try {
    if (await loadStoredBrandPack()) changed();
    if (!aiConfigured(state)) return;
    await syncBrands();
    if ((await refreshBrandPack()) === 'updated') changed();
  } catch {
    // never rejects
  }
}
