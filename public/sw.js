const cacheName = 'enve-family-offline-v8';
const shell = [
  '/',
  '/app.js',
  '/style.css',
  '/onscreen-keyboard.js',
  '/onscreen-keyboard.css',
  '/manifest.webmanifest',
  '/icon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/offline.html',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== cacheName).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const path = url.pathname;
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (!shell.includes(path)) {
    if (event.request.mode === 'navigate')
      event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(cacheName).then((cache) => cache.put(path, copy));
        }
        return response;
      })
      .catch(
        async () =>
          (await caches.match(path)) ||
          (event.request.mode === 'navigate' ? caches.match('/offline.html') : Response.error()),
      ),
  );
});
