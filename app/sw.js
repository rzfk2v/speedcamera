/* Offline cache so the app works with no signal. Bump CACHE to force an update. */
const CACHE = 'speedcam-v0.13';
const ASSETS = [
  './', './index.html', './app.js', './style.css',
  './manifest.webmanifest', './icon.svg', './cameras.json',
  './icon-180.png', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', e => {
  // Fetch each asset bypassing the HTTP cache, so the new cache never absorbs a
  // GitHub-Pages-stale (max-age 600) copy.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u =>
        fetch(new Request(u, { cache: 'reload' })).then(r => c.put(u, r)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Camera data: network-first (pick up refreshes when online), fall back to cache offline.
  if (new URL(e.request.url).pathname.endsWith('cameras.json')) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
        .catch(() => caches.match(e.request))
    );
    return;
  }
  // App shell: cache-first.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
