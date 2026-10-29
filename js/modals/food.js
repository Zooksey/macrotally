// MacroTally — food modals: add-food search, food detail/amount, custom food editor, barcode scanner.
import { state, uid, saveFood, deleteFood, addEntry, updateEntry, removeEntry, toggleFavorite } from '../store.js';
import {
  searchFoods, lookupBarcode, effectiveUsdaKey, searchLocal, rankFoods,
  nutrientsFor, unitOptions, buildEntry, makeCustomFood
} from '../foods.js';
import { builtinFoods, loadBuiltinFoods } from '../builtin.js';
import { packFoods, loadPacks } from '../packs.js';
import { startScanner, scannerSupported } from '../scanner.js';
import {
  esc, fmt, fmtQty, parseNum, icon, on, openModal, closeModal, closeAllModals,
  toast, requestRender, confirmDialog
} from '../ui.js';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Foods shown in result lists that may not be in the library yet (API results). */
const foodCache = new Map();

/** Remembered library tab in the add-food sheet. */
let libTab = 'recent';

/** Search bookkeeping: request counter (stale-response guard) and debounce timer. */
let searchSeq = 0;
let searchTimer = null;

function ctxOf(el) {
  const bd = el && el.closest('.modal-backdrop');
  return bd ? bd._ctx : null;
}

function backdropOf(el) {
  return el ? el.closest('.modal-backdrop') : null;
}

function findFood(id) {
  return foodCache.get(id) || state.foods[id] || null;
}

function isFavorite(id) {
  return (state.favorites || []).includes(id);
}

function servingHint(food) {
  if (food.servingOnly) return '';
  const s = food.servings && food.servings[0];
  return s ? ` · ${esc(s.label)}` : '';
}

/** Serving label of a servingOnly food ("1 burrito"), or '' for normal foods. */
function servingOnlyLabel(food) {
  if (!food || !food.servingOnly) return '';
  const s = food.servings && food.servings[0];
  return (s && String(s.label || '').trim()) || '1 serving';
}

/** Calories line for a result row: "390 kcal / burrito" (servingOnly) or "120 kcal / 100 g". */
function kcalText(food) {
  const per = food.per100 || {};
  const label = servingOnlyLabel(food);
  if (!label) return `${fmt(per.cal)} kcal / 100 g`;
  return `${fmt(per.cal)} kcal / ${esc(label.replace(/^1\s+/, ''))}`;
}

/** Small source badge for library rows. */
function sourceBadge(food) {
  if (food.source === 'custom') return '<span class="badge">Custom</span>';
  if (food.source === 'usda' || food.source === 'builtin') return '<span class="badge">USDA</span>';
  if (food.source === 'pack') return `<span class="badge">${esc(food.brand || 'Menu')}</span>`;
  return '';
}

/**
 * A tappable food row. Without `tag` (library tabs) it shows the Custom/USDA badge and a favorite star;
 * with a tag string (search results) it shows just that small tag ('' → none).
 */
function foodRow(food, tag) {
  foodCache.set(food.id, food);
  let marks;
  if (tag === undefined) {
    marks = `${sourceBadge(food)}${isFavorite(food.id) ? `<span class="fav-mark" aria-label="Favorite">${icon('star', 'icon-sm')}</span>` : ''}`;
  } else if (tag === '★') {
    marks = `<span class="tag tag-fav" aria-label="Favorite" title="Favorite">${esc(tag)}</span>`;
  } else {
    marks = tag ? `<span class="tag">${esc(tag)}</span>` : '';
  }
  return `
    <button type="button" class="row" data-action="pick-food" data-id="${esc(food.id)}">
      <div class="row-main">
        <div class="row-title">${esc(food.name || 'Unnamed food')} ${marks}</div>
        <div class="row-sub">${food.brand ? `${esc(food.brand)} · ` : ''}${kcalText(food)}${servingHint(food)}</div>
      </div>
      <span class="chev">${icon('right')}</span>
    </button>`;
}

function listOrEmpty(foods, emptyText) {
  if (!foods.length) return `<p class="empty muted small">${esc(emptyText)}</p>`;
  return `<div class="list">${foods.map((f) => foodRow(f)).join('')}</div>`;
}

