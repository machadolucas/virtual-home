"use client";

/**
 * The sidebar rail preference, as an external store rather than state seeded
 * from an effect.
 *
 * `localStorage` is exactly the "external system" `useSyncExternalStore` is
 * for: the server has no access to it, so hydration renders the expanded
 * default and React swaps in the stored value immediately afterwards, without
 * a cascading render. The `storage` event keeps two open tabs in agreement.
 */
const STORAGE_KEY = "vh.sidebar.collapsed";

let cached: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false; // private mode, or storage disabled
  }
}

/** Must be referentially stable between renders — a boolean always is. */
export function getSidebarCollapsed(): boolean {
  if (cached === null) cached = read();
  return cached;
}

/** The server never knows the preference; the rail starts expanded. */
export function getSidebarCollapsedServer(): boolean {
  return false;
}

export function subscribeSidebar(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    cached = read();
    for (const listener of listeners) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setSidebarCollapsed(collapsed: boolean): void {
  if (cached === collapsed) return;
  cached = collapsed;
  try {
    window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* the preference simply does not persist */
  }
  for (const listener of listeners) listener();
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsed(!getSidebarCollapsed());
}
