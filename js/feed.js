/**
 * MacroTally — weight feed: weigh-ins from a smart scale, via Apple Health → iPhone Shortcut → secret GitHub
 * gist → this app. Web apps cannot read HealthKit, so a daily Shortcut automation writes recent weight samples
 * into a gist file (one sample per line) and the app pulls the gist when it opens. Gist reads are
 * unauthenticated (api.github.com allows browser requests, 60 per hour per IP), so only state.feed.gistId is
 * needed. Days the feed wrote are remembered in state.feed.imported so a later value can update them, while a
 * weigh-in the user typed is never touched.
 */
import { state, save, todayStr, addDays, toKg } from './store.js';
import { toast, requestRender } from './ui.js';

/** GitHub REST endpoint for one gist (id appended). */
export const GIST_API = 'https://api.github.com/gists/';

const MIN_INTERVAL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
/** Feed-written days older than this are dropped from state.feed.imported. */
const KEEP_DAYS = 400;
/** A feed value must differ from the stored weigh-in by at least this much to update it. */
const UPDATE_MIN_KG = 0.05;
/** Stored weigh-in still equals what the feed wrote (so the user has not retyped it). */
const SAME_KG = 0.005;
/** Plausible body weights; anything outside is a parse mistake (e.g. a year or a time). */
const MIN_KG = 20;
const MAX_KG = 400;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');

const YMD_RE = /(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/;
const MDY_RE = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/;
// Right after the date: "07:12", " 7:12 AM", "T07:12:00", ", 07:12:00.000Z", "T06:58:00-07:00".
const TIME_RE = /^(?:T|[\s,;]+)(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:\s*([AaPp])\.?[Mm]\.?)?(?:Z|[+-]\d{2}:?\d{2})?(?![\d:])/;
const NUM_RE = /(\d+(?:[.,]\d+)?)(?:\s*(kilograms?|kgs?|pounds?|lbs?))?(?![a-z])/gi;

function validDate(y, m, d) {
  if (!(y >= 1900 && y <= 2999 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dim = new Date(y, m, 0).getDate();
  return d <= dim ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

/** First recognisable date in a line: { date, start, end } or null. */
function findDate(line) {
  const hits = [];
  const a = YMD_RE.exec(line);
  if (a) hits.push({ date: validDate(+a[1], +a[2], +a[3]), start: a.index, end: a.index + a[0].length });
  const b = MDY_RE.exec(line);
  if (b) hits.push({ date: validDate(+b[3], +b[1], +b[2]), start: b.index, end: b.index + b[0].length });
  const ok = hits.filter((h) => h.date).sort((x, y) => x.start - y.start);
  return ok[0] || null;
}

/** Time directly after the date: { time: 'HH:MM', len } or null. */
function findTime(rest) {
  const m = TIME_RE.exec(rest);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3] ? m[3].toLowerCase() : '';
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'a' && h === 12) h = 0;
    else if (ap === 'p' && h !== 12) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return { time: `${pad2(h)}:${pad2(min)}`, len: m[0].length };
}

/** The weight in kg from the text left after removing the date/time, or null. */
function findKg(text, defaultUnit) {
  const nums = [];
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(text))) nums.push({ value: Number(m[1].replace(',', '.')), unit: m[2] ? m[2].toLowerCase() : '' });
  if (!nums.length) return null;
  const pick = nums.find((n) => n.unit) || nums[0];
  let kg;
  if (pick.unit.startsWith('k')) kg = pick.value;
  else if (pick.unit) kg = toKg(pick.value, 'imperial');
  else kg = toKg(pick.value, defaultUnit === 'metric' ? 'metric' : 'imperial');
  return Number.isFinite(kg) && kg >= MIN_KG && kg <= MAX_KG ? kg : null;
}

/** Sort by date, then time; a sample without a time sorts after timed ones of the same day. */
function bySample(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time === b.time) return 0;
  if (a.time === null) return 1;
  if (b.time === null) return -1;
  return a.time < b.time ? -1 : 1;
}

/**
 * Parse weigh-in lines. One sample per line; a line holds a date (YYYY-MM-DD, YYYY/MM/DD or M/D/YYYY,
 * optionally followed by a time like 07:12, 7:12 AM or T07:12:00) and a number with an optional unit
 * (lb, lbs, pound(s), kg, kilogram(s); case-insensitive). Separators: spaces, commas, tabs, semicolons.
 * Lines without both a date and a number are skipped (headers, blanks). A number without a unit uses
 * defaultUnit ('imperial' → lb, 'metric' → kg). Returns samples sorted by date then time.
 * @param {string} text
 * @param {'imperial'|'metric'} defaultUnit
 * @returns {{date:string, time:string|null, kg:number}[]}
 */
export function parseWeightLines(text, defaultUnit) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const d = findDate(line);
    if (!d) continue;
    const t = findTime(line.slice(d.end));
    const end = d.end + (t ? t.len : 0);
    const kg = findKg(`${line.slice(0, d.start)} ${line.slice(end)}`, defaultUnit);
    if (kg === null) continue;
    out.push({ date: d.date, time: t ? t.time : null, kg });
  }
  return out.sort(bySample);
}

/**
 * Pick one sample per day: the earliest time of that day (morning weigh-ins are the standard; a sample
 * without a time sorts after timed ones).
 * @param {{date:string, time:string|null, kg:number}[]} samples
 * @returns {{date:string, kg:number}[]} sorted by date
 */
export function dailyWeights(samples) {
  const seen = new Set();
  const out = [];
  for (const s of [...(samples || [])].sort(bySample)) {
    if (seen.has(s.date)) continue;
    seen.add(s.date);
    out.push({ date: s.date, kg: s.kg });
  }
  return out;
}