function normBarcode(code) {
  return String(code || '').replace(/\D/g, '').replace(/^0+/, '');
}

function localByBarcode(code) {
  const n = normBarcode(code);
  if (!n) return null;
  return Object.values(state.foods || {}).find((f) => f && f.barcode && normBarcode(f.barcode) === n) || null;
}

const isBarcodeQuery = (q) => /^\d{8,14}$/.test(q);

/** Ranking boosts from the user's library, favorites and recents. */
function rankOpts() {
  return {
    localIds: new Set(Object.keys(state.foods || {})),
    favoriteIds: new Set(state.favorites || []),
    recentIds: new Set(state.recents || [])
  };
}

/** Instant, offline results: library + built-in list + food packs (or a library barcode match for a typed barcode). */
function localResults(q) {
  if (isBarcodeQuery(q)) {
    const f = localByBarcode(q);
    return f ? [f] : [];
  }
  return searchLocal(q, {
    library: state.foods,
    builtin: [...builtinFoods(), ...packFoods()],
    recents: state.recents,
    favorites: state.favorites,
    limit: 25
  });
}

/**
 * Search result tag: ★ (favorite) or "library" for library foods, "USDA" for built-in and live USDA,
 * "menu" for food-pack items (their brand is already in the row), none for Open Food Facts.
 */
function resultTag(food) {
  if (state.foods && state.foods[food.id]) return isFavorite(food.id) ? '★' : 'library';
  if (food.source === 'pack') return 'menu';
  return food.source === 'builtin' || food.source === 'usda' ? 'USDA' : '';
}

/* ------------------------------------------------------------------ */
/* Add food                                                            */
/* ------------------------------------------------------------------ */

function libraryHtml() {
  let foods;
  let empty;
  if (libTab === 'favorites') {
    foods = (state.favorites || []).map((id) => state.foods[id]).filter(Boolean);
    empty = 'No favorites yet. Tap the star on a food to keep it here.';
  } else if (libTab === 'custom') {
    foods = Object.values(state.foods || {}).filter((f) => f && f.source === 'custom')
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    empty = 'No custom foods yet.';
  } else {
    foods = (state.recents || []).map((id) => state.foods[id]).filter(Boolean);
    empty = 'Foods you log will show up here.';
  }
  const tab = (id, label) => `<button type="button" class="seg${libTab === id ? ' active' : ''}" data-action="lib-tab" data-tab="${id}" aria-pressed="${libTab === id}">${esc(label)}</button>`;
  return `
    <div class="segmented">${tab('recent', 'Recent')}${tab('favorites', 'Favorites')}${tab('custom', 'My foods')}</div>
    ${listOrEmpty(foods, empty)}`;
}

/**
 * Open the add-food sheet (search, scan, library tabs, create custom).
 * @param {string} meal Meal name the food will be logged to.
 * @param {string} date 'YYYY-MM-DD'
 * @returns {HTMLElement} backdrop
 */
export function openAddFood(meal, date) {
  foodCache.clear();
  const canScan = scannerSupported();
  const html = `
    <div class="sheet-head">
      <h2>Add to ${esc(meal)}</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>
    </div>
    <form class="search-form" data-submit="food-search-submit" role="search">
      <span class="search-icon">${icon('search')}</span>
      <input class="search-input" name="q" type="search" placeholder="Search foods" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" autofocus data-input="food-search" aria-label="Search foods">
    </form>
    <button type="button" class="btn btn-primary btn-block btn-scan" data-action="open-scanner"${canScan ? '' : ' disabled'}>${icon('barcode')} Scan barcode</button>
    ${canScan ? '' : '<p class="hint center">Camera scanning needs a secure (https) connection and a camera.</p>'}
    <div class="search-results" hidden></div>
    <div class="library">${libraryHtml()}</div>
    <button type="button" class="btn btn-ghost btn-block" data-action="create-custom">${icon('plus')} Create custom food</button>`;
  const bd = openModal(html, {
    cls: 'add-food',
    onClose: () => {
      clearTimeout(searchTimer);
      searchSeq++;
    }
  });
  bd._ctx = { meal, date };
  const input = bd.querySelector('.search-input');
  if (input) setTimeout(() => input.focus(), 60);
  return bd;
}

