const CACHE = 'wizard-factory-v1';
const ASSETS = ['/', '/app.webmanifest', '/style.css', '/sprites.js', '/game.js',
  '/icon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request)
    .then(response => {
      if (!response.ok) return response;
      return caches.open(CACHE).then(cache => cache.put(e.request, response.clone())).then(() => response);
    })
    .catch(() => caches.match(e.request).then(response => response || caches.match('/'))));
});
