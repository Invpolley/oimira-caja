// Service Worker para OiMira Caja — cache + offline support
const CACHE_NAME = "oimira-caja-v22";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://cdn.tailwindcss.com",
  "https://esm.sh/@supabase/supabase-js@2",
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

// Strategy: network-first para API (supabase), cache-first para assets estáticos
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
  e.respondWith(
    fetch(e.request).then(r => {
      if (r && r.ok) { const cp = r.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, cp)); }
      return r;
    }).catch(() => caches.match(e.request).then(c => c || (e.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
