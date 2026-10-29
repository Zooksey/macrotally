// MacroTally — Settings view: profile, food sources, food packs, meals, install, Google Drive backup, weight feed,
// backup, about.
import { state, save, todayStr, exportJSON, importJSON, resetAll } from '../store.js';
import { refreshExpenditure } from '../calc.js';
import { REGIONS } from '../foods.js';
import { esc, fmt, parseNum, on, toast, requestRender, confirmDialog } from '../ui.js';
import { nav } from '../app.js';
import { openSetup } from '../modals/setup.js';
import { listPacks, importPack, removePack, setPackEnabled, loadPacks, packsLoaded } from '../packs.js';
import { driveConfigured, loadGIS, connectDrive, disconnectDrive, backupNow, fetchBackup, applyBackup } from '../drive.js';
import { syncWeightFeed, parseGistId } from '../feed.js';

import { APP_VERSION, checkForUpdate, updateAvailable } from '../update.js';

/** Activity multipliers used for the initial expenditure estimate. */
export const ACTIVITY_LEVELS = [
  { value: 1.2, label: 'Sedentary (desk job, little exercise)' },
  { value: 1.4, label: 'Lightly active' },
  { value: 1.55, label: 'Moderately active' },
  { value: 1.7, label: 'Active' },
  { value: 1.9, label: 'Very active' }
];

/**
 * Activity <option>s with the closest level preselected.
 * @param {number} current
 * @returns {string} HTML
 */
