/**
 * The explicit theme choice: System, Light or Dark.
 *
 * The tokens in `globals.css` already support all three — `prefers-color-scheme: dark` unless
 * `[data-theme="light"]`, plus `[data-theme="dark"]` for a pinned dark. All this module does is
 * decide which attribute is on `<html>` and remember the decision.
 *
 * React-free and DOM-guarded on purpose: the same three functions are used by the client component
 * in the header **and** by the tiny blocking script in `<head>` (`themeScript()`), which has to run
 * before the first paint and therefore before any bundle exists. One source for the key, the values
 * and the meaning of each.
 */

export const THEME_CHOICES = ["system", "light", "dark"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

/** `localStorage` key. Per browser, not per household: this is how *you* like to look at it. */
export const THEME_STORAGE_KEY = "vh-theme";

export const DEFAULT_THEME: ThemeChoice = "system";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** What the browser has stored, or `system`. Never throws: private mode can refuse the read. */
export function readStoredTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Put the choice on `<html>`.
 *
 * `system` **removes** the attribute rather than setting a third value, because that is exactly
 * what the token blocks are written against: no attribute means "follow `prefers-color-scheme`".
 * `colorScheme` goes with it so the native form controls, the scrollbars and the canvas's own
 * default background follow too.
 */
export function applyTheme(choice: ThemeChoice): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (choice === "system") {
    delete root.dataset.theme;
    root.style.colorScheme = "";
  } else {
    root.dataset.theme = choice;
    root.style.colorScheme = choice;
  }
}

/** Store the choice. Never throws — a browser that refuses storage still gets the applied theme. */
export function storeTheme(choice: ThemeChoice): void {
  try {
    if (choice === DEFAULT_THEME) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* private mode, or storage disabled: the attribute is still applied for this page */
  }
}

/**
 * The blocking script for `<head>`.
 *
 * It must run before the first paint, so it cannot be a component or an effect: a pinned dark theme
 * applied after hydration is a white flash on every navigation. It is a string rather than a file
 * because that keeps it inline (no extra request on a LAN app that must work offline) and because
 * `next/script` with `beforeInteractive` still does not guarantee "before first paint".
 *
 * Everything is inside one `try`: `localStorage` throws outright in some privacy modes, and a theme
 * preference is not worth a blank page.
 */
export function themeScript(): string {
  return (
    "try{var t=localStorage.getItem(" +
    JSON.stringify(THEME_STORAGE_KEY) +
    ");if(t===\"light\"||t===\"dark\"){document.documentElement.dataset.theme=t;" +
    "document.documentElement.style.colorScheme=t;}}catch(e){}"
  );
}