/**
 * Merge feed weigh-ins into state.weights (pure logic, exported for tests; mutates state, does not save):
 * for each {date, kg}: skip if the date has a weigh-in that the feed did not write (not in
 * feed.imported, or retyped by the user since); add when the date has none (unless the feed wrote it and the
 * user deleted it); update when the feed wrote it and the new value differs by ≥ 0.05 kg. Records
 * feed.imported[date] = kg for every added/updated day and prunes it to the last 400 days. Only dates ≤ today.
 * @param {object} state App state (needs weights; feed is created when missing).
 * @param {{date:string, kg:number}[]} daily
 * @returns {{added:number, updated:number}}
 */
export function mergeFeedWeights(state, daily) {
  if (!isObj(state.feed)) state.feed = { gistId: '', lastSync: null, lastCount: 0, lastError: null, imported: {} };
  if (!isObj(state.feed.imported)) state.feed.imported = {};
  if (!Array.isArray(state.weights)) state.weights = [];
  const imported = state.feed.imported;
  const today = todayStr();
  const byDate = new Map(state.weights.map((w) => [w.date, w]));
  let added = 0;
  let updated = 0;
  for (const { date, kg } of daily || []) {
    if (typeof date !== 'string' || date > today || !Number.isFinite(kg)) continue;
    const had = Object.prototype.hasOwnProperty.call(imported, date);
    const w = byDate.get(date);
    if (!w) {
      if (had) continue; // the feed wrote this day and the user deleted it: leave it deleted
      const row = { date, kg };
      state.weights.push(row);
      byDate.set(date, row);
      imported[date] = kg;
      added++;
    } else if (had && Math.abs(Number(w.kg) - Number(imported[date])) < SAME_KG) {
      if (Math.abs(Number(w.kg) - kg) >= UPDATE_MIN_KG) {
        w.kg = kg;
        imported[date] = kg;
        updated++;
      }
    }
    // else: a weigh-in the user typed; never overwritten
  }
  if (added) state.weights.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const cutoff = addDays(today, -KEEP_DAYS);
  for (const k of Object.keys(imported)) if (k < cutoff) delete imported[k];
  return { added, updated };
}

/**
 * Extract the text of the first file of a gist API response (prefer names ending .txt/.csv/.json).
 * @param {object} json Body of GET /gists/{id}.
 * @returns {string} '' when the gist has no readable file.
 */
export function gistText(json) {
  const files = isObj(json) && isObj(json.files) ? Object.values(json.files).filter(isObj) : [];
  const named = (f) => /\.(txt|csv|json)$/i.test(String(f.filename || ''));
  const file = files.find(named) || files[0];
  return file && typeof file.content === 'string' ? file.content : '';
}

/**
 * Gist id from what the user pasted (an id or a full gist URL): the last run of 20-40 hex characters, lowercased.
 * @param {string} input
 * @returns {string} '' when there is none.
 */
export function parseGistId(input) {
  const all = String(input ?? '').match(/[0-9a-f]{20,40}/gi);
  return all ? all[all.length - 1].toLowerCase() : '';
}

let inflight = null;
let lastAttempt = 0;

function httpError(status) {
  if (status === 404) return 'Gist not found (404)';
  if (status === 403 || status === 429) return `GitHub rate limit, try later (${status})`;
  return `GitHub error (HTTP ${status})`;
}

async function runSync() {
  const feed = state.feed;
  const before = feed.lastError;
  const fail = (msg) => {
    feed.lastError = msg;
    save();
    if (msg !== before) requestRender();
    return null;
  };
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS) : null;
  let json;
  try {
    let res;
    try {
      res = await fetch(GIST_API + encodeURIComponent(feed.gistId), {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      return fail(e && e.name === 'AbortError' ? 'GitHub took too long to respond' : 'Could not reach GitHub');
    }
    if (!res.ok) return fail(httpError(res.status));
    try {
      json = await res.json();
    } catch {
      return fail('GitHub sent an unreadable reply');
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  const samples = parseWeightLines(gistText(json), state.profile.units);
  const result = mergeFeedWeights(state, dailyWeights(samples));
  const n = result.added + result.updated;
  Object.assign(state.feed, { lastSync: new Date().toISOString(), lastCount: n, lastError: null });
  save();
  if (n > 0) {
    toast(`${n} weigh-in${n === 1 ? '' : 's'} from the scale`);
    requestRender();
  } else if (before) {
    requestRender();
  }
  return result;
}

/**
 * Fetch the gist and merge. Skips silently when feed.gistId is blank or offline. Unless force, runs at
 * most once per 30 minutes (lastSync, and the last attempt this session) and never concurrently (a call
 * during a sync gets that sync's result). A non-2xx sets feed.lastError ("Gist not found (404)";
 * "GitHub rate limit, try later (403)") and resolves null. On success: parse, dailyWeights,
 * mergeFeedWeights, set lastSync/lastCount/lastError=null, save, and when added+updated > 0: toast
 * "N weigh-ins from the scale" and requestRender(). Never rejects.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{added:number, updated:number}|null>}
 */
export async function syncWeightFeed({ force = false } = {}) {
  const feed = state.feed;
  if (!feed || typeof feed.gistId !== 'string' || !feed.gistId.trim()) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
  if (inflight) return inflight;
  if (!force) {
    const last = Math.max(Date.parse(feed.lastSync) || 0, lastAttempt);
    if (Date.now() - last < MIN_INTERVAL_MS) return null;
  }
  lastAttempt = Date.now();
  inflight = runSync()
    .catch((err) => {
      console.warn('MacroTally: weight feed sync failed', err);
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