export function activityOptions(current) {
  const cur = Number(current) || 1.4;
  let best = ACTIVITY_LEVELS[0].value;
  ACTIVITY_LEVELS.forEach((a) => {
    if (Math.abs(a.value - cur) < Math.abs(best - cur)) best = a.value;
  });
  return ACTIVITY_LEVELS.map((a) => `<option value="${a.value}"${a.value === best ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
}

/**
 * Split centimetres into feet + inches for display.
 * @param {number} cm
 * @returns {{ft: number, inch: number}}
 */
export function cmToFtIn(cm) {
  const total = (Number(cm) || 0) / 2.54;
  let ft = Math.floor(total / 12);
  let inch = Math.round(total - ft * 12);
  if (inch === 12) {
    ft += 1;
    inch = 0;
  }
  return { ft, inch };
}

/**
 * Height input(s) markup: ft + in when imperial, cm when metric.
 * @param {number} heightCm
 * @param {'imperial'|'metric'} units
 * @returns {string} HTML
 */
export function heightFields(heightCm, units) {
  if (units === 'imperial') {
    const { ft, inch } = cmToFtIn(heightCm);
    return `
      <div class="field"><span>Height</span>
        <div class="split-inputs">
          <label class="suffix-input"><input name="heightFt" type="text" inputmode="numeric" value="${esc(ft)}" aria-label="Feet"><span>ft</span></label>
          <label class="suffix-input"><input name="heightIn" type="text" inputmode="decimal" value="${esc(inch)}" aria-label="Inches"><span>in</span></label>
        </div>
      </div>`;
  }
  return `<label class="field"><span>Height (cm)</span><input name="heightCm" type="text" inputmode="decimal" value="${esc(Math.round(Number(heightCm) || 0))}"></label>`;
}

/**
 * Read height from a form built with heightFields (whichever inputs are present).
 * @param {HTMLFormElement} form
 * @returns {number} centimetres, NaN when invalid.
 */
export function readHeightCm(form) {
  const ftEl = form.elements.namedItem('heightFt');
  if (ftEl) {
    const ft = parseNum(ftEl.value);
    const inEl = form.elements.namedItem('heightIn');
    const inch = inEl && inEl.value.trim() !== '' ? parseNum(inEl.value) : 0;
    if (!(ft >= 0) || !(inch >= 0)) return NaN;
    return (ft * 12 + inch) * 2.54;
  }
  const cmEl = form.elements.namedItem('heightCm');
  return cmEl ? parseNum(cmEl.value) : NaN;
}

function installCard() {
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  let body;
  if (standalone) {
    body = '<p class="muted small">MacroTally is installed on this device.</p>';
  } else if (window.__installPrompt) {
    body = '<button type="button" class="btn btn-primary btn-block" data-action="install-app">Install app</button>';
  } else {
    body = `
      <p class="small"><strong>iPhone / iPad (Safari):</strong> tap the Share button, then <em>Add to Home Screen</em>.</p>
      <p class="small"><strong>Android (Chrome):</strong> open the browser menu (⋮), then <em>Install app</em> or <em>Add to Home screen</em>.</p>`;
  }
  return `<section class="card"><h2>Install</h2>${body}</section>`;
}

/** "Food packs" card: bundled and imported restaurant menus (each with an on/off switch), plus the import button. */
function packsCard() {
  if (!packsLoaded()) {
    // Bundled packs load in the background; re-render once (only if that load succeeds, so no retry loop).
    loadPacks().then(() => {
      if (packsLoaded() && nav.tab === 'settings') requestRender();
    });
  }
  const packs = listPacks();
  const onCount = packs.filter((pk) => pk.enabled).length;
  const rows = packs.map((pk) => `
      <div class="pack-row${pk.enabled ? '' : ' is-off'}">
        <label class="pack-toggle"><input type="checkbox" class="switch" data-change="toggle-pack" data-id="${esc(pk.id)}" aria-label="On: ${esc(pk.name)}"${pk.enabled ? ' checked' : ''}><span>On</span></label>
        <div class="pack-main">
          <div class="pack-name">${esc(pk.name)}</div>
          <div class="muted small">${esc(plural(pk.count, 'item'))}${pk.generated ? ` · updated ${esc(pk.generated)}` : ''}${pk.bundled ? ' · built in' : ''}</div>
        </div>
        ${pk.bundled ? '' : `<button type="button" class="btn btn-ghost btn-ghost-danger" data-action="remove-pack" data-id="${esc(pk.id)}">Remove</button>`}
      </div>`).join('');
  return `
    <section class="card">
      <div class="card-head"><h2>Food packs</h2>${packs.length ? `<span class="muted small">${fmt(onCount)} of ${fmt(packs.length)} on</span>` : ''}</div>
      ${packs.length ? `<div class="pack-list">${rows}</div>` : '<p class="muted small">No food packs yet.</p>'}
      <label class="btn btn-ghost btn-block file-btn">Import food pack
        <input class="visually-hidden" type="file" accept=".json,application/json" data-change="import-pack">
      </label>
      <p class="hint">A pack is a JSON file of menu items (see README). Imported packs are stored on this device and included in backups. Switch off the chains you never visit to keep search results short.</p>
    </section>`;
}

function plural(n, one, many = `${one}s`) {
  return `${fmt(n)} ${n === 1 ? one : many}`;
}

/** Local date + time like 'Oct 28, 2026 3:12 PM'. */
function backupDate(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return 'an unknown date';
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} ${time}`;
}

/** 'just now', '5 min ago', '3 h ago', 'yesterday', '4 days ago', else a date. */
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never from this device';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return backupDate(iso);
}

function summaryText(s) {
  return `It has ${plural(s.days, 'logged day')}, ${plural(s.entries, 'entry', 'entries')}, ${plural(s.weights, 'weigh-in')} and ${plural(s.foods, 'food')}.`;
}

