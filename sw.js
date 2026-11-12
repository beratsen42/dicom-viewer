// Offline cache for the app shell. Bump VERSION on every release.
const VERSION = 'v1';
const CACHE = `dicom-viewer-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/dicom.js',
  'js/decode.js',
  'js/store.js',
  'js/viewport.js',
  'vendor/dicomParser.min.js',
  'vendor/jszip.min.js',
  'vendor/jpeg-baseline.js',
  'vendor/jpeg-lossless.js',
  'vendor/openjpegwasm_decode.js',
  'vendor/openjpegwasm_decode.wasm',
  'vendor/charlswasm_decode.js',
  'vendor/charlswasm_decode.wasm',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive), cache as offline fallback.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
