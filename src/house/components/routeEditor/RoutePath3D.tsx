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
import { useEffect } from "react";
import { CLICK_SLOP_MOUSE, dragCandidates } from "@/house/scene/picker";
import { resolveSnap } from "@/house/scene/snap";
import { routePointPlace } from "@/house/model/routePlaces";
import { isTypingTarget } from "@/house/hooks/useKeyboardShortcuts";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";

export function RoutePath3D() {
  const runtime = useHouseRuntime();
  const routeDraft = useHouseStore((s) => s.routeDraft);
  const routeDraftId = routeDraft?.id ?? null;
  const setRoutePoint = useHouseStore((s) => s.setRoutePoint);
  const deleteRoutePoint = useHouseStore((s) => s.deleteRoutePoint);
  const insertRoutePoint = useHouseStore((s) => s.insertRoutePoint);
  const setRoutePointPlace = useHouseStore((s) => s.setRoutePointPlace);
  const setRouteDraftHover = useHouseStore((s) => s.setRouteDraftHover);

  useEffect(() => {
    if (!routeDraftId) return;
    const el = runtime.canvasEl;
    if (!el) return;
    let down: { x: number; y: number } | null = null;
    let dragging = false;

    const pointAt = (event: PointerEvent, pointIndex: number) => {
      const state = runtime.store.getState();
      const draft = state.routeDraft;
      const index = state.index;
      if (!draft || !index) return null;
      const el = runtime.canvasEl;
      const picker = runtime.picker;
      const sceneIndex = runtime.index;
      const clip = runtime.clip;
      const camera = runtime.camera3d;
      if (!el || !picker || !sceneIndex || !clip || !camera) return null;
      const hit = picker.pick(event.clientX, event.clientY, el.getBoundingClientRect(), camera, sceneIndex, clip, {
        // Route drawing is deliberately multi-floor. Floor isolation is cleared when editing
        // begins, and the picker must retain the same all-floor candidate set.
        candidates: dragCandidates(sceneIndex, null),
      });
      if (!hit) return null;
      const point = draft.points[pointIndex];
      if (!point) return null;
      const floorId = routePointPlace(draft, pointIndex).floorId ?? index.floorOrder[0];
      if (!floorId) return null;
      const solution = resolveSnap({
        hit,
        config: state.snap,
        manifest: index,
        draft: {
          physical: point,
          rotationYDeg: 0,
          mount: { kind: "floor", height: 0 },
          floorId,
        },
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        meshOf: (id) => sceneIndex.surfaceMesh.get(id),
        anchorOf: (id) => index.roomAnchors.get(id)?.point,
      });
      return solution;
    };

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

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !placing()) return;
      down = { x: event.clientX, y: event.clientY };
      dragging = false;
    };
    const onMove = (event: PointerEvent) => {
      if (!placing()) {
        down = null;
        dragging = false;
        setRouteDraftHover(null);
        return;
      }
      const currentDraft = runtime.store.getState().routeDraft;
      const selected = runtime.store.getState().selectedPointIndex;
      if (selected === null || !currentDraft) return;
      if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_SLOP_MOUSE)
        dragging = true;
      const solution = pointAt(event, dragging ? selected : currentDraft.points.length - 1);
      if (!solution) {
        if (!dragging) setRouteDraftHover(null);
        return;
      }
      if (dragging) {
        setRoutePoint(selected, solution.physical);
        setRoutePointPlace(selected, { floorId: solution.floorId, roomId: solution.roomId });
      } else {
        setRouteDraftHover({
          point: solution.physical,
          floorId: solution.floorId,
          roomId: solution.roomId,
        });
      }
    };
    const onUp = () => {
      if (down && !dragging) {
        const hover = runtime.store.getState().routeDraftHover;
        if (hover) {
          const nextIndex = runtime.store.getState().routeDraft?.points.length ?? 0;
          insertRoutePoint(nextIndex, hover.point, hover);
          runtime.store.getState().selectPoint(nextIndex);
          setRouteDraftHover(null);
        }
      }
      down = null;
      dragging = false;
    };
    const onLeave = () => {
      down = null;
      dragging = false;
      setRouteDraftHover(null);
    };
    const onKey = (event: KeyboardEvent) => {
      // A window-level Delete must not eat a keystroke meant for a field — the route panel is full
      // of them.
      if (isTypingTarget(event.target)) return;
      const selected = runtime.store.getState().selectedPointIndex;
      if (event.key === "Delete" && selected !== null) deleteRoutePoint(selected);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
    };
  }, [runtime, routeDraftId, deleteRoutePoint, insertRoutePoint, setRoutePoint, setRoutePointPlace, setRouteDraftHover]);

  return null;
}
