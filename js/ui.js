// MacroTally — DOM helpers, delegated action registry, modals, toasts.
import { todayStr, addDays, parseDate } from './store.js';

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * HTML-escape a value for safe interpolation into templates.
 * @param {*} s Any value; null/undefined become ''.
 * @returns {string}
 */
export const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, (ch) => ESC_MAP[ch]));

/**
 * Format a number with grouping and a fixed number of decimals.
 * @param {number|null|undefined} n
 * @param {number} [digits=0]
 * @returns {string} '–' for null/NaN/Infinity.
 */
export function fmt(n, digits = 0) {
  if (n == null || typeof n === 'boolean') return '–';
  const v = Number(n);
  if (!Number.isFinite(v)) return '–';
  const out = v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // Avoid "-0"
  return /^-0([.,]0+)?$/.test(out) ? out.slice(1) : out;
}

/**
 * Format a quantity compactly: up to 2 decimals, trailing zeros removed.
 * @param {number} n
 * @returns {string}
 */
export function fmtQty(n) {
  if (!Number.isFinite(Number(n))) return '–';
  return String(Math.round(Number(n) * 100) / 100);
}

/**
 * Parse a user-typed number, accepting a comma as decimal separator.
 * @param {string|number|null|undefined} v
 * @returns {number} NaN when not a number.
 */
export function parseNum(v) {
  if (v == null) return NaN;
  const s = String(v).trim().replace(',', '.');
  if (s === '') return NaN;
  return Number(s);
}

/**
 * Human label for a 'YYYY-MM-DD' date relative to today.
 * @param {string} date
 * @returns {string} 'Today', 'Yesterday', 'Tomorrow', else e.g. 'Tue, Oct 28'.
 */
