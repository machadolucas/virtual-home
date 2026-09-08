/**
 * The viewer's own chrome colours, resolved from the live design tokens.
 *
 * Everything the *scene* draws that is not the house itself — the selection tint and its outline,
 * the equipment marker dots, the snap indicator, the route point handles, the hue-neutral "planned"
 * route — used to be baked-in hex literals chosen against a pale background. They are now read from
 * the `--vh-*` custom properties on `<html>`, so they re-tint with the theme exactly like every
 * Tailwind utility does.
 *
 * What is **not** here, deliberately:
 *  - **surface colours and architectural edges.** Those come from the model package's own materials
 *    (`surface.defaultColor`) and from the household's saved overrides. They are the house, not the
 *    chrome, and `NoToneMapping` exists precisely so a saved hex renders literally. A theme must
 *    never move them.
 *  - **`SYSTEM_COLORS`.** The seven route hues are colour-blind-safe *identity* — "the blue line is
 *    water" — drawn against the model rather than against the background, and the token ramp has no
 *    per-system hue to map them onto. They stay literal; `routes.ts` documents that.
 *
 * SSR and unit tests have no `document`, so every read falls back to `PALETTE_FALLBACK`, which holds
 * the values the viewer shipped with. Nothing here throws and nothing here needs a browser.
 */

/** The HA state classes a marker instance can carry (`store/haStore.ts`'s `StateClass` + battery). */
export type MarkerStateClass =
  | "live"
  | "unavailable"
  | "unknown"
  | "stale"
  | "low"
  | "critical"
  | "unlinked"
  | "disconnected"
  | "selected";

export interface ViewerPalette {
  /** Emissive tint added to a selected surface's material. */
  selectEmissive: number;
  /** Emissive tint for the hovered surface (weaker intensity, same hue). */
  hoverEmissive: number;
  /**
   * The reused `LineSegments` outline that makes a selected thin wall face readable from an
   * oblique angle — the non-colour half of the selection signal.
   */
  selectOutline: number;
  /** Equipment marker instance colours, by state class. */
  marker: Record<MarkerStateClass, number>;
  /** The snap grid patch, the wall-frame outline and the snapped-point ring. */
  snap: number;
  /** A planned route: hue-neutral on purpose, so a plan never reads as an installation. */
  routePlanned: number;
  /** The route point handle the editor has selected. */
  routeSelectedPoint: number;
}

/**
 * The values the viewer used before the tokens existed. Used verbatim under SSR and in unit tests,
 * so a test asserting on a scene colour does not need a stylesheet.
 */
export const PALETTE_FALLBACK: ViewerPalette = {
  selectEmissive: 0x2f6fd0,
  hoverEmissive: 0x2f6fd0,
  selectOutline: 0x14304f,
  marker: {
    live: 0x2f7d4f,
    unavailable: 0x9a9a95,
    unknown: 0x9a9a95,
    stale: 0xb08420,
    low: 0xc0562a,
    critical: 0xb02a2a,
    unlinked: 0x6a6a66,
    disconnected: 0x8b8b87,
    selected: 0x2f6fd0,
  },
  snap: 0x2f6fd0,
  routePlanned: 0x8a8f96,
  routeSelectedPoint: 0x2f6fd0,
};

/** Which custom property each field comes from. One table, so the mapping is reviewable. */
const SOURCE = {
  selectEmissive: "--vh-accent",
  hoverEmissive: "--vh-accent",
  // The ring token, not the accent: an outline has to separate from the model in *both* modes, and
  // `--vh-ring` is the one accent-family value that lightens in dark mode.
  selectOutline: "--vh-ring",
  snap: "--vh-accent",
  routePlanned: "--vh-unknown",
  routeSelectedPoint: "--vh-accent",
} as const;

const MARKER_SOURCE: Record<MarkerStateClass, string> = {
  live: "--vh-ok",
  unavailable: "--vh-unknown",
  unknown: "--vh-unknown",
  stale: "--vh-stale",
  low: "--vh-due",
  critical: "--vh-overdue",
  unlinked: "--vh-unknown",
  disconnected: "--vh-ink-3",
  selected: "--vh-accent",
};

/**
 * Read the palette from the live custom properties on `<html>`.
 *
 * Any property that is missing, empty or not a hex colour keeps its fallback, so a half-loaded
 * stylesheet degrades to the shipped values rather than to black.
 */
