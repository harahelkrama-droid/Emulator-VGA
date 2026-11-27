const CACHE_NAME = 'retroplay-offline-v4';
const APP_SHELL = [
  './',
  './index.html',
  './standalone.html',
  './atualizacoes.html',
  './games.json',
  './manifest.webmanifest',
  './app-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Usa Promise.allSettled para que um arquivo opcional ausente não quebre toda a instalação do Service Worker
      await Promise.allSettled(
        APP_SHELL.map(async (asset) => {
          try {
            const response = await fetch(asset, { cache: 'no-cache' });
            if (response && response.ok) {
              await cache.put(asset, response);
            }
          } catch (_) {
            // Ignora falha individual em pré-cache
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('retroplay-offline-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

async function saveResponse(cache, request, response) {
  if (
    response &&
    (response.ok || response.type === 'opaque') &&
    request.method === 'GET' &&
    !request.headers.has('range')
  ) {
    try {
      await cache.put(request, response.clone());
    } catch (_) {
      // Cota excedida ou resposta opaca não cacheável
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;

  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const isEmulatorCDN = url.hostname === 'cdn.emulatorjs.org';
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin && !isEmulatorCDN) return;

  // Nunca intercepta endpoints internos do Vite dev ou arquivos temporários de anexo
  if (
    isSameOrigin &&
    (url.pathname.startsWith('/@vite') ||
      url.pathname.startsWith('/@react-refresh') ||
      url.pathname.startsWith('/@fs/') ||
      url.pathname.startsWith('/src/') ||
      url.pathname.startsWith('/node_modules/') ||
      url.pathname.startsWith('/assets/aistudio/'))
  ) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const networkFirst =
        isSameOrigin &&
        (req.mode === 'navigate' || url.pathname.endsWith('/games.json') || url.pathname.endsWith('/index.html'));

      if (cached && !networkFirst) return cached;

      try {
        const response = await fetch(req);
        return await saveResponse(cache, req, response);
      } catch (_) {
        if (cached) return cached;
        if (req.mode === 'navigate') {
          return (
            (await cache.match('./index.html')) ||
            (await cache.match('./standalone.html')) ||
            (await cache.match('./')) ||
            Response.error()
          );
        }
        return Response.error();
      }
    })(),
  );
});
