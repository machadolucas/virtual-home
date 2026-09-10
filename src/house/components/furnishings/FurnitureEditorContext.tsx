"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Furnishing, FurnishingKind } from "../../model/types";
import { FURNISHING_CATALOG } from "../../model/furnishingCatalog";
import { roomAt } from "../../model/manifestIndex";
import { clearFurnishingCollisionCache, furnishingPlacementError, roundedPosition } from "../../scene/furnishingPlacement";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";
import { setPanelCollapsed } from "../../hooks/usePanelLayout";
import { initialPosition } from "../edit/startPlacement";
import { useFurnishings } from "./FurnishingsProvider";
import { snapValue } from "../../model/geometry2d";
import { intersectHorizontalPlane } from "../../scene/picker";
import { pickObjectSupport, placementYaw } from "../../scene/objectPlacement";
import type { HouseStore } from "../../store/createHouseStore";

interface Editor {
  draft: Furnishing | null;
  placing: boolean;
  error: string | null;
  previewInvalid: boolean;
  catalogOpen: boolean;
  setCatalogOpen(open: boolean): void;
  begin(kind: FurnishingKind): void;
  change(draft: Furnishing): void;
  reposition(): void;
  cancel(): void;
  save(): void;
}
const Context = createContext<Editor | null>(null);
export const useFurnitureEditor = () => {
  const value = useContext(Context);
  if (!value) throw new Error("Missing furniture editor provider");
  return value;
};

