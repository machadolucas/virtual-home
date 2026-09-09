"use client";
/* eslint-disable react-hooks/immutability -- `HouseRuntime` is a deliberately mutable,
   non-reactive box handed around by context (see `src/house/runtime.ts`): the imperative layer
   publishes its handles onto it and React never re-renders because of it. The React Compiler
   rule assumes a hook's return value is immutable, which is precisely the assumption this
   design breaks on purpose — the alternative is putting `Object3D`s in React state. */
/**
 * The one place where store state becomes scene mutation.
 *
 * Each subscription is narrow, and each ends in exactly one imperative call plus (where something
 * visual actually changed) one `invalidate()`. Everything the resolver owns — visibility, colours,
 * clipping, explode offsets, highlighting, markers, routes — is re-applied in full from the pure
 * plan rather than diffed, because a full re-resolve of ~500 booleans is microseconds and a diff
 * is where the "model is in a weird state" bugs live.
 */
import { useEffect } from "react";
import * as THREE from "three";

import { shallow } from "zustand/vanilla/shallow";
import { planAllSurfaces } from "@/house/model/colorPlan";
import { buildGroupOrder, clipGroupOf, explodeOffset } from "@/house/model/explodeGroups";
import {
  cameraFacingRoomWalls,
  focusContextFor,
  focusCutSurfaceIds,
} from "@/house/model/focusContext";
import { computeVisibility } from "@/house/model/visibilityPlan";
import type { Placement } from "@/house/model/types";
import { applyColors } from "@/house/scene/applyColors";
import { applyVisibility } from "@/house/scene/applyVisibility";
import { applyExplode } from "@/house/scene/explode";
import { defaultSymbol, isPlacementSymbol } from "@/house/scene/symbols";
import { highlightTargets } from "@/house/scene/highlight";
import { inventoryOf } from "@/house/scene/SceneIndex";
import { classifyState, haStore, markerStateKey } from "@/house/store/haStore";
import type { HouseStore } from "@/house/store/createHouseStore";
import { useHouseRuntime } from "./useHouseStore";
import { isRunVisibleOn } from "@/features/projects/renovationDate";

/** The id the in-progress draft borrows while it has no row of its own. */
export const DRAFT_MARKER_ID = "__vh_draft__";