function driveCard() {
  let body;
  if (!driveConfigured()) {
    body = '<p class="muted small">Not set up. The app owner needs to add a Google client ID in js/config.js (see README).</p>';
  } else {
    // Warm up Google sign-in so the popup can open straight from the button tap (iOS blocks late popups).
    loadGIS().catch(() => {});
    const d = state.drive;
    if (!d.connected) {
      body = `
        <p class="small">Keeps a copy of your data in a private folder of your own Google Drive and refreshes it about once a day when you open the app. Nothing is shared with anyone else.</p>
        <button type="button" class="btn btn-primary btn-block" data-action="drive-connect">Connect Google Drive</button>`;
    } else {
      body = `
        <p class="small">Connected as <strong>${esc(d.email || 'your Google account')}</strong></p>
        <p class="muted small">Last backup: ${esc(d.lastBackupAt ? relativeTime(d.lastBackupAt) : 'never from this device')}</p>
        ${d.lastError ? `<p class="small over">${esc(d.lastError)}</p>` : ''}
        <label class="check-row"><input type="checkbox" data-change="drive-auto"${d.autoBackup ? ' checked' : ''}><span>Back up automatically</span></label>
        <div class="btn-stack">
          <button type="button" class="btn btn-primary btn-block" data-action="drive-backup">Back up now</button>
          <button type="button" class="btn btn-ghost btn-block" data-action="drive-restore">Restore from Drive</button>
          <button type="button" class="btn btn-ghost btn-ghost-danger btn-block" data-action="drive-disconnect">Disconnect</button>
        </div>`;
    }
  }
  return `<section class="card"><h2>Google Drive backup</h2>${body}</section>`;
}

/** "Weight feed" card: gist id of the Apple Health → Shortcut → gist feed, sync status and Sync now. */
function feedCard() {
  const f = state.feed;
  let status = '';
  if (f.gistId) {
    if (f.lastError) status = `<p class="small warn">Sync failed: ${esc(f.lastError)}</p>`;
    else if (f.lastSync) status = `<p class="muted small">Last sync ${esc(relativeTime(f.lastSync))} · ${esc(plural(f.lastCount || 0, 'weigh-in'))}</p>`;
    else status = '<p class="muted small">Not synced yet</p>';
  }
  return `
    <form class="card" data-submit="save-feed">
      <h2>Weight feed</h2>
      <p class="small">Brings in weigh-ins from a smart scale through Apple Health: an iPhone Shortcut copies them to a secret GitHub gist once a day, and MacroTally reads it when you open the app. Weigh-ins you type here are never overwritten.</p>
      <label class="field"><span>Gist id</span>
        <input name="gistId" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(f.gistId)}" placeholder="32 characters from the gist's address">
      </label>
      ${status}
      <div class="btn-stack">
        <button type="submit" class="btn btn-primary btn-block">Save weight feed</button>
        ${f.gistId ? '<button type="button" class="btn btn-ghost btn-block" data-action="feed-sync">Sync now</button>' : ''}
      </div>
      <p class="hint">Leave the id empty to switch the feed off. See the README for the Shortcut that fills the gist from Apple Health.</p>
    </form>`;
}

/**
 * Settings tab.
 * @returns {string} HTML
 */
