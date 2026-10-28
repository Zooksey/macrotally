/* MacroTally service worker: precached app shell, network-first for same-origin GETs. */

/** Bump to invalidate old caches. */
const VERSION = 'v5';
const CACHE = `macrotally-${VERSION}`;

/** App shell, relative to the service worker scope (works from a sub-path). */
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon.svg',
  './js/config.js',
  './js/store.js',
  './js/calc.js',
  './js/foods.js',
  './js/builtin.js',
  './js/update.js',
  './data/foods.json',
  './js/scanner.js',
  './js/charts.js',
  './js/ui.js',
  './js/app.js',
  './js/drive.js',
  './js/views/diary.js',
  './js/views/weight.js',
  './js/views/plan.js',
  './js/views/settings.js',
  './js/modals/food.js',
  './js/modals/setup.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(SHELL);
    } catch {
      // One missing/failed file must not break install: add individually.
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cross-origin (food APIs, CDN): network only, never cached.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
      }
      return res;
    } catch {
      const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('./index.html', self.registration.scope).href);
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});