export function useSceneSync(): void {
  const runtime = useHouseRuntime();
  const store = runtime.store;

  // ---- visibility -------------------------------------------------------
  useEffect(() => {
    const wallCentresByFloor = new Map<string, Map<string, [number, number, number]>>();

    const resolveFocus = (s: HouseStore) =>
      runtime.manifest
        ? focusContextFor(
            runtime.manifest,
            s.focusSelection,
            (id) => s.placements.find((p) => p.id === id),
            !s.editing && !s.routeDraft,
          )
        : null;

    const wallCentres = (floorId: string): Map<string, [number, number, number]> => {
      const index = runtime.index;
      const manifest = runtime.manifest;
      const cached = wallCentresByFloor.get(floorId);
      if (cached || !index || !manifest) return cached ?? new Map();
      const centres = new Map<string, [number, number, number]>();
      for (const [sid, surface] of manifest.surfaces) {
        if (surface.kind !== "wall" || manifest.floorOfSurface.get(sid) !== floorId) continue;
        const mesh = index.surfaceMesh.get(sid);
        if (!mesh) continue;
        const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
        centres.set(sid, [centre.x, centre.y, centre.z]);
      }
      wallCentresByFloor.set(floorId, centres);
      return centres;
    };

    const applyFocusCuts = (s: HouseStore, clearWhenInactive: boolean) => {
      const manifest = runtime.manifest;
      const focus = resolveFocus(s);
      if (!manifest || !runtime.clip) return;
      if (!focus?.roomId || !focus.floorId || !runtime.camera3d) {
        if (clearWhenInactive && runtime.clip.setFocusCuts(new Map())) runtime.invalidate();
        return;
      }
      const cuts = new Map<string, number>();
      const camera = runtime.camera3d.getWorldPosition(new THREE.Vector3());
      const room = manifest.rooms.get(focus.roomId);
      if (room) {
        const groupOffset = runtime.offsets.get(focus.floorId) ?? 0;
        const cap =
          room.floorElevation +
          Math.min(0.9, (room.ceilingHeight ?? 2.5) * 0.4) +
          groupOffset;
        const facing = cameraFacingRoomWalls(
          manifest,
          focus.roomId,
          [camera.x, camera.y, camera.z],
          wallCentres(focus.floorId),
        );
        for (const sid of focusCutSurfaceIds(manifest, facing)) {
          if (sid !== focus.preserveSurfaceId) cuts.set(sid, cap);
        }
      }
      if (runtime.clip.setFocusCuts(cuts)) runtime.invalidate();
    };

    const apply = (s: HouseStore) => {
      const index = runtime.index;
      if (!index || !runtime.manifest) return;
      const focus = resolveFocus(s);
      const plan = computeVisibility(runtime.manifest, {
        viewMode: s.viewMode,
        projection: s.projection,
        activeFloorId: s.activeFloorId,
        roofVisible: s.roofVisible,
        ceilingsVisible: s.ceilingsVisible,
        edgesVisible: s.edgesVisible,
        layers: s.layers,
        loadedAssetIds: [...index.assets.keys()],
        explode: s.explode,
        inventory: inventoryOf(index),
        focus,
      });
      applyVisibility(plan, index, runtime.invalidate);
      applyFocusCuts(s, true);
    };
    runtime.refreshFocusClipping = () => applyFocusCuts(store.getState(), false);
    apply(store.getState());
    const unsubscribe = store.subscribe(
      (s: HouseStore) => ({
        viewMode: s.viewMode,
        projection: s.projection,
        activeFloorId: s.activeFloorId,
        roofVisible: s.roofVisible,
        ceilingsVisible: s.ceilingsVisible,
        edgesVisible: s.edgesVisible,
        layers: s.layers,
        explode: s.explode,
        loaded: s.loadedAssetIds,
        focusSelection: s.focusSelection,
        placements: s.placements,
        editing: s.editing,
        routeDraft: s.routeDraft,
      }),
      () => {
        wallCentresByFloor.clear();
        apply(store.getState());
      },
      { equalityFn: shallow },
    );
    return () => {
      unsubscribe();
      runtime.refreshFocusClipping = null;
    };
  }, [runtime, store]);

  // ---- colours ----------------------------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      if (!index || !runtime.manifest) return;
      applyColors(
        planAllSurfaces(runtime.manifest.manifest.surfaces, s.overrides),
        index,
        runtime.invalidate,
      );
    };
    apply(store.getState());
    // Overrides arrive from the server before the meshes exist: re-apply as assets land.
    return store.subscribe(
      (s) => ({ overrides: s.overrides, loaded: s.loadedAssetIds }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
  }, [runtime, store]);

  // ---- cutaway + explode (they compose through per-group planes) --------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      const clip = runtime.clip;
      if (!index || !clip || !runtime.manifest) return;
      const applied = applyExplode(index, s.explode, runtime.invalidate);
      runtime.offsets = applied.offsets;
      const order = buildGroupOrder(runtime.manifest);
      clip.setCutAll(s.cut, (group) =>
        applied.offsets.get(group) ?? explodeOffset(order, group, s.explode.enabled ? s.explode.gap : 0),
      );
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe(
      (s: HouseStore) => ({ cut: s.cut, explode: s.explode, loaded: s.loadedAssetIds }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
  }, [runtime, store]);

  // ---- selection / hover highlight -------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      const clip = runtime.clip;
      const highlighter = runtime.highlighter;
      if (!index || !clip || !highlighter) return;
      const selected = highlightTargets(index, s.selection);
      const hovered = highlightTargets(index, s.hover);
      highlighter.set(index, clip, selected.ids, hovered.primary, {
        intensity: selected.intensity,
        primary: selected.primary,
      });
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe(
      (s: HouseStore) => ({ selection: s.selection, hover: s.hover }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
  }, [runtime, store]);

  // ---- markers ----------------------------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      const markers = runtime.markers;
      if (!index || !markers || !runtime.manifest) return;
      const ha = haStore.getState();
      const now = Date.now();
      const groupOf = (p: Placement) =>
        p.surfaceId ? clipGroupOf(runtime.manifest!, p.surfaceId) : p.floorId;
      const stateOf = (p: Placement) =>
        p.entityId ? markerStateKey(ha.entities[p.entityId], ha.connection, now) : "unlinked";
      const symbolOf = (p: Placement) =>
        isPlacementSymbol(p.symbol)
          ? p.symbol
          : defaultSymbol({
              category: p.category,
              mountKind: p.mount.kind,
              // No room means outdoors here: the package's rooms are interior only, so a
              // roomless placement is on the terrace, the balcony or in the yard.
              isOutdoor: p.roomId === null,
            });

      // The draft rides along as one more marker, so the thing being placed is **visible while
      // being placed**. Before this, a new placement was invisible until saved: the only feedback
      // was three numbers in the panel, which is a poor way to tell whether a lamp is where you
      // meant. It is never persisted — the draft is client state and `set()` rebuilds from
      // scratch on the next change.
      const draft = s.editing;
      const withDraft: Placement[] =
        draft === null
          ? s.placements
          : [
              // An existing placement being edited is replaced by its draft, so it does not draw
              // twice — once at the saved position and once under the cursor.
              ...s.placements.filter((p) => p.id !== draft.placementId),
              {
                id: draft.placementId ?? DRAFT_MARKER_ID,
                modelId: draft.modelId,
                equipmentId: draft.equipmentId,
                name: draft.name,
                position: draft.physical,
                rotationYDeg: draft.rotationYDeg,
                mount: draft.mount,
                floorId: draft.floorId,
                roomId: draft.roomId,
                surfaceId: draft.surfaceId,
                locationNote: draft.locationNote,
                photoId: draft.photoId,
                entityId: null,
                symbol: draft.symbol,
                category: null,
              },
            ];

      // The "Equipment" layer checkbox used to move nothing: `computeVisibility` never read it, so
      // markers were drawn whatever the toolbar said. The draft is exempt — hiding the thing you
      // are currently placing would be absurd.
      const drawn = s.layers.equipment
        ? withDraft
        : withDraft.filter((p) => p.id === (draft?.placementId ?? DRAFT_MARKER_ID) && draft !== null);

      markers.set(drawn, stateOf, groupOf, symbolOf);
      applyExplode(index, s.explode);
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe(
      (s: HouseStore) => ({
        placements: s.placements,
        editing: s.editing,
        equipmentLayer: s.layers.equipment,
      }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
  }, [runtime, store]);

  // ---- routes -----------------------------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      const routes = runtime.routes;
      if (!index || !routes) return;
      // One predicate for "is this run present on the viewed date" (planned, installed, removed),
      // shared with the inspector so the two can never disagree.
      // The "Infrastructure routes" checkbox defaulted to *off* while the lines were drawn
      // regardless — a control showing the opposite of the screen. It is honoured now.
      const visible = s.layers.routes
        ? s.routes.filter((r) => s.visibleSystems[r.system] && isRunVisibleOn(r, s.renovationDate))
        : [];
      routes.set(visible, { tubes: !s.performanceMode });
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe(
      (s: HouseStore) => ({
        routes: s.routes,
        routeLayer: s.layers.routes,
        visibleSystems: s.visibleSystems,
        renovationDate: s.renovationDate,
        performanceMode: s.performanceMode,
      }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
  }, [runtime, store]);

  // ---- HA marker colours ------------------------------------------------
  useEffect(() => {
    /**
     * `invalidate()` is called **only** when an instance colour actually changed. A temperature
     * reading must not wake the GPU: the badge text is a DOM write handled by the label overlay.
     */
    const apply = () => {
      const markers = runtime.markers;
      if (!markers) return;
      const ha = haStore.getState();
      const now = Date.now();
      let changed = false;
      for (const p of runtime.store.getState().placements) {
        if (!p.entityId) continue;
        const key = markerStateKey(ha.entities[p.entityId], ha.connection, now);
        if (markers.setStateColor(p.id, key)) changed = true;
      }
      if (changed) runtime.invalidate();
    };
    const unsubEntities = haStore.subscribe((s) => s.entities, apply);
    const unsubConnection = haStore.subscribe((s) => s.connection, apply);
    // Staleness is time-based, so one 30 s interval reclassifies; it touches no store and
    // re-renders no React.
    const interval = setInterval(apply, 30_000);
    return () => {
      unsubEntities();
      unsubConnection();
      clearInterval(interval);
    };
  }, [runtime]);

  // ---- dev assertion: HA state never invents a value --------------------
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    return haStore.subscribe((s) => s.entities, (entities) => {
      for (const entity of Object.values(entities)) {
        if (classifyState(entity, "open", Date.now()) === "live" && entity.state === "") {
          console.warn(`[house] entity ${entity.entityId} reported an empty state`);
        }
      }
    });
  }, []);
}
