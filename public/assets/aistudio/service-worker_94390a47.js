const CACHE_NAME = 'retroplay-offline-v1';
const APP_SHELL = ['./', './index.html', './atualizacoes.html', './games.json', './manifest.webmanifest', './app-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('retroplay-offline-') && n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function saveResponse(cache, request, response) {
  if (response && (response.ok || response.type === 'opaque') && request.method === 'GET' && !request.headers.has('range')) {
    try { await cache.put(request, response.clone()); } catch (_) { /* quota / opaque response not cacheable */ }
  }
  return response;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  const isEmulatorCDN = url.hostname === 'cdn.emulatorjs.org';
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin && !isEmulatorCDN) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const networkFirst = isSameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('/games.json'));
    if (cached && !networkFirst) return cached;
    try {
      const response = await fetch(req);
      return await saveResponse(cache, req, response);
    } catch (err) {
      if (cached) return cached;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
