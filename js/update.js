// MacroTally — app update detection via the service worker.
// sw.js uses skipWaiting + clients.claim, so a new worker takes over as soon as it installs;
// the page still runs the old scripts until it reloads, which is what the banner offers.
import { toast, requestRender } from './ui.js';

/** Bump together with VERSION in sw.js when deploying. Shown in Settings. */
export const APP_VERSION = '1.6.6';

let registration = null;
let updateReady = false;

/**
 * Register the service worker and watch for new versions.
 * @returns {Promise<void>}
 */
export async function registerAppUpdates() {
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  } catch {
    return; // insecure context, unsupported, or blocked: the app still works
  }
  const watch = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      // 'installed' with an existing controller means a NEW version is ready (first install has no controller).
      if (worker.state === 'installed' && navigator.serviceWorker.controller) markReady();
      if (worker.state === 'activated' && navigator.serviceWorker.controller) markReady();
    });
  };
  if (registration.waiting && navigator.serviceWorker.controller) markReady();
  watch(registration.installing);
  registration.addEventListener('updatefound', () => watch(registration.installing));
}

function markReady() {
  if (updateReady) return;
  updateReady = true;
  toast('A new version is ready. Tap "Reload" at the top of the diary.', { ms: 4000 });
  requestRender();
}

/** true once a newer version has installed and a reload would switch to it. */
export function updateAvailable() {
  return updateReady;
}

/** Reload to switch to the installed version (bypasses the page cache). */
export function applyUpdate() {
  location.reload();
}

/**
 * Ask the browser to re-check sw.js now. Resolves to 'ready' when a new version installed,
 * 'current' when nothing changed, 'unsupported' when there is no service worker.
 * @returns {Promise<'ready'|'current'|'unsupported'>}
 */
export async function checkForUpdate() {
  if (!registration) return 'unsupported';
  try {
    await registration.update();
  } catch {
    return 'current';
  }
  if (updateReady) return 'ready';
  // Give a just-found worker a moment to install.
  if (registration.installing || registration.waiting) {
    await new Promise((r) => setTimeout(r, 2500));
  }
  return updateReady ? 'ready' : 'current';
}