/**
 * Render the combined result list for the sheet's current search state (`sheet._search`):
 * local results (recomputed, so they are instant and include the built-in list once loaded),
 * merged and re-ranked with network results when those have arrived, plus a status line
 * ("Searching…" or the error) under the list rather than in place of it.
 */
function renderSearch(sheet) {
  const box = sheet.querySelector('.search-results');
  const lib = sheet.querySelector('.library');
  const st = sheet._search;
  if (!box || !st) return;
  const local = localResults(st.q);
  const foods = st.api ? rankFoods(st.q, [...local, ...st.api], { ...rankOpts(), limit: 40 }) : local;
  let html = '';
  if (foods.length) {
    html += `<h3 class="list-head">Results</h3><div class="list">${foods.map((f) => foodRow(f, resultTag(f))).join('')}</div>`;
  }
  if (st.loading) {
    html += '<div class="searching"><span class="spinner" aria-hidden="true"></span> Searching…</div>';
  } else if (st.error) {
    html += foods.length
      ? `<p class="search-note muted small">${esc(st.error)}</p>`
      : `<p class="inline-error">${esc(st.error)}</p>`;
  } else if (st.api && !foods.length) {
    html += '<p class="empty muted small">No matches. Try fewer words, or create a custom food.</p>';
  }
  box.innerHTML = html;
  box.hidden = false;
  if (lib) lib.hidden = true;
}

function hideResults(sheet) {
  const box = sheet.querySelector('.search-results');
  const lib = sheet.querySelector('.library');
  sheet._search = null;
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  if (lib) lib.hidden = false;
}

async function runSearch(sheet, q, seq) {
  const usdaKey = effectiveUsdaKey(state.profile);
  let api = null;
  let error = '';
  try {
    if (isBarcodeQuery(q)) {
      // A typed barcode: the product endpoint (with the USDA Branded fallback) beats text search.
      const found = localByBarcode(q) || await lookupBarcode(q, { usdaKey });
      api = found ? [found] : [];
    } else {
      api = await searchFoods(q, { usdaKey, region: state.profile.region || 'world' });
    }
  } catch (err) {
    error = (err && err.message) || 'Search failed. Try again.';
  }
  if (seq !== searchSeq || !sheet.isConnected || !sheet._search) return;
  sheet._search = { q, seq, api: api || [], loading: false, error };
  renderSearch(sheet);
}

let localTimer = null;
function queueSearch(el, immediate) {
  const sheet = el.closest('.modal');
  if (!sheet) return;
  const input = sheet.querySelector('.search-input');
  const q = (input ? input.value : '').trim();
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if (q.length < 2) {
    hideResults(sheet);
    return;
  }
  // Local results render after a short pause in typing (scoring ~17k built-in and pack foods costs tens of
  // milliseconds on a phone); the network search waits for the longer debounce.
  sheet._search = { q, seq, api: null, loading: true, error: '' };
  clearTimeout(localTimer);
  if (immediate) renderSearch(sheet);
  else localTimer = setTimeout(() => { if (seq === searchSeq && sheet.isConnected && sheet._search) renderSearch(sheet); }, 120);
  if (!builtinFoods().length) {
    loadBuiltinFoods().then((list) => {
      if (list.length && seq === searchSeq && sheet.isConnected && sheet._search) renderSearch(sheet);
    });
  }
  const packCount = packFoods().length;
  loadPacks().then((list) => {
    if (list.length !== packCount && seq === searchSeq && sheet.isConnected && sheet._search) renderSearch(sheet);
  });
  const go = () => runSearch(sheet, q, seq);
  if (immediate) go();
  else searchTimer = setTimeout(go, 650); // Open Food Facts allows ~10 searches/min, so wait for typing to settle
}

on('food-search', (el) => queueSearch(el, false));

on('food-search-submit', (form) => {
  const input = form.querySelector('.search-input');
  if (input) input.blur();
  queueSearch(form, true);
});

