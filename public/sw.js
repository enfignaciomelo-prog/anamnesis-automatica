/*
 * Service worker de Anamnesis Automática.
 * Guarda SOLO la estructura de la aplicación (HTML, JS, CSS, íconos).
 * Nunca guarda respuestas de /api: ahí viajan los datos clínicos.
 * Precarga todos los archivos de la compilación para que la app abra sin
 * conexión (modo manual: los borradores viven cifrados en IndexedDB, no aquí).
 */
const VERSION = "__BUILD_VERSION__";
const CACHE = `aa-shell-${VERSION}`;
const ASSETS = [/*__ASSETS__*/];
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/apple-touch-icon.png", ...ASSETS];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isClinical(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Datos clínicos, otros orígenes o métodos que no son GET: directo a la red, sin caché.
  if (req.method !== "GET" || url.origin !== self.location.origin || isClinical(url)) return;

  if (req.mode === "navigate") {
    // Red primero; sin conexión se muestra la estructura guardada.
    event.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
