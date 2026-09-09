"use client";
/* eslint-disable react-hooks/immutability -- The imperative scene runtime owns light objects. */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { clipGroupOf } from "../model/explodeGroups";
import {
  isLightEntity,
  isSpotlightSymbol,
  lightAppearance,
  lightDirection,
  lightSourcePosition,
} from "../model/equipmentLight";
import { defaultSymbol, isPlacementSymbol } from "../scene/symbols";
import { isVisibleUp } from "../scene/applyVisibility";
import {
  EquipmentLightLayer,
  LIGHT_BUDGET,
  PERFORMANCE_LIGHT_BUDGET,
  prepareEquipmentLightSurfaces,
  type EquipmentLightSpec,
} from "../scene/equipmentLights";
import { classifyState, haStore } from "../store/haStore";
import { useHouseRuntime } from "./useHouseStore";

export function useEquipmentLights() {
  const runtime = useHouseRuntime();
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const refresh = useRef<(() => void) | null>(null);
  const lastCamera = useRef(new THREE.Vector3(Infinity, Infinity, Infinity));
  const lastRefresh = useRef(0);
  const preparedIndex = useRef<{ index: typeof runtime.index; assetCount: number }>({
    index: null,
    assetCount: -1,
  });

  useEffect(() => {
    const layer = new EquipmentLightLayer(scene);
    const previousShadows = {
      enabled: gl.shadowMap.enabled,
      autoUpdate: gl.shadowMap.autoUpdate,
      type: gl.shadowMap.type,
    };
    gl.shadowMap.enabled = true;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.type = THREE.PCFShadowMap;
    runtime.equipmentLights = layer;
    const update = (refreshOccluders = false) => {
      const state = runtime.store.getState();
      layer.root.traverse((object) => {
        if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight) object.shadow.radius = state.illumination.softShadows ? 2 : 0;
      });
      const index = runtime.index;
      const manifest = runtime.manifest;
      const ha = haStore.getState();
      const candidates: EquipmentLightSpec[] = [];
      const camera = runtime.camera3d?.position ?? new THREE.Vector3();
      const now = Date.now();
      if (index && manifest && state.layers.equipment) {
        for (const saved of state.placements) {
          const draft = state.editing?.placementId === saved.id ? state.editing : null;
          const p = draft ? { ...saved, position: draft.physical, rotationYDeg: draft.rotationYDeg, lightAim: draft.lightAim, symbol: draft.symbol, floorId: draft.floorId, roomId: draft.roomId, surfaceId: draft.surfaceId, mount: draft.mount } : saved;
          const entityId = [p.entityId, ...(p.linkedEntities ?? []).map((e) => e.entityId)].find(isLightEntity);
          if (!entityId) continue;
          const entity = ha.entities[entityId];
          if (!entity) continue;
          const appearance = lightAppearance({ ...entity, live: classifyState(entity, ha.connection, now) === "live" });
          if (!appearance || appearance.intensity <= 0) continue;
          const group = p.surfaceId ? clipGroupOf(manifest, p.surfaceId) : p.floorId;
          const nodes = index.floorNodes.get(group);
          if (nodes?.length && !nodes.some(isVisibleUp)) continue;
          const position: [number, number, number] = [p.position[0], p.position[1] + (runtime.offsets.get(group) ?? 0), p.position[2]];
          if (runtime.clip && !runtime.clip.keeps(group, new THREE.Vector3(...position))) continue;
          const symbol = isPlacementSymbol(p.symbol) ? p.symbol : defaultSymbol({ category: p.category, entityId: p.entityId, mountKind: p.mount.kind, isOutdoor: !p.roomId });
          const direction = lightDirection(symbol, p.lightAim, p.rotationYDeg);
          // Source follows the visible emitter, while the persisted coordinate remains its mount.
          const source = lightSourcePosition(p.position, symbol, p.rotationYDeg, runtime.offsets.get(group) ?? 0);
          candidates.push({ id: p.id, spot: isSpotlightSymbol(symbol), position: source, direction, color: appearance.color, brightness: appearance.intensity });
        }
      }
      const selected = state.selection?.kind === "equipment" ? state.selection.id : null;
      candidates.sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : new THREE.Vector3(...a.position).distanceToSquared(camera) - new THREE.Vector3(...b.position).distanceToSquared(camera)));
      const changed = layer.set(
        candidates,
        state.performanceMode ? PERFORMANCE_LIGHT_BUDGET : LIGHT_BUDGET,
      );
      const surfacesChanged = index ? prepareEquipmentLightSurfaces(index) : false;
      if (changed || surfacesChanged || refreshOccluders) {
        gl.shadowMap.needsUpdate = true;
        runtime.invalidate();
      }
    };
    refresh.current = update;
    update();
    const offStore = runtime.store.subscribe(() => update(true));
    const offHa = haStore.subscribe((s) => [s.entities, s.connection] as const, () => update());
    // Expire readings even when no HA message arrives, without rendering unchanged frames.
    const timer = setInterval(update, 30_000);
    return () => {
      clearInterval(timer);
      offStore(); offHa();
      refresh.current = null;
      runtime.equipmentLights = null;
      layer.dispose();
      gl.shadowMap.enabled = previousShadows.enabled;
      gl.shadowMap.autoUpdate = previousShadows.autoUpdate;
      gl.shadowMap.type = previousShadows.type;
    };
  }, [runtime, scene, gl]);

  useFrame(({ camera, clock }, delta) => {
    const index = runtime.index;
    if (
      index &&
      (preparedIndex.current.index !== index || preparedIndex.current.assetCount !== index.assets.size)
    ) {
      // The house store survives a client-side navigation, so `assetLoaded(id)` can be a no-op on
      // re-entry even though a brand-new SceneIndex and meshes were built. Detect the scene itself
      // so those meshes always become shadow receivers/occluders and the new maps render once.
      preparedIndex.current = { index, assetCount: index.assets.size };
      prepareEquipmentLightSurfaces(index);
      gl.shadowMap.needsUpdate = true;
      runtime.invalidate();
    }
    // R3F's first delta after an idle demand loop includes the whole idle gap. Cap that first step
    // so a light event after a quiet second cannot complete its 160 ms fade in one frame.
    if (runtime.equipmentLights?.tick(Math.min(delta, 1 / 30))) runtime.invalidate();
    if (clock.elapsedTime - lastRefresh.current < 0.15 || camera.position.distanceToSquared(lastCamera.current) < 0.01) return;
    lastCamera.current.copy(camera.position);
    lastRefresh.current = clock.elapsedTime;
    refresh.current?.();
  });
}
