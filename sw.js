// Service Worker para OiMira Caja — cache + offline + resiliente a caídas del hosting (PROTOCOLO PWA RESILIENTE 2026-09-13)
// ⚠ Subir SW_VERSION en CADA despliegue. Si este archivo no cambia,
// el navegador no detecta versión nueva y los celulares quedan pegados.
const SW_VERSION = "2026-09-13.1";
const CACHE_NAME = "oimira-caja-" + SW_VERSION;
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(err => {
      console.warn("SW install: algunos assets fallaron al cachear:", err);
    })).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Datos de Supabase: siempre a la red. "?ping=": chequeo de salud, llega crudo al hosting.
// CDNs: cache-first (no cambian). Archivos propios: NETWORK-FIRST, pero un 5xx/403 del hosting
// NUNCA se guarda ni se muestra si hay copia (así un 502 del hosting no tumba la app).
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.hostname.endsWith(".supabase.co")) return;
  if (url.searchParams.has("ping")) return;
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        if (r && (r.ok || r.type === "opaque")) { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); }
        return r;
      }))
    );
    return;
  }
  const esNavegacion = e.request.mode === "navigate";
  const pedido = esNavegacion
    ? fetch(e.request)
    : fetch(new Request(e.request.url, { cache: "no-store", credentials: "same-origin" }));
  e.respondWith(
    pedido.then(r => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); return r; }
      return caches.match(e.request).then(c => c || (esNavegacion ? caches.match("./index.html") : null) || r);
    }).catch(() => caches.match(e.request).then(c => c || (esNavegacion ? caches.match("./index.html") : undefined)))
  );
});

// La app puede preguntar qué versión corre y forzar la activación inmediata.
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
  if (e.data === "VERSION" && e.source) e.source.postMessage({ swVersion: SW_VERSION });
});
