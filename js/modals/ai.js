// MacroTally — "AI add" sheet: describe and/or photograph what you ate, Claude (on the owner's helper server)
// identifies it, the user confirms one card per item (matched against the foods the app already has, so no
// duplicates), then everything is logged at once. One modal, three states re-rendered in place:
// compose → waiting → result. See SPEC-ai.md section 6.
import { state, saveFood, addEntry, todayStr } from '../store.js';
import { unitOptions, nutrientsFor, buildEntry } from '../foods.js';
import { builtinFoods, loadBuiltinFoods } from '../builtin.js';
import { packFoods, loadPacks } from '../packs.js';
import {
  aiConfigured, askAi, downscaleImage, foodFromAiItem, amountFromAiItem, confidenceLabel, findExisting, MAX_AI_TEXT,
  MAX_AI_PHOTOS
} from '../ai.js';
import { esc, fmt, fmtQty, parseNum, icon, on, openModal, closeModal, closeAllModals, toast, requestRender } from '../ui.js';
import { openCustomFood } from './food.js';
import { nav } from '../app.js';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const NUTRIENT_ROWS = [['cal', 'Calories', 'kcal'], ['p', 'Protein', 'g'], ['c', 'Carbs', 'g'], ['f', 'Fat', 'g'], ['fiber', 'Fiber', 'g']];

function ctxOf(el) {
  const bd = el && el.closest('.modal-backdrop');
  return bd && bd._ai ? bd._ai : null;
}

function mealList() {
  return state.meals && state.meals.length ? state.meals.slice() : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
}

/** Creation time of an entry, read from its id (store.uid() starts with Date.now() in base 36); 0 when unknown. */
function entryTime(e) {
  const id = String((e && e.id) || '');
  if (id.length < 9) return 0;
  const t = parseInt(id.slice(0, 8), 36);
  return Number.isFinite(t) && t > 1.5e12 && t < Date.now() + 60000 ? t : 0;
}

/**
 * Default meal: the meal of the most recent entry on that date when it was added within the last 2 h, else by
 * the clock (before 10:30 the first meal, before 15:00 the second, before 20:00 the third, else the fourth).
 */
function defaultMeal(date, meals) {
  const entries = (state.diary[date] && state.diary[date].entries) || [];
  let last = null;
  let lastT = 0;
  for (const e of entries) {
    const t = entryTime(e);
    if (t > lastT) {
      lastT = t;
      last = e;
    }
  }
  if (last && Date.now() - lastT < TWO_HOURS && meals.includes(last.meal)) return last.meal;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const idx = mins < 630 ? 0 : mins < 900 ? 1 : mins < 1200 ? 2 : 3;
  return meals[Math.min(idx, meals.length - 1)];
}

/**
 * Open the AI add sheet for a diary date.
 * @param {{date: string, meal?: string|null, replace?: HTMLElement|null}} opts
 *   meal: preselected meal (a non-empty string wins over the default meal, even when it is not in the meal list);
 *   replace: a sheet underneath (the add-food sheet) that is closed too once items are logged, not on cancel.
 * @returns {HTMLElement} backdrop
 */
export function openAiAdd({ date, meal = null, replace = null }) {
  const meals = mealList();
  const ctx = {
    date,
    meal: typeof meal === 'string' && meal ? meal : defaultMeal(date, meals),
    replace,
    text: '',
    photos: [], // [{ base64, mime }] after downscaling (at most MAX_AI_PHOTOS); kept for Ask again, dropped on close
    phase: 'compose',
    error: '',
    items: [],
    seconds: null,
    correction: '',
    abort: null,
    seq: 0,
    timer: null,
    closed: false
  };
  const bd = openModal('', {
    cls: 'ai-sheet',
    onClose: () => {
      ctx.closed = true;
      if (ctx.abort) ctx.abort.abort();
      clearInterval(ctx.timer);
      ctx.photos = [];
      ctx.items = [];
    }
  });
  bd._ai = ctx;
  ctx.bd = bd;
  render(ctx);
  return bd;
}

