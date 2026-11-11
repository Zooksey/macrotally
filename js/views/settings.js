// MacroTally — Settings view: the "How to use the app" help rows (js/modals/help.js), then grouped rows (You, Food,
// Sync, Data) that each open their own sheet (js/modals/settings.js), plus the About card. Nothing on this page is editable directly.
import { state } from '../store.js';
import { REGIONS } from '../foods.js';
import { esc, fmt, icon, on, toast, requestRender } from '../ui.js';
import { listPacks, packsLoaded } from '../packs.js';
import { driveConfigured, loadGIS } from '../drive.js';
import { aiConfigured, aiUrl } from '../ai.js';
import { brandPackInfo } from '../brandpack.js';
import { APP_VERSION, checkForUpdate, updateAvailable } from '../update.js';
import { openSetting, cmToFtIn, plural, relativeTime, isStandalone, ensurePacksLoaded } from '../modals/settings.js';
import { HELP_TOPICS } from '../modals/help.js'; // also registers the 'open-help' action

// Moved to js/modals/settings.js; re-exported so existing imports (setup wizard, tools) keep working.
export { ACTIVITY_LEVELS, activityOptions, cmToFtIn, heightFields, readHeightCm } from '../modals/settings.js';

function row(kind, title, sub) {
  return `
        <button type="button" class="row" data-action="open-setting" data-setting="${esc(kind)}">
          <div class="row-main">
            <div class="row-title">${esc(title)}</div>
            <div class="row-sub">${esc(sub)}</div>
          </div>
          <span class="chev">${icon('right')}</span>
        </button>`;
}

/** A help row: opens that topic's sheet (js/modals/help.js). */
function helpRow(t) {
  return `
        <button type="button" class="row" data-action="open-help" data-topic="${esc(t.id)}">
          <div class="row-main">
            <div class="row-title">${esc(t.title)}</div>
            <div class="row-sub">${esc(t.sub)}</div>
          </div>
          <span class="chev">${icon('right')}</span>
        </button>`;
}

function group(title, rows) {
  return `
    <section class="card">
      <h2>${esc(title)}</h2>
      <div class="list">${rows.join('')}
      </div>
    </section>`;
}

function profileSub() {
  const p = state.profile;
  const units = p.units === 'metric' ? 'metric' : 'imperial';
  const parts = [];
  if (p.name) parts.push(p.name);
  parts.push(p.sex === 'female' ? 'Female' : 'Male');
  if (p.birthYear) parts.push(`born ${p.birthYear}`);
  if (Number(p.heightCm) > 0) {
    if (units === 'imperial') {
      const { ft, inch } = cmToFtIn(p.heightCm);
      parts.push(`${ft} ft ${inch} in`);
    } else {
      parts.push(`${Math.round(p.heightCm)} cm`);
    }
  }
  parts.push(units === 'metric' ? 'Metric' : 'Imperial');
  return parts.join(' · ');
}

function sourcesSub() {
  const p = state.profile;
  const region = REGIONS.find((r) => r.code === (p.region || 'world'));
  return `Region: ${region ? region.label : p.region || 'world'} · ${p.usdaKey ? 'own' : 'shared'} USDA key`;
}

function packsSub() {
  ensurePacksLoaded();
  const packs = listPacks();
  if (!packs.length) return packsLoaded() ? 'No food packs yet' : 'Loading…';
  return `${fmt(packs.filter((pk) => pk.enabled).length)} of ${fmt(packs.length)} on`;
}

function brandsSub() {
  if (!aiConfigured(state)) return 'Needs the AI helper';
  const n = Object.keys(state.brands || {}).length;
  const info = brandPackInfo();
  return `${plural(n, 'brand')} · ${info ? plural(info.count, 'product') : 'no pack yet'}`;
}

function driveSub() {
  if (!driveConfigured()) return 'Not set up';
  // Warm up Google sign-in so the popup can open straight from the button tap in the sheet.
  loadGIS().catch(() => {});
  const d = state.drive;
  if (!d.connected) return 'Not connected';
  const last = d.lastBackupAt ? `last backup ${relativeTime(d.lastBackupAt)}` : 'no backup from this device yet';
  return `Connected as ${d.email || 'your Google account'} · ${last}${d.lastError ? ' · error' : ''}`;
}

function feedSub() {
  const f = state.feed;
  if (!f.gistId) return 'Off';
  if (f.lastError) return 'Sync failed';
  if (f.lastSync) return `Last sync ${relativeTime(f.lastSync)} · ${plural(f.lastCount || 0, 'weigh-in')}`;
  return 'Not synced yet';
}

function aiSub() {
  const a = state.ai;
  if (!aiConfigured(state)) return 'Not set up';
  if (a.lastError) return 'On · last error';
  if (a.lastOk) return `On · last answer ${relativeTime(a.lastOk)}`;
  return 'On · no answers yet';
}

/**
 * Settings tab.
 * @returns {string} HTML
 */
export function settingsView() {
  const dataRows = [row('backup', 'Backup', 'Export, import or erase')];
  if (!isStandalone()) dataRows.push(row('install', 'Install', 'Add MacroTally to your home screen'));
  return `
    <header class="topbar"><h1>Settings</h1></header>
    ${group('How to use the app', HELP_TOPICS.map((t) => helpRow(t)))}
    ${group('You', [
      row('profile', 'Profile', profileSub()),
      row('meals', 'Meals', (state.meals || []).join(', '))
    ])}
    ${group('Food', [
      row('sources', 'Food sources', sourcesSub()),
      row('packs', 'Food packs', packsSub()),
      row('brands', 'Brands you use', brandsSub())
    ])}
    ${group('Sync', [
      row('drive', 'Google Drive backup', driveSub()),
      row('feed', 'Weight feed', feedSub()),
      row('ai', 'AI helper', aiSub())
    ])}
    ${group('Data', dataRows)}

    <section class="card about">
      <h2>About</h2>
      <p class="small">MacroTally is a free, open macro tracker: barcode scanning, trend weight and an adaptive expenditure estimate.</p>
      <p class="small"><strong>Privacy:</strong> there is no account. Everything you log stays on this device${driveConfigured() ? ' (plus your own Google Drive if you connect it)' : ''}. Food searches go to Open Food Facts through the search relay of the AI helper at ${esc(aiUrl(state).replace(/^https?:\/\//, ''))} (directly to Open Food Facts when it can't be reached) and to USDA FoodData Central; only the words you search for are sent.${aiConfigured(state) ? ' AI add sends what you type and photograph to your own AI helper, which passes it to Claude. Brand names you log are sent to your own helper so it can bundle their products.' : ''}</p>
      <p class="muted small">Version ${esc(APP_VERSION)} · Food data © Open Food Facts contributors (ODbL) and USDA FoodData Central</p>
      ${updateAvailable()
        ? '<button type="button" class="btn btn-primary btn-block" data-action="app-update">Reload to update</button>'
        : '<button type="button" class="btn btn-ghost btn-block" data-action="check-update">Check for updates</button>'}
      <p class="hint">Updates install on their own when you open the app; closing it fully and reopening is enough. You never need to re-add it to your home screen.</p>
    </section>`;
}

on('open-setting', (el) => openSetting(el.dataset.setting));

on('check-update', async (el) => {
  el.disabled = true;
  toast('Checking…');
  const result = await checkForUpdate();
  if (result === 'ready') toast('A new version is ready. Reload to update.');
  else if (result === 'current') toast(`You're on the latest version (${APP_VERSION}).`);
  else toast('Updates are handled by your browser here.');
  requestRender();
});
