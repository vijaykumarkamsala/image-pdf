const PRIVATE_CACHE_PREFIX = "ipw-private-";
const productionBuild = (import.meta as ImportMeta & { readonly env?: { readonly PROD?: boolean } }).env?.PROD ?? false;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!productionBuild || !("serviceWorker" in navigator)) return null;
  const controlledAtStart = Boolean(navigator.serviceWorker.controller);
  const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const activateWaiting = () => registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  activateWaiting();
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed") activateWaiting();
    });
  });
  let refreshed = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlledAtStart || refreshed) return;
    refreshed = true;
    window.location.reload();
  });
  await registration.update();
  return registration;
}

export async function clearPrivateCachesOnLogout(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: "CLEAR_PRIVATE_CACHES" });
  if (!("caches" in window)) return;
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(PRIVATE_CACHE_PREFIX)).map((name) => caches.delete(name)));
}
