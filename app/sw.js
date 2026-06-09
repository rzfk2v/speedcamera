/* Offline cache so the app works with no signal. Bump CACHE to force an update. */
const CACHE = 'speedcam-v0.8';
const ASSETS = [
  './', './index.html', './app.js', './style.css',
  './manifest.webmanifest', './icon.svg', './cameras.json',
  './icon-180.png', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