export function settingsView() {
  const p = state.profile;
  const units = p.units === 'metric' ? 'metric' : 'imperial';
  return `
    <header class="topbar"><h1>Settings</h1></header>

    <form class="card" data-submit="save-profile">
      <h2>Profile</h2>
      <label class="field"><span>Name (optional)</span><input name="displayName" type="text" autocomplete="given-name" value="${esc(p.name)}"></label>
      <div class="field-row">
        <label class="field"><span>Sex</span>
          <select name="sex">
            <option value="male"${p.sex === 'male' ? ' selected' : ''}>Male</option>
            <option value="female"${p.sex === 'female' ? ' selected' : ''}>Female</option>
          </select>
        </label>
        <label class="field"><span>Birth year</span><input name="birthYear" type="text" inputmode="numeric" value="${esc(p.birthYear)}"></label>
      </div>
      <div class="field-row">
        ${heightFields(p.heightCm, units)}
        <label class="field"><span>Units</span>
          <select name="units">
            <option value="imperial"${units === 'imperial' ? ' selected' : ''}>Imperial (lb, ft)</option>
            <option value="metric"${units === 'metric' ? ' selected' : ''}>Metric (kg, cm)</option>
          </select>
        </label>
      </div>
      <label class="field"><span>Activity level</span><select name="activity">${activityOptions(p.activity)}</select></label>
      <p class="hint">Activity only sets the starting expenditure estimate; after that it adapts to your data.</p>
      <button type="submit" class="btn btn-primary btn-block">Save profile</button>
      <button type="button" class="btn btn-ghost btn-block" data-action="rerun-setup">Run setup again</button>
    </form>

    <form class="card" data-submit="save-usda">
      <h2>Food sources</h2>
      <p class="small">Open Food Facts is always on (barcodes and search, no key needed).</p>
      <label class="field"><span>Search region</span>
        <select name="region">
          ${REGIONS.map((r) => `<option value="${r.code}" ${(p.region || 'world') === r.code ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
      </label>
      <p class="hint">Ranks search results by what is popular in your country. Barcodes are looked up worldwide.</p>
      <label class="field"><span>USDA API key (optional: your own key; a shared one is built in)</span>
        <input name="usdaKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(p.usdaKey)}" placeholder="Leave empty to use the shared key">
      </label>
      <p class="hint">USDA adds generic foods (fruit, meat, rice…) and US branded products to search and barcode lookups. The shared key has an hourly limit for everyone; a free key of your own from <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener noreferrer">fdc.nal.usda.gov</a> avoids it.</p>
      <button type="submit" class="btn btn-primary btn-block">Save food sources</button>
    </form>

    ${packsCard()}

    <form class="card" data-submit="save-meals">
      <h2>Meals</h2>
      <label class="field"><span>Meal names, comma separated</span>
        <input name="meals" type="text" autocomplete="off" value="${esc((state.meals || []).join(', '))}">
      </label>
      <button type="submit" class="btn btn-primary btn-block">Save meals</button>
    </form>

    ${installCard()}

    ${driveCard()}

    ${feedCard()}

    <section class="card">
      <h2>Backup</h2>
      <p class="muted small">Your data lives only in this browser. Export a backup now and then, especially before clearing site data or switching phones.</p>
      <div class="btn-stack">
        <button type="button" class="btn btn-ghost btn-block" data-action="export-backup">Export backup</button>
        <label class="btn btn-ghost btn-block file-btn">Import backup
          <input class="visually-hidden" type="file" accept="application/json,.json" data-change="import-file">
        </label>
        <button type="button" class="btn btn-danger btn-block" data-action="erase-all">Erase all data</button>
      </div>
    </section>

    <section class="card about">
      <h2>About</h2>
      <p class="small">MacroTally is a free, open macro tracker: barcode scanning, trend weight and an adaptive expenditure estimate.</p>
      <p class="small"><strong>Privacy:</strong> there is no server and no account. Everything you log stays on this device${driveConfigured() ? ' (plus your own Google Drive if you connect it)' : ''}. Food searches go directly to Open Food Facts and USDA FoodData Central.</p>
      <p class="muted small">Version ${esc(APP_VERSION)} · Food data © Open Food Facts contributors (ODbL) and USDA FoodData Central</p>
      ${updateAvailable()
        ? '<button type="button" class="btn btn-primary btn-block" data-action="app-update">Reload to update</button>'
        : '<button type="button" class="btn btn-ghost btn-block" data-action="check-update">Check for updates</button>'}
      <p class="hint">Updates install on their own when you open the app; closing it fully and reopening is enough. You never need to re-add it to your home screen.</p>
    </section>`;
}

on('check-update', async (el) => {
  el.disabled = true;
  toast('Checking…');
  const result = await checkForUpdate();
  if (result === 'ready') toast('A new version is ready. Reload to update.');
  else if (result === 'current') toast(`You're on the latest version (${APP_VERSION}).`);
  else toast('Updates are handled by your browser here.');
  requestRender();
});

