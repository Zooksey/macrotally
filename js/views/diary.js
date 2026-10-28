// MacroTally — Diary view: daily totals vs targets, meals, quick weigh-in.
import { state, todayStr, addDays, toKg, weightUnit, addWeight } from '../store.js';
import { dayTotals, targets } from '../calc.js';
import { esc, fmt, fmtQty, parseNum, dateLabel, icon, on, toast, requestRender } from '../ui.js';
import { nav } from '../app.js';
import { openAddFood, openFoodDetail } from '../modals/food.js';

function macroBar(label, eaten, target, color) {
  const pct = target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
  const over = target > 0 && eaten > target * 1.05;
  return `
    <div class="macro">
      <div class="macro-head"><span>${esc(label)}</span><span class="${over ? 'over' : ''}">${fmt(eaten)} / ${fmt(target)} g</span></div>
      <div class="bar"><span style="width:${pct.toFixed(1)}%;background:${color}"></span></div>
    </div>`;
}

function summaryCard(tot, t) {
  const remaining = Math.round(t.cal - tot.cal);
  const pct = t.cal > 0 ? Math.min(100, (tot.cal / t.cal) * 100) : 0;
  const remText = remaining >= 0
    ? `<span class="rem">${fmt(remaining)}</span><span class="muted small"> kcal left</span>`
    : `<span class="rem over">${fmt(-remaining)}</span><span class="over small"> kcal over</span>`;
  return `
    <section class="card summary">
      <div class="summary-top">
        <div>
          <div class="big-num">${fmt(tot.cal)}</div>
          <div class="muted small">of ${fmt(t.cal)} kcal</div>
        </div>
        <div class="summary-rem">${remText}</div>
      </div>
      <div class="bar bar-lg${remaining < 0 ? ' bar-over' : ''}"><span style="width:${pct.toFixed(1)}%"></span></div>
      <div class="macro-grid">
        ${macroBar('Protein', tot.p, t.p, 'var(--p)')}
        ${macroBar('Carbs', tot.c, t.c, 'var(--c)')}
        ${macroBar('Fat', tot.f, t.f, 'var(--f)')}
      </div>
      <div class="muted small fiber">Fiber ${fmt(tot.fiber)} g</div>
    </section>`;
}

function weighInCard(date) {
  if (date > todayStr()) return '';
  if ((state.weights || []).some((w) => w.date === date)) return '';
  const u = weightUnit(state.profile.units);
  const label = date === todayStr() ? "Log today's weight" : `Log weight for ${dateLabel(date)}`;
  return `
    <form class="card weigh-in" data-submit="diary-weight" data-date="${esc(date)}">
      <label class="weigh-label" for="diary-weight-input">${esc(label)}</label>
      <div class="inline-form">
        <input id="diary-weight-input" name="weight" type="text" inputmode="decimal" autocomplete="off" placeholder="${esc(u)}" aria-label="Weight in ${esc(u)}">
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    </form>`;
}

function unitText(e) {
  const raw = e.unit && e.unit.label ? e.unit.label : 'g';
  if (raw === 'g') return `${fmtQty(e.qty)} g`;
  // "1 serving (30 g)" → "1 serving"; grams are shown separately.
  const label = raw.replace(/\s*\([\d.,]+\s*g\)\s*$/i, '') || raw;
  const sep = /^\d/.test(label) ? ' × ' : ' ';
  return `${fmtQty(e.qty)}${sep}${esc(label)} · ${fmt(e.grams)} g`;
}

function entryRow(e) {
  return `
    <button type="button" class="row entry" data-action="edit-entry" data-id="${esc(e.id)}">
      <div class="row-main">
        <div class="row-title">${esc(e.name)}</div>
        <div class="row-sub">${e.brand ? `<span>${esc(e.brand)}</span> · ` : ''}${unitText(e)}</div>
        <div class="pcf"><span class="p">P ${fmt(e.p)}</span><span class="c">C ${fmt(e.c)}</span><span class="f">F ${fmt(e.f)}</span></div>
      </div>
      <div class="row-end"><span class="kcal">${fmt(e.cal)}</span><span class="muted small">kcal</span></div>
    </button>`;
}

