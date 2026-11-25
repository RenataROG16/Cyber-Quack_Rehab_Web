// Service worker de Cyber Quack Rehab
// Cambia la versión cada vez que subas cambios, para que la app se actualice.
const CACHE = "quack-rehab-v10";

const ARCHIVOS = [
  "./",
  "./index.html",
  "./reset.html",
  "./manifest.json",
  "./css/estilos.css",
  "./js/auth.js",
  "./js/supabaseClient.js",
  "./js/sensorEmg.js",
  "./physio/dashboard.html",
  "./patient/sesion.html",
  "./patient/juego.html",
  "./patient/assets/pato-reposo.svg",
  "./patient/assets/pato-salto.svg",
  "./patient/assets/pato-celebra.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon-180.png"
];

// Instalar: guarda los archivos (si alguno falla, no rompe la instalación)
self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.all(ARCHIVOS.map((url) => c.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

// Activar: borra versiones viejas del caché
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Peticiones: primero internet (datos siempre frescos), y si no hay conexión usa el caché.
// Supabase y las librerías de CDN NO se tocan: siempre van directo a internet.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copia));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
