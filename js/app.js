// MacroTally — bootstrap, tab router, render loop.
import { state, save, todayStr } from './store.js';
import { refreshExpenditure } from './calc.js';
import { bindGlobalEvents, on, requestRender, icon, esc } from './ui.js';
import { diaryView } from './views/diary.js';
import { weightView } from './views/weight.js';
import { planView } from './views/plan.js';
import { settingsView } from './views/settings.js';
import { openSetup } from './modals/setup.js';
import './modals/food.js';

/**
 * Current navigation state (live object; views read it, handlers mutate it then requestRender()).
 * @type {{tab: 'diary'|'weight'|'plan'|'settings', date: string}}
 */
export const nav = { tab: 'diary', date: todayStr() };

const views = {
  diary: diaryView,
  weight: weightView,
  plan: planView,
  settings: settingsView
};

const TABS = [
  { id: 'diary', label: 'Diary' },
  { id: 'weight', label: 'Weight' },
  { id: 'plan', label: 'Plan' },
  { id: 'settings', label: 'Settings' }
];

let lastToday = todayStr();

function renderTabbar() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  if (!bar.dataset.built) {
    bar.innerHTML = TABS.map((t) => `
      <button type="button" class="tab" data-action="tab" data-tab="${t.id}" aria-label="${esc(t.label)}">
        ${icon(t.id)}<span>${esc(t.label)}</span>
      </button>`).join('');
    bar.dataset.built = '1';
  }
  bar.querySelectorAll('.tab').forEach((b) => {
    const active = b.dataset.tab === nav.tab;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

/** Render the current tab into #app and refresh the tab bar. */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const view = views[nav.tab] || views.diary;
  try {
    app.innerHTML = view();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(err && err.message)}</p></div>`;
  }
  renderTabbar();
}

on('tab', (el) => {
  const tab = el.dataset.tab;
  if (!views[tab]) return;
  const changed = tab !== nav.tab;
  nav.tab = tab;
  render();
  if (changed) window.scrollTo(0, 0);
});

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  const today = todayStr();
  if (today === lastToday) return;
  if (nav.date === lastToday) nav.date = today;
  lastToday = today;
  try {
    if (refreshExpenditure(state)) save();
  } catch (err) {
    console.error(err);
  }
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const reg = () => {
    try {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    } catch (err) {
      // Ignore (e.g. insecure context or file://).
    }
  };
  if (document.readyState === 'complete') reg();
  else window.addEventListener('load', reg);
}

function start() {
  try {
    refreshExpenditure(state);
    save();
  } catch (err) {
    console.error(err);
  }
  bindGlobalEvents();
  document.addEventListener('render', render);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.__installPrompt = e;
    requestRender();
  });
  window.addEventListener('appinstalled', () => {
    window.__installPrompt = null;
    requestRender();
  });
  registerServiceWorker();
  render();
  if (!state.onboarded) openSetup();
}

start();