function mealSection(meal, entries, canAdd) {
  const kcal = entries.reduce((s, e) => s + (Number(e.cal) || 0), 0);
  return `
    <section class="card meal">
      <div class="meal-head">
        <h2>${esc(meal)}</h2>
        <span class="muted small">${entries.length ? `${fmt(kcal)} kcal` : ''}</span>
      </div>
      ${entries.length ? `<div class="list">${entries.map(entryRow).join('')}</div>` : ''}
      ${canAdd ? `<button type="button" class="btn btn-ghost btn-add" data-action="add-food" data-meal="${esc(meal)}">${icon('plus')} Add food</button>` : ''}
    </section>`;
}

/**
 * Diary tab: date navigation, daily summary vs targets, quick weigh-in, and per-meal entries.
 * @returns {string} HTML
 */
export function diaryView() {
  const date = nav.date;
  const today = todayStr();
  const day = state.diary[date];
  const entries = (day && day.entries) || [];
  const tot = dayTotals(day);
  const t = targets(state);
  const meals = state.meals && state.meals.length ? state.meals : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];

  const sections = meals.map((m) => mealSection(m, entries.filter((e) => e.meal === m), true));
  const orphans = entries.filter((e) => !meals.includes(e.meal));
  if (orphans.length) sections.push(mealSection('Other', orphans, false));

  const loggedDays = Object.values(state.diary || {}).filter((d) => d && d.entries && d.entries.length).length;
  const note = loggedDays < 7
    ? '<p class="note">Log everything you eat; unlogged days are ignored by the expenditure estimate, partial days drag it down.</p>'
    : '';

  return `
    <header class="topbar date-nav">
      <button type="button" class="icon-btn" data-action="diary-shift" data-days="-1" aria-label="Previous day">${icon('left')}</button>
      <div class="date-title">
        <h1>${esc(dateLabel(date))}</h1>
        ${date !== today ? '<button type="button" class="link-btn" data-action="diary-today">Today</button>' : ''}
      </div>
      <button type="button" class="icon-btn" data-action="diary-shift" data-days="1" aria-label="Next day">${icon('right')}</button>
    </header>
    ${summaryCard(tot, t)}
    ${weighInCard(date)}
    ${sections.join('')}
    ${note}`;
}

on('diary-shift', (el) => {
  nav.date = addDays(nav.date, Number(el.dataset.days) || 0);
  requestRender();
});

on('diary-today', () => {
  nav.date = todayStr();
  requestRender();
});

on('add-food', (el) => {
  openAddFood(el.dataset.meal, nav.date);
});

on('edit-entry', (el) => {
  const date = nav.date;
  const day = state.diary[date];
  const entry = day && day.entries ? day.entries.find((e) => e.id === el.dataset.id) : null;
  if (!entry) return;
  let food = state.foods[entry.foodId];
  if (!food) {
    // Food was removed from the library: rebuild one from the entry's snapshot.
    const g = entry.grams > 0 ? entry.grams : 100;
    const k = 100 / g;
    const isServing = entry.unit && entry.unit.label !== 'g' && entry.unit.label !== 'oz';
    food = {
      id: entry.foodId,
      source: String(entry.foodId || '').split(':')[0] || 'custom',
      barcode: null,
      name: entry.name,
      brand: entry.brand || '',
      per100: {
        cal: (entry.cal || 0) * k,
        p: (entry.p || 0) * k,
        c: (entry.c || 0) * k,
        f: (entry.f || 0) * k,
        fiber: (entry.fiber || 0) * k
      },
      servings: isServing ? [{ label: entry.unit.label, grams: entry.unit.grams }] : [],
      defaultGrams: g,
      _snapshot: true
    };
  }
  openFoodDetail(food, { meal: entry.meal, date, entry });
});

on('diary-weight', (form) => {
  const v = parseNum(form.weight.value);
  if (!(v > 0)) {
    toast('Enter your weight', { kind: 'error' });
    return;
  }
  const kg = toKg(v, state.profile.units);
  if (kg < 20 || kg > 500) {
    toast('That weight looks off', { kind: 'error' });
    return;
  }
  addWeight(form.dataset.date || todayStr(), kg);
  toast('Weight saved');
  requestRender();
});
