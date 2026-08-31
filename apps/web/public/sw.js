const SHELL_CACHE = "ipw-shell-2c-v2";
const PRIVATE_CACHE_PREFIX = "ipw-private-";
const SHELL_FILES = ["/", "/offline.html", "/offline.css", "/manifest.webmanifest", "/icons/app-icon.svg", "/icons/app-icon-maskable.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((names) => Promise.all(
    names.filter((name) => (
      (name.startsWith("ipw-shell-") && name !== SHELL_CACHE) || name.startsWith(PRIVATE_CACHE_PREFIX)
    )).map((name) => caches.delete(name)),
  )).then(() => self.clients.claim()));
});

function isProtected(request, url) {
  if (request.method !== "GET" || request.headers.has("authorization")) return true;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/uploads/")) return true;
  return [...url.searchParams.keys()].some((key) => /signature|credential|token|x-goog/i.test(key));
}

function isStaticAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")
    || url.pathname === "/manifest.webmanifest" || url.pathname === "/favicon.svg" || url.pathname === "/offline.css"
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (isProtected(event.request, url)) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
    return;
  }
  if (!isStaticAsset(url)) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "GET_VERSION") event.ports[0]?.postMessage({ version: SHELL_CACHE });
  if (event.data?.type === "CLEAR_PRIVATE_CACHES") {
    event.waitUntil(caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith(PRIVATE_CACHE_PREFIX)).map((name) => caches.delete(name)),
    )));
  }
});
