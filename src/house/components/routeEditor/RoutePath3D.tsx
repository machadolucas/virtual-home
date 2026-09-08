"use client";
/**
 * The 3D polyline editor — deliberately the *coarse* tool. Handles reuse the placement snapping,
 * so a point lands on a wall or floor face and on the 5 cm grid exactly as a marker would.
 *
 * The precise work happens in the plan and elevation editors, which is why this one is small.
 *
 * Mounted by `HouseWorkspace` whenever a route draft is open. It was written, exported and then
 * never imported, so handles rendered and selected but dragging them in 3D did nothing and the
 * documented Delete-key removal did not exist.
 */
import { useCallback, useEffect } from "react";
import { dragCandidates } from "@/house/scene/picker";
import { resolveSnap } from "@/house/scene/snap";
import { isTypingTarget } from "@/house/hooks/useKeyboardShortcuts";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";

export function RoutePath3D() {
  const runtime = useHouseRuntime();
  const { routeDraft, selectedPointIndex, snap, index, activeFloorId } = useHouseStore(
    useShallow((s) => ({
      routeDraft: s.routeDraft,
      selectedPointIndex: s.selectedPointIndex,
      snap: s.snap,
      index: s.index,
      activeFloorId: s.activeFloorId,
    })),
  );
  const setRoutePoint = useHouseStore((s) => s.setRoutePoint);
  const deleteRoutePoint = useHouseStore((s) => s.deleteRoutePoint);

  const drag = useCallback(
    (event: PointerEvent) => {
      const i = selectedPointIndex;
      if (i === null || !routeDraft || !index) return;
      const el = runtime.canvasEl;
      const picker = runtime.picker;
      const sceneIndex = runtime.index;
      const clip = runtime.clip;
      const camera = runtime.camera3d;
      if (!el || !picker || !sceneIndex || !clip || !camera) return;
      const hit = picker.pick(event.clientX, event.clientY, el.getBoundingClientRect(), camera, sceneIndex, clip, {
        candidates: dragCandidates(sceneIndex, activeFloorId),
      });
      const point = routeDraft.points[i];
      if (!point) return;
      const solution = resolveSnap({
        hit,
        config: snap,
        manifest: index,
        draft: {
          physical: point,
          rotationYDeg: 0,
          mount: { kind: "floor", height: 0 },
          floorId: routeDraft.segments[Math.min(i, routeDraft.segments.length - 1)]?.floorId ?? activeFloorId ?? "",
        },
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        meshOf: (id) => sceneIndex.surfaceMesh.get(id),
        anchorOf: (id) => index.roomAnchors.get(id)?.point,
      });
      setRoutePoint(i, solution.physical);
    },
    [runtime, routeDraft, selectedPointIndex, snap, index, activeFloorId, setRoutePoint],
  );

  useEffect(() => {
    if (!routeDraft || selectedPointIndex === null) return;
    const el = runtime.canvasEl;
    if (!el) return;
    let active = false;

    /**
     * The place tool decides who owns the left button, exactly as it does for equipment.
     *
     * This used to flip `runtime.controls.enabled` inside its own `pointerdown` — too late, since
     * `camera-controls` has already captured the gesture by then, and now also pointless, because
     * the flag is a prop the `Rig` re-applies. Opening a route draft switches to the place tool,
     * so the camera is already off before the pointer goes down.
     */
    const placing = () => {
      const s = runtime.store.getState();
      return s.tool === "place" && !s.cameraOverride;
    };

    const onDown = () => {
      if (!placing()) return;
      active = true;
    };
    const onMove = (event: PointerEvent) => {
      if (active) drag(event);
    };
    const onUp = () => {
      active = false;
    };
    const onKey = (event: KeyboardEvent) => {
      // A window-level Delete must not eat a keystroke meant for a field — the route panel is full
      // of them.
      if (isTypingTarget(event.target)) return;
      if (event.key === "Delete" && selectedPointIndex !== null) deleteRoutePoint(selectedPointIndex);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [runtime, routeDraft, selectedPointIndex, drag, deleteRoutePoint]);

  return null;
}
