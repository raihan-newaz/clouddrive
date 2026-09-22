const CACHE_NAME = 'clouddrive-v56';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/share.html',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-180.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable.png',
  '/icons/icon.svg',
  '/css/themes.css',
  '/css/styles.css',
  '/css/responsive.css',
  '/js/api.js',
  '/js/ui.js',
  '/js/upload.js',
  '/js/preview.js',
  '/js/setup.js',
  '/js/pwa.js',
  '/js/app.js'
];

// Install Event: Pre-cache core application shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: Clear older caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: Smart routing & caching
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Bypass non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // 2. Bypass backend API, WebDAV, and dynamic file streaming routes
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webdav/')) {
    return;
  }

  // 3. HTML Navigation requests (Network-first with offline SPA fallback)
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(async () => {
          const cachedResponse = await caches.match(event.request, { ignoreSearch: true });
          if (cachedResponse) return cachedResponse;
          if (url.pathname.startsWith('/share')) {
            return caches.match('/share.html');
          }
          return caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }

  // 4. Static assets (CSS, JS, Images, Fonts) - Network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

// Message Event: Allow manual skipWaiting trigger
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