export function readViewerPalette(): ViewerPalette {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function")
    return clone(PALETTE_FALLBACK);

  const style = getComputedStyle(document.documentElement);
  const read = (property: string, fallback: number): number =>
    parseHex(style.getPropertyValue(property)) ?? fallback;

  const marker = {} as Record<MarkerStateClass, number>;
  for (const [key, property] of Object.entries(MARKER_SOURCE) as Array<[MarkerStateClass, string]>)
    marker[key] = read(property, PALETTE_FALLBACK.marker[key]);

  return {
    selectEmissive: read(SOURCE.selectEmissive, PALETTE_FALLBACK.selectEmissive),
    hoverEmissive: read(SOURCE.hoverEmissive, PALETTE_FALLBACK.hoverEmissive),
    selectOutline: read(SOURCE.selectOutline, PALETTE_FALLBACK.selectOutline),
    marker,
    snap: read(SOURCE.snap, PALETTE_FALLBACK.snap),
    routePlanned: read(SOURCE.routePlanned, PALETTE_FALLBACK.routePlanned),
    routeSelectedPoint: read(SOURCE.routeSelectedPoint, PALETTE_FALLBACK.routeSelectedPoint),
  };
}

/**
 * `#rgb` / `#rrggbb` → `0xrrggbb`, or `null` for anything else.
 *
 * Deliberately narrow: the ramp is authored as hex in `globals.css`, and silently mis-parsing an
 * `oklch()` or a `color-mix()` into a number would be worse than keeping the fallback.
 */
export function parseHex(value: string): number | null {
  const text = value.trim();
  if (!text.startsWith("#")) return null;
  const body = text.slice(1);
  if (body.length === 3) {
    const expanded = [...body].map((c) => c + c).join("");
    return /^[0-9a-fA-F]{6}$/.test(expanded) ? Number.parseInt(expanded, 16) : null;
  }
  if (body.length === 6 && /^[0-9a-fA-F]{6}$/.test(body)) return Number.parseInt(body, 16);
  return null;
}

// ---------------------------------------------------------------------------
// the module-level current palette
// ---------------------------------------------------------------------------

let current: ViewerPalette = clone(PALETTE_FALLBACK);

/**
 * The palette the imperative scene layers read.
 *
 * A module-level value rather than a constructor argument: `Highlighter`, `MarkerLayer` and
 * `RouteLayer` are built once per package load and live for the whole session, while the theme can
 * change at any moment. One setter plus one re-apply is less machinery — and fewer stale copies —
 * than threading the palette through three constructors and every call site.
 */
export function getViewerPalette(): ViewerPalette {
  return current;
}

/**
 * Replace the current palette. Returns true when anything actually changed.
 *
 * The stored object's identity changes **only** on a real change, which is what makes
 * `getViewerPalette` a valid `useSyncExternalStore` snapshot.
 */
export function setViewerPalette(next: ViewerPalette): boolean {
  if (samePalette(current, next)) return false;
  current = next;
  for (const listener of listeners) listener();
  return true;
}

const listeners = new Set<() => void>();

/**
 * Notified when the palette actually changes. Kept React-free on purpose (the worker and the unit
 * tests import this module); `hooks/useViewerPalette.ts` is the React face of it.
 */
export function onPaletteChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-read from the DOM and store it. Returns true when anything actually changed. */
export function refreshViewerPalette(): boolean {
  return setViewerPalette(readViewerPalette());
}

/** Test seam: put the palette back to the shipped values. */
export function resetViewerPalette(): void {
  setViewerPalette(clone(PALETTE_FALLBACK));
}

// ---------------------------------------------------------------------------
// watching for a theme change
// ---------------------------------------------------------------------------

/**
 * Call `cb` whenever the resolved theme could have changed: the system preference flipped, or the
 * explicit `data-theme` attribute on `<html>` was set, changed or removed.
 *
 * The callback fires on the *event*, not on a diff — the caller re-reads and decides whether
 * anything moved (`refreshViewerPalette()` returns that), which keeps `invalidate()` to one call
 * per real change.
 */
export function subscribeToPalette(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};

  const query =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  query?.addEventListener("change", cb);

  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(() => cb())
      : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  return () => {
    query?.removeEventListener("change", cb);
    observer?.disconnect();
  };
}

// ---------------------------------------------------------------------------

function clone(palette: ViewerPalette): ViewerPalette {
  return { ...palette, marker: { ...palette.marker } };
}

function samePalette(a: ViewerPalette, b: ViewerPalette): boolean {
  if (
    a.selectEmissive !== b.selectEmissive ||
    a.hoverEmissive !== b.hoverEmissive ||
    a.selectOutline !== b.selectOutline ||
    a.snap !== b.snap ||
    a.routePlanned !== b.routePlanned ||
    a.routeSelectedPoint !== b.routeSelectedPoint
  )
    return false;
  for (const key of Object.keys(a.marker) as MarkerStateClass[])
    if (a.marker[key] !== b.marker[key]) return false;
  return true;
}
