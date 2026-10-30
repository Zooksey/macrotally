/* MacroTally service worker: versioned, precached app shell served cache-first; network-first for everything
   else on this origin. The shell is fetched with cache: 'reload' so the browser's HTTP cache (GitHub Pages sends
   max-age=600) can never feed an old file into a new version. */

/** Bump to invalidate old caches. */
const VERSION = 'v16';
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
  './js/packs.js',
  './data/packs/index.json',
  './data/packs/taco-bell.json',
  './data/packs/applebees.json',
  './data/packs/arbys.json',
  './data/packs/buffalo-wild-wings.json',
  './data/packs/burger-king.json',
  './data/packs/chick-fil-a.json',
  './data/packs/chilis.json',
  './data/packs/chipotle.json',
  './data/packs/cracker-barrel.json',
  './data/packs/culvers.json',
  './data/packs/dairy-queen.json',
  './data/packs/dominos.json',
  './data/packs/dunkin.json',
  './data/packs/five-guys.json',
  './data/packs/ihop.json',
  './data/packs/in-n-out.json',
  './data/packs/jack-in-the-box.json',
  './data/packs/jersey-mikes.json',
  './data/packs/jimmy-johns.json',
  './data/packs/kfc.json',
  './data/packs/little-caesars.json',
  './data/packs/mcdonalds.json',
  './data/packs/olive-garden.json',
  './data/packs/panda-express.json',
  './data/packs/panera-bread.json',
  './data/packs/papa-johns.json',
  './data/packs/pizza-hut.json',
  './data/packs/popeyes.json',
  './data/packs/raising-canes.json',
  './data/packs/shake-shack.json',
  './data/packs/sonic.json',
  './data/packs/starbucks.json',
  './data/packs/subway.json',
  './data/packs/texas-roadhouse.json',
  './data/packs/wendys.json',
  './data/packs/whataburger.json',
  './data/packs/wingstop.json',
  './data/packs/zaxbys.json',
  './js/scanner.js',
  './js/charts.js',
  './js/ui.js',
  './js/app.js',
  './js/drive.js',
  './js/feed.js',
  './js/ai.js',
  './js/views/diary.js',
  './js/views/weight.js',
  './js/views/plan.js',
  './js/views/settings.js',
  './js/modals/food.js',
  './js/modals/setup.js',
  './js/modals/ai.js',
  './js/modals/settings.js'
];

/** Absolute URLs (no query) of the shell, for the fetch handler. */
const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, self.location.href).href));

/** A request that bypasses the HTTP cache, so a new version precaches what is on the server now. */
const fresh = (url) => new Request(url, { cache: 'reload' });

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(SHELL.map(fresh));
    } catch {
      // One missing/failed file must not break install: add individually.
      await Promise.allSettled(SHELL.map((url) => cache.add(fresh(url))));
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

  const key = `${url.origin}${url.pathname}`;
  const isShell = SHELL_URLS.has(key) || req.mode === 'navigate';

  event.respondWith((async () => {
    // Shell files come from this version's precache, so one load never mixes two versions and a reload after
    // "New version ready" shows the new one even while the browser's HTTP cache still holds the old files.
    if (isShell) {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : key);
      if (cached) return cached;
    }
    try {
      const res = await fetch(isShell ? fresh(req.url) : req);
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