export function dateLabel(date) {
  if (!date) return '';
  const today = todayStr();
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  if (date === addDays(today, 1)) return 'Tomorrow';
  const d = parseDate(date);
  const opts = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Short date like 'Oct 28' (year appended when not the current year).
 * @param {string|Date} date 'YYYY-MM-DD' or Date.
 * @returns {string}
 */
export function shortDate(date) {
  if (!date) return '';
  const d = typeof date === 'string' ? parseDate(date) : date;
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

const ICON_PATHS = {
  diary: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  weight: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8.5 10.5a5 5 0 0 1 7 0"/><path d="M12 12l1.5-2"/>',
  plan: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0 1 20 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.5"/>',
  barcode: '<path d="M4 6v12M7 6v12M10 6v12M14 6v12M16 6v12M20 6v12"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  sparkle: '<path d="M10 3.5l1.6 4.9 4.9 1.6-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z"/><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/>'
};

/**
 * Inline 24×24 stroked SVG icon.
 * @param {string} name Key of the built-in icon set.
 * @param {string} [cls=''] Extra class names.
 * @returns {string} SVG markup.
 */
export function icon(name, cls = '') {
  const body = ICON_PATHS[name] || '';
  return `<svg class="icon ${esc(cls)}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Registry of delegated handlers: name → handler(el, event). */
export const actions = {};

/**
 * Register a delegated action handler.
 * @param {string} name Value used in data-action / data-submit / data-input / data-change.
 * @param {(el: HTMLElement, e: Event) => void} handler
 */
export function on(name, handler) {
  actions[name] = handler;
}

function run(name, el, e) {
  const fn = actions[name];
  if (!fn) {
    console.warn('No handler for action', name);
    return;
  }
  try {
    const res = fn(el, e);
    if (res && typeof res.catch === 'function') {
      res.catch((err) => {
        console.error(err);
        toast(err && err.message ? err.message : 'Something went wrong', { kind: 'error' });
      });
    }
  } catch (err) {
    console.error(err);
    toast(err && err.message ? err.message : 'Something went wrong', { kind: 'error' });
  }
}

let globalBound = false;

/**
 * Attach the delegated click/submit/input/change listeners to document (once).
 */
export function bindGlobalEvents() {
  if (globalBound) return;
  globalBound = true;
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!el || el.disabled) return;
    e.preventDefault();
    run(el.dataset.action, el, e);
  });
  document.addEventListener('submit', (e) => {
    const form = e.target instanceof Element ? e.target.closest('form[data-submit]') : null;
    if (!form) return;
    e.preventDefault();
    run(form.dataset.submit, form, e);
  });
  document.addEventListener('input', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-input]') : null;
    if (el) run(el.dataset.input, el, e);
  });
  document.addEventListener('change', (e) => {
    const el = e.target instanceof Element ? e.target.closest('[data-change]') : null;
    if (el) run(el.dataset.change, el, e);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = topmost();
    if (top && !top._sticky) closeModal(top);
  });
}

function modalRoot() {
  let root = document.getElementById('modal-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'modal-root';
    document.body.appendChild(root);
  }
  return root;
}

function topmost() {
  const list = modalRoot().querySelectorAll(':scope > .modal-backdrop');
  return list.length ? list[list.length - 1] : null;
}

function syncBodyLock() {
  document.body.classList.toggle('modal-open', !!topmost());
}

/**
 * Open a bottom-sheet modal. Modals stack; the newest is on top.
 * @param {string} html Inner HTML of the sheet.
 * @param {{cls?: string, sticky?: boolean, onClose?: (() => void)|null}} [opts]
 * @returns {HTMLElement} The .modal-backdrop element (handlers can stash context on it).
 */
export function openModal(html, { cls = '', sticky = false, onClose = null } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop._sticky = sticky;
  backdrop._onClose = onClose;
  backdrop.innerHTML = `<div class="modal sheet ${esc(cls)}" role="dialog" aria-modal="true">${html}</div>`;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && !backdrop._sticky) closeModal(backdrop);
  });
  modalRoot().appendChild(backdrop);
  syncBodyLock();
  return backdrop;
}

/**
 * Close a modal (default: the topmost) and run its onClose callback.
 * @param {HTMLElement|null} [backdrop]
 */
export function closeModal(backdrop = topmost()) {
  if (!backdrop || !backdrop.isConnected) return;
  backdrop.remove();
  syncBodyLock();
  const fn = backdrop._onClose;
  backdrop._onClose = null;
  if (typeof fn === 'function') {
    try {
      fn();
    } catch (err) {
      console.error(err);
    }
  }
}

/** Close every open modal, topmost first. */
export function closeAllModals() {
  let top = topmost();
  while (top) {
    closeModal(top);
    top = topmost();
  }
}

/**
 * Show a transient toast message.
 * @param {string} message
 * @param {{ms?: number, kind?: 'info'|'error'}} [opts]
 */
export function toast(message, { ms = 2200, kind = 'info' } = {}) {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    document.body.appendChild(root);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${kind === 'error' ? 'error' : 'info'}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

let renderQueued = false;

/** Ask app.js to re-render the current view (coalesced to one render per tick). */
export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    document.dispatchEvent(new CustomEvent('render'));
  });
}

/**
 * Modal confirmation dialog.
 * @param {string} message
 * @param {{okLabel?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>} true when confirmed.
 */
export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const html = `
      <div class="dialog-body">
        <p class="dialog-msg">${esc(message)}</p>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost" data-action="confirm-answer" data-value="0">Cancel</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="confirm-answer" data-value="1">${esc(okLabel)}</button>
        </div>
      </div>`;
    const bd = openModal(html, { cls: 'confirm', onClose: () => finish(false) });
    bd._finish = finish;
    const ok = bd.querySelector('[data-value="1"]');
    if (ok) ok.focus();
  });
}

on('confirm-answer', (el) => {
  const bd = el.closest('.modal-backdrop');
  if (bd && bd._finish) bd._finish(el.dataset.value === '1');
  closeModal(bd);
});

on('close-modal', (el) => closeModal(el.closest('.modal-backdrop')));
