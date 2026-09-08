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
import { shallow } from "zustand/vanilla/shallow";
import { planAllSurfaces } from "@/house/model/colorPlan";
import { buildGroupOrder, clipGroupOf, explodeOffset } from "@/house/model/explodeGroups";
import { computeVisibility } from "@/house/model/visibilityPlan";
import type { Placement } from "@/house/model/types";
import { applyColors } from "@/house/scene/applyColors";
import { applyVisibility } from "@/house/scene/applyVisibility";
import { applyExplode } from "@/house/scene/explode";
import { highlightTargets } from "@/house/scene/highlight";
import { inventoryOf } from "@/house/scene/SceneIndex";
import { classifyState, haStore, markerStateKey } from "@/house/store/haStore";
import type { HouseStore } from "@/house/store/createHouseStore";
import { useHouseRuntime } from "./useHouseStore";
import { isRunVisibleOn } from "@/features/projects/renovationDate";

export function useSceneSync(): void {
  const runtime = useHouseRuntime();
  const store = runtime.store;

  // ---- visibility -------------------------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      if (!index || !runtime.manifest) return;
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
      });
      applyVisibility(plan, index, runtime.invalidate);
    };
    apply(store.getState());
    return store.subscribe(
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
      }),
      () => apply(store.getState()),
      { equalityFn: shallow },
    );
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
      markers.set(s.placements, stateOf, groupOf);
      applyExplode(index, s.explode);
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe((s) => s.placements, () => apply(store.getState()));
  }, [runtime, store]);

  // ---- routes -----------------------------------------------------------
  useEffect(() => {
    const apply = (s: HouseStore) => {
      const index = runtime.index;
      const routes = runtime.routes;
      if (!index || !routes) return;
      // One predicate for "is this run present on the viewed date" (planned, installed, removed),
      // shared with the inspector so the two can never disagree.
      const visible = s.routes.filter(
        (r) => s.visibleSystems[r.system] && isRunVisibleOn(r, s.renovationDate),
      );
      routes.set(visible, { tubes: !s.performanceMode });
      runtime.invalidate();
    };
    apply(store.getState());
    return store.subscribe(
      (s: HouseStore) => ({
        routes: s.routes,
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