function render(ctx) {
  const sheet = ctx.bd && ctx.bd.querySelector('.modal');
  if (!sheet || ctx.closed) return;
  const top = sheet.scrollTop;
  clearInterval(ctx.timer);
  if (ctx.phase === 'waiting') sheet.innerHTML = waitingHtml();
  else if (ctx.phase === 'result') sheet.innerHTML = resultHtml(ctx);
  else sheet.innerHTML = composeHtml(ctx);
  if (ctx.phase === 'result') sheet.scrollTop = top;
  if (ctx.phase === 'waiting') {
    const t0 = Date.now();
    const out = sheet.querySelector('.ai-elapsed');
    ctx.timer = setInterval(() => {
      if (out) out.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
    }, 1000);
  }
  if (ctx.phase === 'compose') {
    const ta = sheet.querySelector('textarea');
    if (ta && !ctx.text && !ctx.photos.length) setTimeout(() => ta.focus(), 60);
  }
}

function head(title) {
  return `
    <div class="sheet-head">
      <h2>${esc(title)}</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('close')}</button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Compose                                                             */
/* ------------------------------------------------------------------ */

function composeHtml(ctx) {
  if (!aiConfigured(state)) {
    return `${head('AI add')}
      <p class="small">Set up the AI helper in Settings</p>
      <p class="hint">AI add asks Claude, running on your own server, what you ate. See the README for setup.</p>
      <button type="button" class="btn btn-primary btn-block" data-action="ai-goto-settings">Open Settings</button>`;
  }
  const canAsk = !!(ctx.text.trim() || ctx.photos.length);
  const thumbs = ctx.photos.length
    ? `<div class="ai-thumbs">${ctx.photos.map((ph, k) => `
        <div class="ai-thumb">
          <img src="data:${esc(ph.mime)};base64,${esc(ph.base64)}" alt="Photo ${k + 1}">
          <button type="button" class="icon-btn ai-thumb-remove" data-action="ai-photo-remove" data-k="${k}" aria-label="Remove photo ${k + 1}">${icon('close')}</button>
        </div>`).join('')}
      </div>`
    : '';
  const room = ctx.photos.length < MAX_AI_PHOTOS;
  const buttons = room
    ? `<label class="btn btn-ghost file-btn">${icon('camera')} Take photo
          <input class="visually-hidden" type="file" accept="image/*" capture="environment" data-change="ai-photo">
        </label>
        <label class="btn btn-ghost file-btn">Choose photo
          <input class="visually-hidden" type="file" accept="image/*" multiple data-change="ai-photo">
        </label>`
    : `<p class="muted small">${MAX_AI_PHOTOS} photos is the most per ask.</p>`;
  return `${head(`AI add to ${ctx.meal}`)}
    <form class="ai-compose" data-submit="ai-ask">
      <label class="field"><span>Description</span>
        <textarea name="text" rows="3" maxlength="${MAX_AI_TEXT}" autocomplete="off" placeholder="What did you eat? e.g. 71 g of Dot's pretzels" data-input="ai-text">${esc(ctx.text)}</textarea>
      </label>
      <div class="ai-photo-row">
        ${thumbs}
        ${buttons}
      </div>
      ${ctx.error ? `<p class="error inline-error" role="alert">${esc(ctx.error)}</p>` : ''}
      <button type="submit" class="btn btn-primary btn-block ai-ask-btn"${canAsk ? '' : ' disabled'}>${icon('sparkle')} Ask Claude</button>
    </form>`;
}

function waitingHtml() {
  return `${head('AI add')}
    <div class="ai-wait" role="status" aria-live="polite">
      <span class="spinner spinner-lg" aria-hidden="true"></span>
      <p>Asking Claude… usually 20 to 40 s</p>
      <p class="muted small ai-elapsed">0 s</p>
    </div>
    <button type="button" class="btn btn-ghost btn-block" data-action="ai-cancel">Cancel</button>`;
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

/** The food the entry for this item will use, per the current choice. */
function chosenFood(it) {
  if (it.choice === 'existing' && it.match) return it.match.food;
  if (it.choice === 'update' && it.match) return updatedFood(it);
  return it.aiFood;
}

/** The stored custom food with Claude's per100 and serving (same id, name, brand and barcode). */
function updatedFood(it) {
  if (!it.updFood) {
    const ex = it.match.food;
    const upd = {
      ...ex,
      per100: { ...it.aiFood.per100 },
      servings: (it.aiFood.servings || []).map((s) => ({ ...s })),
      defaultGrams: it.aiFood.defaultGrams
    };
    if (it.aiFood.servingOnly) upd.servingOnly = true;
    else delete upd.servingOnly;
    it.updFood = upd;
  }
  return it.updFood;
}

/** "Update stored" is offered only for the user's own custom foods (built-in and pack data are read-only). */
function canUpdate(it) {
  const ex = it.match && it.match.food;
  return !!(ex && ex.source === 'custom' && state.foods[ex.id]);
}

/** Set the choice and reset the amount to Claude's, in the chosen food's units. */
function setChoice(it, choice) {
  it.choice = choice;
  const food = chosenFood(it);
  it.units = unitOptions(food);
  const amt = amountFromAiItem(it.ai, food);
  const idx = it.units.findIndex((u) => u.label === amt.unit.label && Math.abs(u.grams - amt.unit.grams) < 0.01);
  it.unitIdx = idx >= 0 ? idx : 0;
  it.qty = amt.qty;
}

function buildItems(items) {
  const lib = Object.values(state.foods || {}).filter((f) => f && typeof f === 'object' && f.id);
  const pool = [...lib, ...builtinFoods(), ...packFoods()];
  const localIds = new Set(lib.map((f) => f.id));
  const out = [];
  for (const ai of items || []) {
    let aiFood;
    try {
      aiFood = foodFromAiItem(ai);
    } catch {
      continue;
    }
    const match = findExisting(ai, aiFood, pool, { localIds });
    let kind = 'none';
    if (match) kind = !match.cmp.comparable ? 'unknown' : match.cmp.same ? 'same' : 'diff';
    const it = { ai, aiFood, match, kind, checked: true, choice: 'new', units: [], unitIdx: 0, qty: 1, updFood: null };
    let choice = 'new';
    if (kind === 'same' || kind === 'unknown') choice = 'existing';
    else if (kind === 'diff') {
      // Numbers read off the actual label beat what is stored; anything less certain keeps the stored food.
      if (ai.confidence === 'label') choice = canUpdate(it) ? 'update' : 'new';
      else choice = 'existing';
    }
    setChoice(it, choice);
    out.push(it);
  }
  return out;
}

function foodLabel(food) {
  return `<strong>${esc(food.name)}</strong>${food.brand ? ` · ${esc(food.brand)}` : ''}`;
}

function diffTable(cmp) {
  const rows = NUTRIENT_ROWS.filter(([k]) => cmp.diffs.some((d) => d.key === k)).map(([k, label, unit]) => {
    const d = cmp.diffs.find((x) => x.key === k);
    const digits = k === 'cal' ? 0 : 1;
    return `<tr><th scope="row">${esc(label)} (${unit})</th><td>${fmt(d.ai, digits)}</td><td>${fmt(d.existing, digits)}</td></tr>`;
  }).join('');
  return `
    <table class="ai-diff">
      <thead><tr><th scope="col">${cmp.basis === 'serving' ? 'Per serving' : 'Per 100 g'}</th><th scope="col">Claude</th><th scope="col">Stored</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function matchHtml(it, i) {
  if (!it.match) return '';
  const ex = it.match.food;
  const link = (choice, text) => `<button type="button" class="link-btn" data-action="ai-choice" data-i="${i}" data-choice="${choice}">${esc(text)}</button>`;
  if (it.kind === 'diff') {
    const alt = canUpdate(it) ? ['update', 'Update stored'] : ['new', 'Add corrected copy'];
    const seg = (choice, text) => `<button type="button" class="seg${it.choice === choice ? ' active' : ''}" data-action="ai-choice" data-i="${i}" data-choice="${choice}" aria-pressed="${it.choice === choice}">${esc(text)}</button>`;
    return `
      <div class="ai-match ai-match-diff">
        <p>Looks like ${foodLabel(ex)} but the numbers differ</p>
        ${diffTable(it.match.cmp)}
        <div class="segmented ai-choice">${seg('existing', 'Use stored')}${seg(alt[0], alt[1])}</div>
      </div>`;
  }
  if (it.choice === 'existing') {
    return `<div class="ai-match"><p>Already in your foods: ${foodLabel(ex)}</p>${link('new', "Use Claude's instead")}</div>`;
  }
  return `<div class="ai-match"><p>Adding Claude's version as a new food.</p>${link('existing', `Use ${ex.name} instead`)}</div>`;
}

function macrosHtml(it) {
  const food = chosenFood(it);
  const unit = it.units[it.unitIdx] || it.units[0];
  const qty = Number(it.qty);
  const grams = qty > 0 && unit ? qty * unit.grams : 0;
  const n = nutrientsFor(food, grams);
  const g = food.servingOnly ? '' : ` · ${fmt(grams)} g`;
  return `<strong>${fmt(n.cal)} kcal</strong>${g} · <span class="p">P ${fmt(n.p, 1)}</span> · <span class="c">C ${fmt(n.c, 1)}</span> · <span class="f">F ${fmt(n.f, 1)}</span>`;
}

function itemHtml(it, i) {
  const { ai } = it;
  const conf = ['label', 'web', 'estimate'].includes(ai.confidence) ? ai.confidence : 'estimate';
  return `
    <div class="ai-item${it.checked ? '' : ' is-off'}" data-i="${i}">
      <div class="ai-item-head">
        <input type="checkbox" class="ai-check" data-change="ai-check" data-i="${i}" aria-label="Include ${esc(ai.name)}"${it.checked ? ' checked' : ''}>
        <div class="ai-item-title">
          <div class="row-title">${esc(ai.name)} <span class="ai-badge ${conf}">${esc(confidenceLabel(conf))}</span>${it.match ? '' : ' <span class="tag">New food</span>'}</div>
          ${ai.brand ? `<div class="muted small">${esc(ai.brand)}</div>` : ''}
          ${ai.source ? `<div class="ai-source muted small" title="${esc(ai.source)}">${esc(ai.source)}</div>` : ''}
        </div>
      </div>
      ${matchHtml(it, i)}
      ${ai.notes ? `<p class="muted small ai-notes">${esc(ai.notes)}</p>` : ''}
      <div class="field-row qty-row">
        <label class="field"><span>Amount</span>
          <input type="text" inputmode="decimal" autocomplete="off" value="${esc(fmtQty(it.qty))}" data-input="ai-qty" data-i="${i}">
        </label>
        <label class="field grow"><span>Unit</span>
          <select data-change="ai-unit" data-i="${i}">
            ${it.units.map((u, k) => `<option value="${k}"${k === it.unitIdx ? ' selected' : ''}>${esc(u.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="ai-macros small">${macrosHtml(it)}</div>
      <button type="button" class="link-btn" data-action="ai-edit" data-i="${i}">${icon('edit', 'icon-sm')} Edit details</button>
    </div>`;
}

function addLabel(ctx) {
  const n = ctx.items.filter((it) => it.checked).length;
  return n ? `Add ${n} to ${ctx.meal}` : `Add to ${ctx.meal}`;
}

function resultHtml(ctx) {
  const n = ctx.items.length;
  return `${head(n === 1 ? 'Claude found 1 item' : `Claude found ${n} items`)}
    ${Number(ctx.seconds) > 0 ? `<p class="muted small ai-took">Answered in ${fmt(ctx.seconds)} s</p>` : ''}
    <div class="ai-list">${ctx.items.map(itemHtml).join('')}</div>
    <div class="ai-again">
      <label class="field"><span>Not right? Tell Claude</span>
        <input type="text" autocomplete="off" value="${esc(ctx.correction)}" placeholder="e.g. it was the honey mustard flavour" data-input="ai-correction">
      </label>
      <button type="button" class="btn btn-ghost btn-block" data-action="ai-again">Ask again</button>
    </div>
    <button type="button" class="btn btn-primary btn-block ai-add-btn" data-action="ai-commit"${ctx.items.some((it) => it.checked) ? '' : ' disabled'}>${esc(addLabel(ctx))}</button>`;
}

function refreshAddButton(ctx) {
  const btn = ctx.bd.querySelector('.ai-add-btn');
  if (!btn) return;
  btn.textContent = addLabel(ctx);
  btn.disabled = !ctx.items.some((it) => it.checked);
}

/* ------------------------------------------------------------------ */
/* Asking                                                              */
/* ------------------------------------------------------------------ */

async function ask(ctx, text) {
  if (text.length > MAX_AI_TEXT) {
    toast(`Keep it under ${MAX_AI_TEXT} characters`, { kind: 'error' });
    return;
  }
  const seq = ++ctx.seq;
  const ctrl = new AbortController();
  ctx.abort = ctrl;
  ctx.phase = 'waiting';
  ctx.error = '';
  render(ctx);
  // The matching pool (built-in list + packs) loads while Claude works.
  const poolReady = Promise.all([loadBuiltinFoods(), loadPacks()]).catch(() => {});
  try {
    const data = await askAi({ text, images: ctx.photos, signal: ctrl.signal });
    await poolReady;
    if (ctx.closed || seq !== ctx.seq) return;
    const items = buildItems(data.items);
    if (!items.length) throw new Error("Claude didn't return a food");
    ctx.items = items;
    ctx.seconds = data.seconds;
    ctx.correction = '';
    ctx.phase = 'result';
    render(ctx);
  } catch (err) {
    if (ctx.closed || seq !== ctx.seq) return;
    ctx.phase = 'compose';
    ctx.error = err && err.cancelled ? '' : (err && err.message) || "Claude didn't return a food";
    render(ctx);
  } finally {
    if (seq === ctx.seq) ctx.abort = null;
  }
}

// "AI add" button in the add-food sheet: open over it with that sheet's meal and date preselected.
on('ai-add', (el) => {
  const bd = el && el.closest('.modal-backdrop');
  const ctx = bd && bd._ctx;
  if (ctx && ctx.date) openAiAdd({ date: ctx.date, meal: ctx.meal, replace: bd });
  else openAiAdd({ date: todayStr(), meal: null });
});

on('ai-text', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  ctx.text = el.value;
  const btn = ctx.bd.querySelector('.ai-ask-btn');
  if (btn) btn.disabled = !(ctx.text.trim() || ctx.photos.length);
});

on('ai-photo', async (el) => {
  const ctx = ctxOf(el);
  const files = el.files ? [...el.files] : [];
  if (!ctx || !files.length) return;
  const room = MAX_AI_PHOTOS - ctx.photos.length;
  if (files.length > room) toast(`Up to ${MAX_AI_PHOTOS} photos per ask; using the first ${Math.max(room, 0)}`, { kind: 'error' });
  // Each file is shrunk on its own: one that can't be read is skipped and the others stay.
  const added = [];
  for (const file of files.slice(0, Math.max(room, 0))) {
    try {
      added.push(await downscaleImage(file));
    } catch (err) {
      toast((err && err.message) || "Couldn't read that photo", { kind: 'error' });
    }
  }
  if (ctx.closed || ctx.phase !== 'compose' || !added.length) return;
  // Another pick may have landed while these were shrinking: keep the cap.
  ctx.photos = [...ctx.photos, ...added].slice(0, MAX_AI_PHOTOS);
  render(ctx);
});

on('ai-photo-remove', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  const k = Number(el.dataset.k);
  ctx.photos = ctx.photos.filter((_, i) => i !== k);
  render(ctx);
});

on('ai-ask', (form) => {
  const ctx = ctxOf(form);
  if (!ctx) return;
  const text = ctx.text.trim();
  if (!text && !ctx.photos.length) return;
  ask(ctx, text);
});

on('ai-cancel', (el) => {
  const ctx = ctxOf(el);
  if (ctx && ctx.abort) ctx.abort.abort();
});

on('ai-again', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  const corr = ctx.correction.trim();
  const text = [ctx.text.trim(), corr ? `Correction: ${corr}` : ''].filter(Boolean).join('\n');
  ask(ctx, text);
});

on('ai-correction', (el) => {
  const ctx = ctxOf(el);
  if (ctx) ctx.correction = el.value;
});

on('ai-goto-settings', () => {
  closeAllModals();
  nav.tab = 'settings';
  requestRender();
  setTimeout(() => {
    const card = document.getElementById('ai-helper');
    if (card) card.scrollIntoView({ block: 'start' });
  }, 60);
});

/* ------------------------------------------------------------------ */
/* Result cards                                                        */
/* ------------------------------------------------------------------ */

function itemOf(el) {
  const ctx = ctxOf(el);
  const it = ctx ? ctx.items[Number(el.dataset.i)] : null;
  return it ? { ctx, it, card: el.closest('.ai-item') } : null;
}

on('ai-check', (el) => {
  const x = itemOf(el);
  if (!x) return;
  x.it.checked = !!el.checked;
  if (x.card) x.card.classList.toggle('is-off', !x.it.checked);
  refreshAddButton(x.ctx);
});

on('ai-qty', (el) => {
  const x = itemOf(el);
  if (!x) return;
  x.it.qty = parseNum(el.value);
  const box = x.card && x.card.querySelector('.ai-macros');
  if (box) box.innerHTML = macrosHtml(x.it);
});

on('ai-unit', (el) => {
  const x = itemOf(el);
  if (!x) return;
  const { it } = x;
  const prev = it.units[it.unitIdx];
  const next = it.units[Number(el.value)];
  if (prev && next && Number(it.qty) > 0) {
    // Keep the same amount of food when switching units.
    const k = next.label === 'g' ? 1 : next.label === 'oz' ? 10 : 100;
    const nq = Math.round(((it.qty * prev.grams) / next.grams) * k) / k;
    it.qty = nq > 0 ? nq : 1;
    const input = x.card && x.card.querySelector('[data-input="ai-qty"]');
    if (input) input.value = fmtQty(it.qty);
  }
  it.unitIdx = Number(el.value) || 0;
  const box = x.card && x.card.querySelector('.ai-macros');
  if (box) box.innerHTML = macrosHtml(it);
});

on('ai-choice', (el) => {
  const x = itemOf(el);
  if (!x) return;
  const choice = el.dataset.choice;
  if (!['new', 'existing', 'update'].includes(choice) || choice === x.it.choice) return;
  if (choice === 'update' && !canUpdate(x.it)) return;
  setChoice(x.it, choice);
  render(x.ctx);
});

on('ai-edit', (el) => {
  const x = itemOf(el);
  if (!x) return;
  const { ctx, it } = x;
  openCustomFood({
    food: it.aiFood,
    meal: ctx.meal,
    date: ctx.date,
    onSaved: () => {
      // Saved as a custom food; the detail sheet that opens next logs it. Drop it here so it is not added twice.
      ctx.items = ctx.items.filter((y) => y !== it);
      if (!ctx.items.length) closeModal(ctx.bd);
      else render(ctx);
    }
  });
});

on('ai-commit', (el) => {
  const ctx = ctxOf(el);
  if (!ctx) return;
  const chosen = ctx.items.filter((it) => it.checked);
  if (!chosen.length) {
    toast('Tick at least one item', { kind: 'error' });
    return;
  }
  const bad = chosen.findIndex((it) => !(Number(it.qty) > 0));
  if (bad >= 0) {
    toast('Enter an amount', { kind: 'error' });
    const input = ctx.bd.querySelector(`.ai-item[data-i="${ctx.items.indexOf(chosen[bad])}"] [data-input="ai-qty"]`);
    if (input) input.focus();
    return;
  }
  for (const it of chosen) {
    const food = chosenFood(it);
    const unit = it.units[it.unitIdx] || it.units[0];
    // Existing foods are re-saved like the food detail sheet does (caches built-in / pack foods in the library);
    // "Update stored" overwrites the custom food under its id; new ones become custom foods.
    saveFood(food);
    if (it.choice === 'update') toast(`Updated ${food.name}`);
    addEntry(ctx.date, { ...buildEntry(food, Number(it.qty), unit), meal: ctx.meal });
  }
  closeModal(ctx.bd);
  if (ctx.replace) closeModal(ctx.replace);
  toast(chosen.length === 1 ? 'Added 1 item' : `Added ${chosen.length} items`);
  requestRender();
});