on('lib-tab', (el) => {
  libTab = el.dataset.tab || 'recent';
  const lib = el.closest('.library');
  if (lib) lib.innerHTML = libraryHtml();
});

on('pick-food', (el) => {
  const ctx = ctxOf(el);
  const food = findFood(el.dataset.id);
  if (!ctx || !food) return;
  openFoodDetail(food, { meal: ctx.meal, date: ctx.date });
});

on('open-scanner', (el) => {
  const ctx = ctxOf(el);
  if (ctx) openScanner({ meal: ctx.meal, date: ctx.date });
});

on('create-custom', (el) => {
  const ctx = ctxOf(el);
  const input = el.closest('.modal') && el.closest('.modal').querySelector('.search-input');
  const q = input ? input.value.trim() : '';
  openCustomFood({ meal: ctx && ctx.meal, date: ctx && ctx.date, name: q });
});

/* ------------------------------------------------------------------ */
/* Food detail                                                         */
/* ------------------------------------------------------------------ */

function sameUnit(a, b) {
  return a && b && a.label === b.label && Math.abs(Number(a.grams) - Number(b.grams)) < 0.01;
}

function qtyDigits(unit) {
  if (unit.label === 'g') return 0;
  if (unit.label === 'oz') return 1;
  return 2;
}

function previewHtml(food, grams) {
  const n = nutrientsFor(food, grams);
  const gramsText = food.servingOnly ? '' : ` <span class="muted small">· ${fmt(grams)} g</span>`;
  return `
    <div class="preview-cal"><span class="big-num">${fmt(n.cal)}</span> <span class="muted">kcal</span>${gramsText}</div>
    <div class="preview-macros">
      <div class="pm"><span class="pm-val" style="color:var(--p)">${fmt(n.p, 1)}</span><span class="muted small">Protein</span></div>
      <div class="pm"><span class="pm-val" style="color:var(--c)">${fmt(n.c, 1)}</span><span class="muted small">Carbs</span></div>
      <div class="pm"><span class="pm-val" style="color:var(--f)">${fmt(n.f, 1)}</span><span class="muted small">Fat</span></div>
      <div class="pm"><span class="pm-val">${fmt(n.fiber, 1)}</span><span class="muted small">Fiber</span></div>
    </div>`;
}

function favButton(food) {
  const fav = isFavorite(food.id);
  return `<button type="button" class="icon-btn fav-btn${fav ? ' active' : ''}" data-action="detail-fav" aria-pressed="${fav}" aria-label="${fav ? 'Remove from favorites' : 'Add to favorites'}">${icon('star')}</button>`;
}

/**
 * Open the food detail / amount sheet.
 * @param {object} food Food (per-100 g nutrients).
 * @param {{meal: string, date: string, entry?: object|null}} opts entry → edit mode.
 * @returns {HTMLElement} backdrop
 */
