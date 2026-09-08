"use client";

/**
 * The theme choice, as an external store — same shape and same reason as `sidebarStore.ts`.
 *
 * `localStorage` is the "external system" `useSyncExternalStore` exists for: the server cannot see
 * it, so hydration renders `system` and React swaps in the stored value immediately afterwards with
 * no cascading render. There is no flash, because the inline script in `<head>`
 * (`theme.ts`'s `themeScript()`) has already put the attribute on `<html>` before the first paint —
 * this store only decides which segment of the control looks pressed.
 *
 * The `storage` event keeps two open tabs in agreement, which matters here: a household member with
 * the House page open on one screen and Settings on another should not see two different themes.
 */
import {
  applyTheme,
  readStoredTheme,
  storeTheme,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "./theme";

let cached: ThemeChoice | null = null;
const listeners = new Set<() => void>();

/** Must be referentially stable between renders — a string literal always is. */
export function getTheme(): ThemeChoice {
  if (cached === null) cached = readStoredTheme();
  return cached;
}

/** The server never knows the preference; the control renders "System" until hydration. */
export function getThemeServer(): ThemeChoice {
  return DEFAULT_THEME;
}

export function subscribeTheme(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    cached = readStoredTheme();
    // Another tab changed it: apply here too, or the two tabs disagree.
    applyTheme(cached);
    for (const listener of listeners) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setTheme(choice: ThemeChoice): void {
  if (cached === choice) return;
  cached = choice;
  applyTheme(choice);
  storeTheme(choice);
  for (const listener of listeners) listener();
}
