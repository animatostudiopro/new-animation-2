const CACHE_NAME = 'animato-game-' + Date.now();

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('animato-game-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith('http')) return;

  const isHtml = event.request.mode === 'navigate' || 
                (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html'));
  const isMeta = url.pathname.endsWith('deployment-meta.json') || url.pathname.endsWith('game-data.json');

  // HTML and deployment metadata are ALWAYS Network-First with strict no-store fallback
  if (isHtml || isMeta) {
    const freshUrl = new URL(event.request.url);
    freshUrl.searchParams.set('_upd', Date.now().toString());
    event.respondWith(
      fetch(freshUrl.toString(), { cache: 'no-store' })
        .then((response) => {
          if (response.ok) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, cloned);
            });
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          return new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // Static assets: cache-first with background revalidation
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, cloned);
        });
        return response;
      });
    })
  );
});
