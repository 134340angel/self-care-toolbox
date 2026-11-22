// Self-care Toolbox service worker: keeps the tools usable offline.
const CACHE = 'self-care-v4';
const SHELL = ['./', './index.html', './sleep.html', './sync.js', './manifest.json',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Network first, so updates show up right away; fall back to the cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    // no-cache: always ask the server whether the file changed (cheap when it hasn't), instead of trusting the browser's 10-minute copy
    (e.request.mode === 'navigate'
      ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => res.redirected ? Response.redirect(res.url, 302) : res)
      : fetch(e.request, { cache: 'no-cache' })
    ).then(res => {
      if (res.ok && res.type !== 'opaqueredirect' && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
