// Bump this on every deploy that changes SW strategy so old SWs purge.
const CACHE_NAME = 'trip-planner-v3';

// We deliberately do NOT precache HTML. Next.js ships hashed bundles and the
// HTML shell references them by hash; caching stale HTML makes the app point
// at JS/CSS URLs that no longer exist, which is exactly the "goes stale on
// hard refresh" symptom. So: network-first for navigations, cache-first only
// for immutable hashed static assets.

self.addEventListener('install', (event) => {
  // Activate this SW immediately; don't wait for all tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Nuke every old cache from earlier SW versions.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Message hook so the page can force the SW to skip waiting on a new deploy.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isNavigationRequest(req) {
  return (
    req.mode === 'navigate' ||
    (req.method === 'GET' && req.headers.get('accept')?.includes('text/html'))
  );
}

function isImmutableAsset(url) {
  // Next.js serves hashed, content-addressed bundles under /_next/static/
  // and those are safe to cache forever.
  return url.pathname.startsWith('/_next/static/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // We only handle GETs — never touch POST/PUT/DELETE.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only cache same-origin. Don't intercept cross-origin (Google Maps,
  // fonts.googleapis.com, cdnjs, etc.) so those use the browser's normal
  // HTTP cache and don't get stuck behind a stale SW.
  if (url.origin !== self.location.origin) return;

  // Never cache API responses through the SW — let fetch hit the network
  // and let the app handle offline itself.
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML navigations so a deploy lands on next refresh.
  if (isNavigationRequest(req)) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          return fresh;
        } catch {
          const cached = await caches.match(req);
          if (cached) return cached;
          // Last-ditch offline fallback
          const fallback = await caches.match('/');
          if (fallback) return fallback;
          throw new Error('offline');
        }
      })()
    );
    return;
  }

  // Cache-first for hashed immutable assets.
  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
        }
        return fresh;
      })()
    );
    return;
  }

  // Everything else (manifest.json, icons, etc.): stale-while-revalidate.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
