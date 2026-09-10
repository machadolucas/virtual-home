"use client";
/**
 * Keeps the scene's chrome colours in step with the theme.
 *
 * The DOM needs no help — a Tailwind utility resolves `var(--vh-*)` at paint time, so the panels,
 * the tree and the chips re-tint themselves. The scene does: three holds its colours as numbers
 * inside long-lived materials and instance attributes, so a theme change has to be pushed in.
 *
 * One theme change ⇒ one re-read, one re-apply, **one** `invalidate()`. `refreshViewerPalette()`
 * reports whether anything actually moved, so pinning "Dark" while the system was already dark
 * costs nothing and never wakes the GPU.
 *
 * The three palette-dependent layers are re-applied here in the same shape `useSceneSync` applies
 * them, from the store's current state — a full re-resolve, not a diff, for the reason recorded at
 * the top of that file.
 */
import { useEffect } from "react";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type { Placement } from "@/house/model/types";
import { highlightTargets } from "@/house/scene/highlight";
import { refreshViewerPalette, subscribeToPalette } from "@/house/scene/palette";
import { haStore, markerStateKey } from "@/house/store/haStore";
import { isRunVisibleOn } from "@/features/projects/renovationDate";
import type { HouseRuntime } from "@/house/runtime";
import { useHouseRuntime } from "./useHouseStore";

/**
 * Subscribe to theme changes and re-push the palette into the scene.
 *
 * The React-rendered parts of the scene (the snap indicator, the route point handles) do not need a
 * signal from here — they read through `useViewerPalette()`, which is driven by the same module's
 * listener set.
 */
export function usePaletteSync(): void {
  const runtime = useHouseRuntime();

  useEffect(() => {
    // First read on mount: until a document exists the module serves the shipped literals, and by
    // now one does. No `invalidate()` here — the scene has not drawn yet.
    refreshViewerPalette();

    return subscribeToPalette(() => {
      if (!refreshViewerPalette()) return;
      reapply(runtime);
      runtime.invalidate();
    });
  }, [runtime]);
}

/** Re-tint the selection, the markers and the routes from the palette that is now current. */
function reapply(runtime: HouseRuntime): void {
  const index = runtime.index;
  const clip = runtime.clip;
  const manifest = runtime.manifest;
  const s = runtime.store.getState();

  if (index && clip && runtime.highlighter) {
    runtime.highlighter.refreshPalette();
    const selected = highlightTargets(index, s.selection);
    const hovered = highlightTargets(index, s.hover);
    runtime.highlighter.set(index, clip, selected.ids, hovered.primary, {
      intensity: selected.intensity,
      primary: selected.primary,
    });
  }

  if (index && manifest && runtime.markers) {
    const ha = haStore.getState();
    const now = Date.now();
    const groupOf = (p: Placement) =>
      p.surfaceId ? clipGroupOf(manifest, p.surfaceId) : p.floorId;
    const stateOf = (p: Placement) =>
      p.entityId ? markerStateKey(ha.entities[p.entityId], ha.connection, now) : "unlinked";
    runtime.markers.set(s.placements, stateOf, groupOf);
  }

  if (index && runtime.routes) {
    const visible = s.layers.routes
      ? s.routes.filter(
          (r) =>
            r.id !== s.routeDraft?.id &&
            s.visibleSystems[r.system] &&
            s.visibleRouteKinds[r.kind] &&
            isRunVisibleOn(r, s.renovationDate),
        )
      : [];
    runtime.routes.set(visible, { tubes: !s.performanceMode });
  }
}
