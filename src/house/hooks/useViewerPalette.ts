"use client";
/**
 * The React face of `scene/palette.ts`.
 *
 * `getViewerPalette()` returns a stable object between real changes, so this is a plain
 * `useSyncExternalStore` — the React-rendered parts of the scene (the snap indicator, the route
 * point handles) re-render on a theme change and nothing else does.
 */
import { useSyncExternalStore } from "react";
import { getViewerPalette, onPaletteChange, type ViewerPalette } from "@/house/scene/palette";

export function useViewerPalette(): ViewerPalette {
  return useSyncExternalStore(onPaletteChange, getViewerPalette, getViewerPalette);
}
