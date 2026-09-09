const PUBLIC_CACHE = "vh-public-shell-v1";
const OFFLINE_URL = "/offline.html";

// This list is deliberately limited to public, household-neutral files. Authenticated HTML, RSC
// payloads, APIs, model assets and Home Assistant data must never enter the service-worker cache.
const PUBLIC_SHELL = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/house.svg",
  "/icons/icon-192-v2.png",
  "/icons/icon-512-v2.png",
  "/icons/icon-maskable-512-v2.png",
  "/icons/apple-touch-icon-v2.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PUBLIC_CACHE)
      .then((cache) => cache.addAll(PUBLIC_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("vh-public-shell-") && name !== PUBLIC_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isPublicStaticPath(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === OFFLINE_URL
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations always go to the server so sessions and per-user HTML remain authoritative. The
  // neutral offline document is used only when there is no response at all.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const offline = await caches.match(OFFLINE_URL);
        return (
          offline ??
          new Response("Connection required. Reconnect to the home server and try again.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          })
        );
      }),
    );
    return;
  }

  // Hashed Next build assets and public app artwork contain no household data. All other requests
  // stay network-only, including APIs, RSC payloads, model files and writes.
  if (!isPublicStaticPath(url.pathname)) return;

  event.respondWith(
    caches.open(PUBLIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    }),
  );
});
