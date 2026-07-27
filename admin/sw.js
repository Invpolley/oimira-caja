// Service Worker para OiMira Admin — cache + offline support
// ⚠ Subir SW_VERSION en CADA despliegue. Si este archivo no cambia,
// el navegador no detecta versión nueva y los celulares quedan pegados.
const SW_VERSION = "2026-07-27.3";
const CACHE_NAME = "oimira-admin-" + SW_VERSION;
// Solo archivos propios. Los CDN se cachean solos cuando se piden:
// precargarlos acá hacía lenta la instalación y demoraba la actualización.
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
    }))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Network-first para API (Supabase), cache-first para assets
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Datos de Supabase: siempre a la red, sin interceptar
  if (url.hostname.endsWith(".supabase.co")) return;
  // CDNs (otro origen, no cambian): cache-first
  if (url.origin !== location.origin) {
    e.respondWith(
      caches.match(e.request).then(c => c || fetch(e.request).then(r => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); }
        return r;
      }))
    );
    return;
  }
  // Archivos propios (index.html, app.js, config.js...): NETWORK-FIRST.
  // Trae siempre lo más nuevo; cae al caché solo si no hay conexión.
  // OJO: a una petición de navegación NO se le puede cambiar el modo de caché
  // (fetch(request, {cache:...}) tira TypeError y la página queda en blanco).
  // Por eso el no-store se aplica solo a los archivos, no a la navegación.
  const esNavegacion = e.request.mode === "navigate";
  const pedido = esNavegacion
    ? fetch(e.request)
    : fetch(new Request(e.request.url, { cache: "no-store", credentials: "same-origin" }));

  e.respondWith(
    pedido.then(r => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request).then(c => c || (esNavegacion ? caches.match("./index.html") : undefined)))
  );
});

// La app puede preguntar qué versión corre y forzar la activación inmediata.
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
  if (e.data === "VERSION" && e.source) e.source.postMessage({ swVersion: SW_VERSION });
});