on('save-profile', (form) => {
  const p = state.profile;
  const birthYear = Math.round(parseNum(form.birthYear.value));
  const heightCm = readHeightCm(form);
  const thisYear = new Date().getFullYear();
  if (!(birthYear >= 1900 && birthYear <= thisYear - 10)) {
    toast('Enter a valid birth year', { kind: 'error' });
    return;
  }
  if (!(heightCm >= 90 && heightCm <= 250)) {
    toast('Enter a valid height', { kind: 'error' });
    return;
  }
  p.name = form.displayName.value.trim();
  p.sex = form.sex.value === 'female' ? 'female' : 'male';
  p.birthYear = birthYear;
  p.heightCm = Math.round(heightCm * 10) / 10;
  p.units = form.units.value === 'metric' ? 'metric' : 'imperial';
  p.activity = Number(form.activity.value) || 1.4;
  // While still on the initial (formula) estimate, recompute it from the new profile.
  if (state.expenditure && state.expenditure.method !== 'adaptive') {
    state.expenditure.kcal = null;
    refreshExpenditure(state);
  }
  save();
  toast('Profile saved');
  requestRender();
});

on('rerun-setup', () => openSetup());

on('save-usda', (form) => {
  state.profile.usdaKey = form.usdaKey.value.trim();
  state.profile.region = form.region.value || 'world';
  save();
  toast('Food sources saved');
  requestRender();
});

on('save-meals', (form) => {
  const seen = new Set();
  const meals = form.meals.value.split(',')
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 8);
  state.meals = meals.length ? meals : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  save();
  toast('Meals saved');
  requestRender();
});

on('install-app', async () => {
  const ev = window.__installPrompt;
  if (!ev) return;
  ev.prompt();
  try {
    await ev.userChoice;
  } catch (err) {
    // ignore
  }
  window.__installPrompt = null;
  requestRender();
});

on('export-backup', () => {
  const blob = new Blob([exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `macrotally-backup-${todayStr()}.json`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Backup exported');
});

function readFileText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read that file'));
    r.readAsText(file);
  });
}

on('import-file', async (el) => {
  const file = el.files && el.files[0];
  if (!file) return;
  let text;
  try {
    text = await readFileText(file);
  } finally {
    el.value = '';
  }
  const ok = await confirmDialog('Replace ALL data on this device with this backup? This cannot be undone.', { okLabel: 'Replace', danger: true });
  if (!ok) return;
  try {
    importJSON(text);
  } catch (err) {
    toast(err && err.message ? err.message : 'Not a MacroTally backup', { kind: 'error' });
    return;
  }
  try {
    refreshExpenditure(state);
    save();
  } catch (err) {
    console.error(err);
  }
  nav.date = todayStr();
  toast('Backup restored');
  requestRender();
  if (!state.onboarded) openSetup();
});

on('import-pack', async (el) => {
  const file = el.files && el.files[0];
  if (!file) return;
  let text;
  try {
    text = await readFileText(file);
  } catch (err) {
    toast(err && err.message ? err.message : 'Could not read that file', { kind: 'error' });
    return;
  } finally {
    el.value = '';
  }
  try {
    const { name, count } = importPack(text);
    toast(`Imported ${name} (${plural(count, 'item')})`);
  } catch (err) {
    toast(err && err.message ? err.message : 'Not a MacroTally food pack', { kind: 'error' });
    return;
  }
  requestRender();
});

on('remove-pack', async (el) => {
  const id = el.dataset.id;
  const pk = listPacks().find((x) => x.id === id && !x.bundled);
  if (!pk) return;
  const ok = await confirmDialog(`Remove the "${pk.name}" food pack? Foods you already logged are kept.`, { okLabel: 'Remove', danger: true });
  if (!ok) return;
  removePack(id);
  toast(`Removed ${pk.name}`);
  requestRender();
});