export function FurnitureEditorProvider({ children }: { children: React.ReactNode }) {
  const runtime = useHouseRuntime();
  const { items, busy, save, setPreview, registerEditHandler } = useFurnishings();
  const index = useHouseStore((s) => s.index);
  const [draft, setDraft] = useState<Furnishing | null>(null);
  const [hover, setHover] = useState<Furnishing | null>(null);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const original = useRef<{ explode: HouseStore["explode"]; tool: HouseStore["tool"] } | null>(null);
  const previewInvalid = !!((hover ?? draft) && runtime.index && furnishingPlacementError((hover ?? draft)!, runtime.index));

  const restore = useCallback(() => {
    const state = runtime.store.getState();
    if (original.current) {
      state.setExplode({ locked: false, gap: 0 });
      state.setExplode(original.current.explode);
      state.setTool(original.current.tool);
      original.current = null;
    }
    state.setFurnishingsEditing(false);
    setPreview(null);
  }, [runtime, setPreview]);
  const cancel = useCallback(() => {
    if (busy) return;
    setDraft(null); setHover(null); setPlacing(false); setError(null); restore();
  }, [busy, restore]);

  const start = useCallback((item: Furnishing, moving: boolean) => {
    const state = runtime.store.getState();
    if (busy || draft || state.editing || state.routeDraft) { setError("Finish or cancel the current edit first."); return; }
    original.current = { explode: { ...state.explode }, tool: state.tool };
    state.setFurnishingsEditing(true);
    state.setExplode({ enabled: false, gap: 0, locked: true });
    state.setLayer("furnishings", true);
    state.setTool(moving ? "place" : "select");
    if (runtime.index) clearFurnishingCollisionCache(runtime.index);
    setDraft(item); setHover(null); setPlacing(moving); setError(null); setCatalogOpen(false);
    setPanelCollapsed("inspector", false);
  }, [busy, draft, runtime]);

  const begin = (kind: FurnishingKind) => {
    if (!index) return;
    const state = runtime.store.getState();
    const selectedFloor = state.selection?.kind === "room" ? index.rooms.get(state.selection.id)?.floorId : state.selection?.kind === "floor" ? state.selection.id : null;
    const floorId = state.activeFloorId ?? selectedFloor ?? index.floorOrder[0];
    if (!floorId) return;
    const option = FURNISHING_CATALOG.find((item) => item.kind === kind)!;
    const initial = initialPosition(runtime, floorId);
    start({ id: "", modelId: index.modelId, kind, name: option.label, floorId, roomId: initial.roomId,
      position: roundedPosition(initial.position), rotationYDeg: 0, widthM: option.size[0], depthM: option.size[1], heightM: option.size[2] }, true);
  };
  useEffect(() => {
    registerEditHandler((id) => { const item = items.find((x) => x.id === id); if (item) start(item, false); });
    return () => registerEditHandler(null);
  }, [items, registerEditHandler, start]);
  useEffect(() => { setPreview(placing ? hover : draft); return () => setPreview(null); }, [draft, hover, placing, setPreview]);
  useEffect(() => () => restore(), [restore]);
  useEffect(() => runtime.store.subscribe((state) => {
    if (state.editing || state.routeDraft) setCatalogOpen(false);
  }), [runtime]);
  useEffect(() => {
    if (!draft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, cancel, draft]);

  useEffect(() => {
    const el = runtime.canvasEl;
    if (!el || !draft || !placing || busy) return;
    let needsCollisionRefresh = true;
    const solve = (event: PointerEvent) => {
      if (runtime.store.getState().cameraOverride || event.buttons > 1) return null;
      const { picker, camera3d, index: sceneIndex, clip } = runtime;
      if (!picker || !camera3d || !sceneIndex || !clip) return null;
      if (needsCollisionRefresh) { clearFurnishingCollisionCache(sceneIndex); needsCollisionRefresh = false; }
      const modelHit = picker.pick(event.clientX, event.clientY, el.getBoundingClientRect(), camera3d, sceneIndex, clip);
      const support = pickObjectSupport(runtime, event.clientX, event.clientY, items, draft.id);
      const hit = support && (!modelHit || support.distance < modelHit.distance) ? support : modelHit;
      if (!hit || !hit.normal || hit.normal.y < .75) return null;
      const floorId = hit.floorId ?? draft.floorId;
      const config = runtime.store.getState().snap;
      const grid = config.enabled && !event.altKey ? config.grid : 0;
      const position = roundedPosition([snapValue(hit.point.x, grid), hit.point.y - (runtime.offsets.get(floorId) ?? 0), snapValue(hit.point.z, grid)]);
      return { ...draft, floorId, position, roomId: roomAt(sceneIndex.manifest, floorId, position[0], position[2]) };
    };
    let anchor: Furnishing | null = null;
    let down: { x: number; y: number } | null = null;
    const proposed = (event: PointerEvent) => {
      if (!anchor || !down) return solve(event);
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 8) return anchor;
      const rect = el.getBoundingClientRect();
      const point = intersectHorizontalPlane((event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1, runtime.camera3d!, anchor.position[1]);
      return point ? { ...anchor, rotationYDeg: placementYaw(anchor.position, point.toArray(), anchor.rotationYDeg) } : anchor;
    };
    let frame = 0;
    let latest: PointerEvent | null = null;
    const onMove = (event: PointerEvent) => {
      latest = event;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const candidate = latest ? proposed(latest) : null;
        setHover(candidate);
        setError(candidate && runtime.index ? furnishingPlacementError(candidate, runtime.index) : "Point at a floor or an upward-facing surface.");
      });
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || runtime.store.getState().cameraOverride) return;
      anchor = solve(event); down = { x: event.clientX, y: event.clientY };
      setHover(anchor);
    };
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || !down) return;
      const candidate = proposed(event);
      down = null; anchor = null;
      if (frame) cancelAnimationFrame(frame); frame = 0;
      const problem = candidate && runtime.index ? furnishingPlacementError(candidate, runtime.index) : "Choose a floor or an upward-facing surface.";
      if (!candidate || problem) { setError(problem); return; }
      setDraft(candidate); setHover(null); setPlacing(false); setError(null);
      runtime.store.getState().setTool("select");
    };
    const leave = () => { if (frame) cancelAnimationFrame(frame); frame = 0; latest = null; down = null; anchor = null; setHover(null); };
    el.addEventListener("pointermove", onMove); el.addEventListener("pointerdown", onDown); el.addEventListener("pointerup", onUp); el.addEventListener("pointerleave", leave);
    return () => { leave(); el.removeEventListener("pointermove", onMove); el.removeEventListener("pointerdown", onDown); el.removeEventListener("pointerup", onUp); el.removeEventListener("pointerleave", leave); };
  }, [busy, draft, placing, runtime, items]);

  const change = (next: Furnishing) => { setDraft(next); setHover(null); setPlacing(false); setError(null); runtime.store.getState().setTool("select"); };
  return <Context.Provider value={{ draft, placing, error, previewInvalid, catalogOpen, setCatalogOpen, begin, change, cancel,
    reposition: () => { if (!busy) { setPlacing(true); setHover(null); setError(null); runtime.store.getState().setTool("place"); } },
    save: () => {
      if (!draft || busy) return;
      const problem = runtime.index ? furnishingPlacementError(draft, runtime.index) : "Wait for the model to load.";
      if (placing || problem) { setError(problem ?? "Click to place the furniture first, or enter its position."); return; }
      const { id, kind, name, position, rotationYDeg, widthM, depthM, heightM, floorId, roomId } = draft;
      void save({ kind, name, position, rotationYDeg, widthM, depthM, heightM, floorId, roomId, ...(id ? { id } : {}) }).then(() => { setDraft(null); setHover(null); setPlacing(false); setError(null); restore(); })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Could not save furniture"));
    },
  }}>{children}</Context.Provider>;
}
