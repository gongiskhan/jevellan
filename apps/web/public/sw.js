/* Build replaces these markers with a content version and a public-only allowlist. */
const shellCache = 'jevellan-shell-__BUILD_VERSION__';
const publicFiles = [/* __PUBLIC_FILES__ */];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(shellCache).then((cache) => cache.addAll(publicFiles)));
});
self.addEventListener('message', (event) => {
  if (event.data?.schema === 'pwa-message-v1' && event.data.action === 'activate-update') event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const keys = await caches.keys();
    // Keep one previous build's public assets for windows with an unfinished draft.
    const previous = keys.filter((key) => /^jevellan-shell-[a-f0-9]{20}$/.test(key) && key !== shellCache).at(-1);
    await Promise.all(keys.filter((key) => key.startsWith('jevellan-shell-') && key !== shellCache && key !== previous).map((key) => caches.delete(key)));
  })());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || /^\/(api|hub|switch)(\/|$)/.test(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(8000) });
        if (response.status < 500) return response;
      } catch { /* Offline or the tailnet is unavailable. */ }
      return (await (await caches.open(shellCache)).match('/offline.html')) ?? Response.error();
    })());
  } else if ((publicFiles.includes(url.pathname) || url.pathname.startsWith('/assets/')) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(shellCache);
      const current = await cache.match(event.request);
      if (current) return current;
      if (url.pathname.startsWith('/assets/')) {
        for (const name of (await caches.keys()).filter((key) => /^jevellan-shell-[a-f0-9]{20}$/.test(key))) {
          const previous = await (await caches.open(name)).match(event.request);
          if (previous) return previous;
        }
      }
      return fetch(event.request);
    })());
  }
});
