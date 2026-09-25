/* Cache the public app shell only. Accounts, credentials and API data stay online. */
const shellCache = 'jevellan-shell-v1';
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellCache); const response = await fetch('/');
    if (!response.ok || !response.headers.get('content-type')?.startsWith('text/html')) throw new Error('The app shell is unavailable.');
    const html = await response.clone().text(); const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map((match) => match[1]);
    await cache.put('/', response); await cache.addAll(['/manifest.webmanifest', '/icon.svg', ...assets]);
  })());
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('jevellan-shell-') && key !== shellCache).map((key) => caches.delete(key))))]));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/hub/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async (response) => { if (response.ok && response.headers.get('content-type')?.startsWith('text/html')) { const cache = await caches.open(shellCache); await cache.put('/', response.clone()); } return response; }).catch(async () => (await caches.match('/')) ?? Response.error()));
  } else if (url.pathname.startsWith('/assets/') || ['/icon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request).then(async (response) => { if (response.ok) { const cache = await caches.open(shellCache); await cache.put(event.request, response.clone()); } return response; })));
  }
});
