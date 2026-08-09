const CACHE = 'flowmate-v7-multiprovider';
const APP_SHELL = ['/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => event.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())
));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const url = new URL(event.request.url);
  const isNavigate = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  const isVersion = url.pathname === '/version.json' || url.pathname === '/sw.js';
  // Always prefer network for app shell / version so deployments show up immediately.
  if (isNavigate || isVersion) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(() => caches.match(event.request).then(hit => hit || caches.match('/')))
    );
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
