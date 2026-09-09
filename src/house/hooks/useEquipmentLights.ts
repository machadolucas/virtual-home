"use client";
/* eslint-disable react-hooks/immutability -- The imperative scene runtime owns light objects. */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { clipGroupOf } from "../model/explodeGroups";
import { isLightEntity, lightAppearance, lightDirection } from "../model/equipmentLight";
import { defaultSymbol, isPlacementSymbol } from "../scene/symbols";
import { isVisibleUp } from "../scene/applyVisibility";
import { EquipmentLightLayer, type EquipmentLightSpec } from "../scene/equipmentLights";
import { classifyState, haStore } from "../store/haStore";
import { useHouseRuntime } from "./useHouseStore";

export function useEquipmentLights() {
  const runtime = useHouseRuntime();
  const scene = useThree((s) => s.scene);
  const refresh = useRef<(() => void) | null>(null);
  const lastCamera = useRef(new THREE.Vector3(Infinity, Infinity, Infinity));
  const lastRefresh = useRef(0);

  useEffect(() => {
    const layer = new EquipmentLightLayer(scene);
    runtime.equipmentLights = layer;
    const update = () => {
      const state = runtime.store.getState();
      const index = runtime.index;
      const manifest = runtime.manifest;
      const ha = haStore.getState();
      const candidates: EquipmentLightSpec[] = [];
      const camera = runtime.camera3d?.position ?? new THREE.Vector3();
      const now = Date.now();
      if (index && manifest && state.layers.equipment) {
        for (const saved of state.placements) {
          const draft = state.editing?.placementId === saved.id ? state.editing : null;
          const p = draft ? { ...saved, position: draft.physical, lightAim: draft.lightAim, symbol: draft.symbol, floorId: draft.floorId, roomId: draft.roomId, surfaceId: draft.surfaceId, mount: draft.mount } : saved;
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
          const direction = lightDirection(symbol, p.lightAim);
          // Source follows the emitter, not the mount point (a standing lamp's mount is on the floor).
          const rise = symbol === "lamp_post" ? 0.55 : symbol === "floor_lamp" ? 0.35 : symbol === "spike_spot" ? 0.085 : symbol === "wall_lamp" ? 0.055 : symbol === "ceiling_lamp" ? -0.14 : -0.065;
          const wallOffset = symbol === "wall_lamp" ? 0.09 : 0;
          const yaw = THREE.MathUtils.degToRad(p.rotationYDeg);
          const source: [number, number, number] = [position[0] + Math.sin(yaw) * wallOffset, position[1] + rise, position[2] + Math.cos(yaw) * wallOffset];
          candidates.push({ id: p.id, spot: symbol === "downlight" || symbol === "spike_spot", position: source, direction, color: appearance.color, brightness: appearance.intensity });
        }
      }
      const selected = state.selection?.kind === "equipment" ? state.selection.id : null;
      candidates.sort((a, b) => (a.id === selected ? -1 : b.id === selected ? 1 : new THREE.Vector3(...a.position).distanceToSquared(camera) - new THREE.Vector3(...b.position).distanceToSquared(camera)));
      if (layer.set(candidates, state.performanceMode ? 2 : 8)) runtime.invalidate();
    };
    refresh.current = update;
    update();
    const offStore = runtime.store.subscribe(update);
    const offHa = haStore.subscribe((s) => [s.entities, s.connection] as const, update);
    // Expire readings even when no HA message arrives, without rendering unchanged frames.
    const timer = setInterval(update, 30_000);
    return () => {
      clearInterval(timer);
      offStore(); offHa();
      refresh.current = null;
      runtime.equipmentLights = null;
      layer.dispose();
    };
  }, [runtime, scene]);

  useFrame(({ camera, clock }) => {
    if (clock.elapsedTime - lastRefresh.current < 0.15 || camera.position.distanceToSquared(lastCamera.current) < 0.01) return;
    lastCamera.current.copy(camera.position);
    lastRefresh.current = clock.elapsedTime;
    refresh.current?.();
  });
}