export function openFoodDetail(food, { meal, date, entry = null }) {
  const units = unitOptions(food).slice();
  let unitIdx;
  let qty;
  if (entry) {
    unitIdx = units.findIndex((u) => sameUnit(u, entry.unit));
    if (unitIdx < 0) {
      units.unshift({ label: entry.unit.label, grams: entry.unit.grams });
      unitIdx = 0;
    }
    qty = entry.qty;
  } else {
    const s = food.servings && food.servings[0];
    const dg = Number(food.defaultGrams) || 100;
    if (s && Math.abs(s.grams - dg) < 0.01) {
      unitIdx = 0;
      qty = 1;
    } else {
      unitIdx = Math.max(0, units.findIndex((u) => u.label === 'g'));
      qty = Math.round(dg);
    }
  }
  const meals = state.meals && state.meals.length ? state.meals.slice() : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const curMeal = meal || meals[0];
  if (!meals.includes(curMeal)) meals.push(curMeal);
  const per = food.per100 || {};
  const grams = qty * units[unitIdx].grams;
  const editing = !!entry;
  const html = `
    <div class="sheet-head">
      <div class="sheet-title">
        <h2>${esc(food.name || 'Food')}</h2>
        ${food.brand ? `<div class="muted small">${esc(food.brand)}</div>` : ''}
      </div>
      <div class="head-actions">
        ${food._snapshot ? '' : favButton(food)}
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>
      </div>
    </div>
    <form class="detail-form" data-submit="detail-save">
      <div class="detail-preview">${previewHtml(food, grams)}</div>
      <div class="field-row qty-row">
        <label class="field"><span>Amount</span>
          <input name="qty" type="text" inputmode="decimal" autocomplete="off" value="${esc(fmtQty(qty))}" data-input="detail-preview">
        </label>
        <label class="field grow"><span>Unit</span>
          <select name="unit" data-change="detail-unit">
            ${units.map((u, i) => `<option value="${i}"${i === unitIdx ? ' selected' : ''}>${esc(u.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="field"><span>Meal</span>
        <select name="meal" data-change="detail-meal">
          ${meals.map((m) => `<option value="${esc(m)}"${m === curMeal ? ' selected' : ''}>${esc(m)}</option>`).join('')}
        </select>
      </label>
      <p class="muted small per100">Per ${esc(servingOnlyLabel(food) || '100 g')}: ${fmt(per.cal)} kcal · P ${fmt(per.p, 1)} · C ${fmt(per.c, 1)} · F ${fmt(per.f, 1)}${per.fiber ? ` · Fiber ${fmt(per.fiber, 1)}` : ''}</p>
      ${food.source === 'custom' && !food._snapshot ? `<button type="button" class="link-btn" data-action="detail-edit-food">${icon('edit', 'icon-sm')} Edit food</button>` : ''}
      ${food.barcode ? `<p class="muted small">Barcode ${esc(food.barcode)}</p>` : ''}
      <div class="btn-row">
        ${editing ? '<button type="button" class="btn btn-danger" data-action="detail-delete">Delete</button>' : ''}
        <button type="submit" class="btn btn-primary grow submit-btn">${editing ? 'Save changes' : `Add to ${esc(curMeal)}`}</button>
      </div>
    </form>`;
  const bd = openModal(html, { cls: 'food-detail' });
  bd._ctx = { food, meal: curMeal, date, entry, units, unitIdx };
  return bd;
}

function refreshPreview(form, ctx) {
  const qty = parseNum(form.qty.value);
  const unit = ctx.units[Number(form.unit.value)] || ctx.units[0];
  const grams = qty > 0 ? qty * unit.grams : 0;
  const box = form.querySelector('.detail-preview');
  if (box) box.innerHTML = previewHtml(ctx.food, grams);
}

on('detail-preview', (el) => {
  const ctx = ctxOf(el);
  if (ctx && el.form) refreshPreview(el.form, ctx);
});

on('detail-unit', (el) => {
  const ctx = ctxOf(el);
  const form = el.form;
  if (!ctx || !form) return;
  const prev = ctx.units[ctx.unitIdx];
  const next = ctx.units[Number(el.value)];
  const qty = parseNum(form.qty.value);
  if (prev && next && qty > 0) {
    // Keep the same amount of food when switching units.
    const grams = qty * prev.grams;
    const k = 10 ** qtyDigits(next);
    const nq = Math.round((grams / next.grams) * k) / k;
    form.qty.value = fmtQty(nq > 0 ? nq : 1);
  }
  ctx.unitIdx = Number(el.value);
  refreshPreview(form, ctx);
});

on('detail-meal', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  ctx.meal = el.value;
  const btn = el.form && el.form.querySelector('.submit-btn');
  if (btn && !ctx.entry) btn.textContent = `Add to ${el.value}`;
});

on('detail-fav', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  if (!state.foods[ctx.food.id]) saveFood(ctx.food);
  const fav = toggleFavorite(ctx.food.id);
  el.classList.toggle('active', fav);
  el.setAttribute('aria-pressed', String(fav));
  el.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Add to favorites');
  toast(fav ? 'Added to favorites' : 'Removed from favorites');
});

on('detail-save', (form) => {
  const ctx = ctxOf(form);
  if (!ctx) return;
  const qty = parseNum(form.qty.value);
  if (!(qty > 0)) {
    toast('Enter an amount', { kind: 'error' });
    form.qty.focus();
    return;
  }
  const unit = ctx.units[Number(form.unit.value)] || ctx.units[0];
  const meal = form.meal.value || ctx.meal;
  const { food, date, entry } = ctx;
  if (entry) {
    // servingOnly: undefined clears a stale flag when the food has since gained a gram weight.
    updateEntry(date, entry.id, { servingOnly: undefined, ...buildEntry(food, qty, unit), meal });
    closeAllModals();
    toast('Saved');
  } else {
    saveFood(food);
    addEntry(date, { ...buildEntry(food, qty, unit), id: uid(), meal });
    closeAllModals();
    toast(`Added to ${meal}`);
  }
  requestRender();
});

on('detail-delete', (el) => {
  const ctx = ctxOf(el);
  if (!ctx || !ctx.entry) return;
  removeEntry(ctx.date, ctx.entry.id);
  closeAllModals();
  toast('Deleted');
  requestRender();
});

on('detail-edit-food', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  openCustomFood({ food: ctx.food, meal: ctx.meal, date: ctx.date, entry: ctx.entry, replace: backdropOf(el) });
});

/* ------------------------------------------------------------------ */
/* Custom food                                                         */
/* ------------------------------------------------------------------ */

function num1(v) {
  return Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '';
}

/**
 * Open the custom food editor.
 * @param {{barcode?: string|null, food?: object|null, meal: string, date: string, entry?: object|null, name?: string, replace?: HTMLElement|null}} opts
 *   food → edit an existing custom food (keeps its id). entry/replace are internal: when editing from a detail sheet,
 *   that sheet is replaced and the entry stays in edit mode.
 * @returns {HTMLElement} backdrop
 */
export function openCustomFood({ barcode = null, food = null, meal, date, entry = null, name = '', replace = null } = {}) {
  const s = food && food.servings && food.servings[0];
  // servingOnly foods: per100 already holds one serving of unknown weight, so grams stay blank.
  const servingOnly = !!(food && food.servingOnly);
  // New foods default to "per serving" (how labels are printed); existing ones without a serving are per 100 g.
  const per = !food || s ? 'serving' : '100g';
  const factor = s && !servingOnly ? s.grams / 100 : 1;
  const p100 = (food && food.per100) || {};
  const val = (k) => (food ? num1((p100[k] || 0) * factor) : '');
  const servingLabel = s ? String(s.label).replace(/\s*\([\d.,]+\s*g\)\s*$/i, '') : '1 serving';
  const html = `
    <div class="sheet-head">
      <h2>${food ? 'Edit food' : 'Custom food'}</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>
    </div>
    <form class="custom-form" data-submit="custom-save">
      <label class="field"><span>Name</span><input name="foodName" type="text" autocomplete="off" required value="${esc(food ? food.name : name)}"></label>
      <div class="field-row">
        <label class="field"><span>Brand</span><input name="brand" type="text" autocomplete="off" value="${esc(food ? food.brand : '')}" placeholder="optional"></label>
        <label class="field"><span>Barcode</span><input name="barcode" type="text" inputmode="numeric" autocomplete="off" value="${esc((food && food.barcode) || barcode || '')}" placeholder="optional"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Serving label</span><input name="servingLabel" type="text" autocomplete="off" value="${esc(servingLabel)}"></label>
        <label class="field"><span>Serving size (g)</span><input name="servingGrams" type="text" inputmode="decimal" autocomplete="off" value="${esc(s && !servingOnly ? num1(s.grams) : '')}" placeholder="optional"></label>
      </div>
      <p class="hint">Serving size (g): leave blank if unknown; amounts are then logged in servings.</p>
      <div class="field"><span>Nutrition is per</span>
        <div class="segmented radio-seg">
          <label class="seg"><input type="radio" name="per" value="serving"${per === 'serving' ? ' checked' : ''}><span>Serving</span></label>
          <label class="seg"><input type="radio" name="per" value="100g"${per === '100g' ? ' checked' : ''}><span>100 g</span></label>
        </div>
      </div>
      <div class="field-row">
        <label class="field"><span>Calories (kcal)</span><input name="cal" type="text" inputmode="decimal" autocomplete="off" required value="${esc(val('cal'))}"></label>
        <label class="field"><span>Protein (g)</span><input name="p" type="text" inputmode="decimal" autocomplete="off" value="${esc(val('p'))}"></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Carbs (g)</span><input name="c" type="text" inputmode="decimal" autocomplete="off" value="${esc(val('c'))}"></label>
        <label class="field"><span>Fat (g)</span><input name="f" type="text" inputmode="decimal" autocomplete="off" value="${esc(val('f'))}"></label>
      </div>
      <label class="field"><span>Fiber (g)</span><input name="fiber" type="text" inputmode="decimal" autocomplete="off" value="${esc(val('fiber'))}"></label>
      <div class="btn-row">
        ${food ? '<button type="button" class="btn btn-danger" data-action="custom-delete">Delete food</button>' : ''}
        <button type="submit" class="btn btn-primary grow">Save food</button>
      </div>
    </form>`;
  const bd = openModal(html, { cls: 'custom-food' });
  bd._ctx = { food, meal, date, entry, replace };
  return bd;
}

on('custom-save', (form) => {
  const ctx = ctxOf(form);
  if (!ctx) return;
  const name = form.foodName.value.trim();
  if (!name) {
    toast('Give the food a name', { kind: 'error' });
    return;
  }
  const perEl = form.querySelector('input[name="per"]:checked');
  const per = perEl && perEl.value === '100g' ? '100g' : 'serving';
  const gramsBlank = form.servingGrams.value.trim() === '';
  const servingGrams = gramsBlank ? null : parseNum(form.servingGrams.value);
  if (!gramsBlank && !(servingGrams > 0)) {
    toast('Serving size must be a positive number', { kind: 'error' });
    return;
  }
  const cal = parseNum(form.cal.value);
  if (!(cal >= 0)) {
    toast('Enter the calories', { kind: 'error' });
    form.cal.focus();
    return;
  }
  const optNum = (input) => {
    const v = parseNum(input.value);
    return v >= 0 ? v : 0;
  };
  const barcode = form.barcode.value.replace(/\D/g, '');
  const food = makeCustomFood({
    id: ctx.food ? ctx.food.id : null,
    name,
    brand: form.brand.value.trim(),
    barcode: barcode || null,
    per,
    servingGrams: servingGrams > 0 ? servingGrams : null,
    servingLabel: form.servingLabel.value.trim() || '1 serving',
    cal,
    p: optNum(form.p),
    c: optNum(form.c),
    f: optNum(form.f),
    fiber: optNum(form.fiber)
  });
  saveFood(food);
  closeModal(backdropOf(form));
  if (ctx.replace) closeModal(ctx.replace);
  toast(ctx.food ? 'Food updated' : 'Food saved');
  openFoodDetail(food, { meal: ctx.meal, date: ctx.date, entry: ctx.entry });
});

on('custom-delete', async (el) => {
  const ctx = ctxOf(el);
  if (!ctx || !ctx.food) return;
  const ok = await confirmDialog(`Delete "${ctx.food.name}" from your foods? Logged entries are kept.`, { okLabel: 'Delete', danger: true });
  if (!ok) return;
  deleteFood(ctx.food.id);
  foodCache.delete(ctx.food.id);
  closeAllModals();
  toast('Food deleted');
  requestRender();
});

/* ------------------------------------------------------------------ */
/* Scanner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Open the barcode scanner sheet. The camera is released when the sheet closes.
 * @param {{meal: string, date: string}} opts
 * @returns {HTMLElement} backdrop
 */
export function openScanner({ meal, date }) {
  const html = `
    <div class="sheet-head">
      <h2>Scan barcode</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="scanner">
      <video playsinline muted autoplay></video>
      <div class="scan-frame" aria-hidden="true"></div>
    </div>
    <p class="scan-status" role="status" aria-live="polite"></p>
    <button type="button" class="btn btn-ghost btn-block scan-again" data-action="scan-restart" hidden>Scan again</button>
    <form class="inline-form scan-manual" data-submit="scan-manual">
      <input name="code" type="text" inputmode="numeric" autocomplete="off" placeholder="Or type the barcode" aria-label="Barcode number">
      <button type="submit" class="btn btn-primary">Look up</button>
    </form>
    <button type="button" class="btn btn-ghost btn-block" data-action="close-modal">Cancel</button>`;

  const ctx = { meal, date, stop: null, closed: false, busy: false, generation: 0 };
  const bd = openModal(html, {
    cls: 'scanner-sheet',
    onClose: () => {
      ctx.closed = true;
      ctx.stopCamera();
    }
  });
  bd._ctx = ctx;
  const video = bd.querySelector('video');
  const statusEl = bd.querySelector('.scan-status');
  const againBtn = bd.querySelector('.scan-again');
  video.muted = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');

  ctx.setStatus = (text, isError = false) => {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('inline-error', !!isError);
  };

  ctx.stopCamera = () => {
    ctx.generation++;
    const fn = ctx.stop;
    ctx.stop = null;
    if (fn) {
      try {
        fn();
      } catch (err) {
        console.warn(err);
      }
    }
  };

  ctx.startCamera = () => {
    againBtn.hidden = true;
    if (!scannerSupported()) {
      bd.classList.add('no-camera');
      ctx.setStatus('Camera scanning isn’t available here (it needs https and a camera). Type the barcode below instead.');
      return;
    }
    bd.classList.remove('no-camera');
    ctx.setStatus('Starting camera…');
    const gen = ++ctx.generation;
    startScanner(video, (code) => handleCode(bd, code), (s) => {
      if (gen === ctx.generation && !ctx.busy) ctx.setStatus(s);
    }).then((stop) => {
      if (ctx.closed || gen !== ctx.generation) {
        stop();
        return;
      }
      ctx.stop = stop;
    }).catch((err) => {
      if (ctx.closed || gen !== ctx.generation) return;
      bd.classList.add('no-camera');
      const msg = (err && err.message) || 'Could not start the camera.';
      ctx.setStatus(/type|enter/i.test(msg) ? msg : `${msg} You can type the barcode below.`, true);
    });
  };

  ctx.startCamera();
  return bd;
}

async function handleCode(bd, rawCode) {
  const ctx = bd && bd._ctx;
  if (!ctx || ctx.closed || ctx.busy) return;
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length < 6) {
    ctx.setStatus('That barcode looks too short.', true);
    return;
  }
  ctx.busy = true;
  ctx.stopCamera();
  const again = bd.querySelector('.scan-again');
  ctx.setStatus(`Looking up ${code}…`);
  const { meal, date } = ctx;

  const local = localByBarcode(code);
  if (local) {
    closeModal(bd);
    openFoodDetail(local, { meal, date });
    return;
  }

  const usdaKey = effectiveUsdaKey(state.profile);
  let food = null;
  try {
    food = await lookupBarcode(code, { usdaKey });
  } catch (err) {
    if (ctx.closed) return;
    ctx.busy = false;
    ctx.setStatus((err && err.message) || 'Lookup failed. Try again.', true);
    if (again && scannerSupported()) again.hidden = false;
    return;
  }
  if (ctx.closed) return;
  if (food) {
    closeModal(bd);
    openFoodDetail(food, { meal, date });
    return;
  }
  const ok = await confirmDialog(`Not in Open Food Facts${usdaKey ? ' or USDA' : ''} (${code}). Create it?`, { okLabel: 'Create food' });
  if (ctx.closed) return;
  if (ok) {
    closeModal(bd);
    openCustomFood({ barcode: code, meal, date });
    return;
  }
  ctx.busy = false;
  ctx.setStatus('Not found. Scan again or type a different barcode.');
  if (again && scannerSupported()) again.hidden = false;
}

on('scan-manual', (form) => {
  const bd = backdropOf(form);
  const code = form.code.value.replace(/\D/g, '');
  if (!code) {
    toast('Type the numbers under the barcode', { kind: 'error' });
    return;
  }
  form.code.blur();
  handleCode(bd, code);
});

on('scan-restart', (el) => {
  const ctx = ctxOf(el);
  if (!ctx || ctx.busy) return;
  ctx.startCamera();
});
