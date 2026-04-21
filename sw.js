// Service Worker para OiMira Caja — cache + offline support
const CACHE_NAME = "oimira-caja-v8";
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

  // Peticiones a Supabase siempre van a la red (no cachear datos)
  if (url.hostname.endsWith(".supabase.co")) {
    return; // fetch normal, sin interceptar
  }

  // Resto: cache-first
  e.respondWith(
    caches.match(e.request).then(cached => {
      return cached || fetch(e.request).then(resp => {
        // Cachear el fetch nuevo para futuras visitas
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => {
        // Si offline y no cacheado, retornar index para SPA
        if (e.request.mode === "navigate") return caches.match("./index.html");
      });
    })
  );
});