on('toggle-pack', (el) => {
  setPackEnabled(el.dataset.id, el.checked);
  requestRender();
});

on('erase-all', async () => {
  const ok = await confirmDialog('Erase all data on this device? Export a backup first if you might want it later.', { okLabel: 'Erase everything', danger: true });
  if (!ok) return;
  resetAll();
  location.reload();
});

// ---------- Google Drive backup ----------

let driveBusy = false;

/** Run one Drive operation at a time; errors become toasts; always re-render afterwards. */
async function driveTask(fn) {
  if (driveBusy) return;
  driveBusy = true;
  try {
    await fn();
  } catch (err) {
    const msg = err && err.message ? err.message : 'Something went wrong';
    if ((err && err.cancelled) || /popup|cancel/i.test(msg)) toast('Sign-in was cancelled.');
    else toast(msg, { kind: 'error' });
  } finally {
    driveBusy = false;
    requestRender();
  }
}

async function restoreFlow(question) {
  toast('Checking Google Drive…');
  const backup = await fetchBackup({ interactive: true });
  const ok = await confirmDialog(question(backupDate(backup.modifiedTime), summaryText(backup.summary)), { okLabel: 'Replace', danger: true });
  if (!ok) return false;
  applyBackup(backup.text);
  toast('Backup restored');
  setTimeout(() => location.reload(), 400);
  return true;
}

on('drive-connect', (el) => driveTask(async () => {
  el.disabled = true;
  toast('Connecting to Google Drive…');
  const { existing } = await connectDrive();
  if (!existing) {
    toast('Backed up to Google Drive');
    return;
  }
  // This account already has a backup (e.g. from another phone): offer it before overwriting it.
  requestRender();
  const restored = await restoreFlow((when, summary) =>
    `Your Google Drive already has a MacroTally backup from ${when}. ${summary} Replace everything on this device with it?`);
  // Declined: nothing is overwritten now; the next backup (automatic or Back up now) replaces the Drive copy.
  if (!restored) toast("Kept this device's data. The next backup will replace the Drive copy.", { ms: 4000 });
}));

on('drive-backup', (el) => driveTask(async () => {
  el.disabled = true;
  toast('Backing up…');
  await backupNow({ interactive: true });
  toast('Backed up to Google Drive');
}));

on('drive-restore', (el) => driveTask(async () => {
  el.disabled = true;
  await restoreFlow((when, summary) => `Replace everything on this device with the Drive backup from ${when}? ${summary}`);
}));

on('drive-disconnect', () => driveTask(async () => {
  await disconnectDrive();
  toast('Disconnected from Google Drive');
}));

on('drive-auto', (el) => {
  state.drive.autoBackup = !!el.checked;
  save();
  requestRender();
});

// ---------- Weight feed ----------

on('save-feed', async (form) => {
  const raw = form.gistId.value.trim();
  const id = parseGistId(raw);
  if (raw && !id) {
    toast("That doesn't look like a gist id or gist address", { kind: 'error' });
    return;
  }
  const f = state.feed;
  if (id !== f.gistId) {
    // A new gist starts with a clean status; feed.imported stays so typed weigh-ins remain protected.
    Object.assign(f, { gistId: id, lastSync: null, lastCount: 0, lastError: null });
  }
  save();
  toast(id ? 'Weight feed saved' : 'Weight feed off');
  requestRender();
  if (!id) return;
  await syncWeightFeed({ force: true });
  requestRender();
});

on('feed-sync', async (el) => {
  el.disabled = true;
  const r = await syncWeightFeed({ force: true });
  if (r && r.added + r.updated === 0) toast('No new weigh-ins');
  else if (!r) toast(state.feed.lastError ? `Sync failed: ${state.feed.lastError}` : 'Could not sync right now (offline?)', { kind: 'error' });
  // r with changes: syncWeightFeed already showed "N weigh-ins from the scale".
  requestRender();
});
