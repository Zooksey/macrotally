// MacroTally — Settings view: profile, food sources, meals, install, backup, about.
import { state, save, todayStr, exportJSON, importJSON, resetAll } from '../store.js';
import { refreshExpenditure } from '../calc.js';
import { REGIONS } from '../foods.js';
import { esc, parseNum, on, toast, requestRender, confirmDialog } from '../ui.js';
import { nav } from '../app.js';
import { openSetup } from '../modals/setup.js';

const APP_VERSION = '1.0.0';

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
      <label class="field"><span>USDA FoodData Central API key (optional)</span>
        <input name="usdaKey" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(p.usdaKey)}" placeholder="Paste your free key">
      </label>
      <p class="hint">Adds generic foods (fruit, meat, rice…) to search results. Get a free key at <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener noreferrer">fdc.nal.usda.gov</a>.</p>
      <button type="submit" class="btn btn-primary btn-block">Save food sources</button>
    </form>

    <form class="card" data-submit="save-meals">
      <h2>Meals</h2>
      <label class="field"><span>Meal names, comma separated</span>
        <input name="meals" type="text" autocomplete="off" value="${esc((state.meals || []).join(', '))}">
      </label>
      <button type="submit" class="btn btn-primary btn-block">Save meals</button>
    </form>

    ${installCard()}

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
      <p class="small"><strong>Privacy:</strong> there is no server and no account. Everything you log stays on this device. Food searches go directly to Open Food Facts (and USDA if you add a key).</p>
      <p class="muted small">Version ${esc(APP_VERSION)} · Food data © Open Food Facts contributors (ODbL)</p>
    </section>`;
}

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

on('erase-all', async () => {
  const ok = await confirmDialog('Erase all data on this device? Export a backup first if you might want it later.', { okLabel: 'Erase everything', danger: true });
  if (!ok) return;
  resetAll();
  location.reload();
});
