"use client";
/* eslint-disable react-hooks/immutability -- The imperative scene runtime owns light objects. */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { detailedLightBudget, detailedLightHardwareLimit } from "../model/detailedLightBudget";
import { clipGroupOf } from "../model/explodeGroups";
import {
  isLightEntity,
  isSpotlightSymbol,
  lightAppearance,
  lightDirection,
  lightSourcePosition,
} from "../model/equipmentLight";
import { isLedBar, ledLength, ledSource } from "../model/equipmentOptics";
import { defaultSymbol, isPlacementSymbol } from "../scene/symbols";
import { isVisibleUp } from "../scene/applyVisibility";
import {
  EquipmentLightLayer,
  prepareEquipmentLightSurfaces,
  type EquipmentLightSpec,
} from "../scene/equipmentLights";
import {
  createEquipmentLightProjectionCache,
  projectOverflowLight,
} from "../scene/equipmentLightProjection";
import { classifyState, haStore } from "../store/haStore";
import { useHouseRuntime } from "./useHouseStore";

export function useEquipmentLights() {
  const runtime = useHouseRuntime();
  const scene = useThree((s) => s.scene);
  const gl = useThree((s) => s.gl);
  const refresh = useRef<(() => void) | null>(null);
  const lastOcclusionRevision = useRef(-1);
  const preparedIndex = useRef<{ index: typeof runtime.index; assetCount: number }>({
    index: null,
    assetCount: -1,
  });
  const projectionCache = useRef<{
    index: typeof runtime.index;
    assetCount: number;
    offsetSignature: string;
    rays: ReturnType<typeof createEquipmentLightProjectionCache>;
  }>({ index: null, assetCount: -1, offsetSignature: "", rays: createEquipmentLightProjectionCache() });

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
    let requestedLimit = runtime.store.getState().detailedLightLimit;
    let budgetTimer: ReturnType<typeof setTimeout> | null = null;
    let shadowInputs: unknown[] = [];
    let hardwareIndex: typeof runtime.index = null;
    let hardwareAssets = -1;
    let hardwareLimit = detailedLightHardwareLimit(gl.capabilities.maxTextures, gl.capabilities.maxVaryings);
    const update = () => {
      const state = runtime.store.getState();
      layer.root.traverse((object) => {
        if (object instanceof THREE.PointLight || object instanceof THREE.SpotLight) object.shadow.radius = state.illumination.softShadows ? 2 : 0;
      });
      const index = runtime.index;
      if (hardwareIndex !== index || hardwareAssets !== (index?.assets.size ?? 0)) {
        hardwareIndex = index;
        hardwareAssets = index?.assets.size ?? 0;
        let textureSlots = 3;
        for (const asset of index?.assets.values() ?? []) for (const mesh of asset.meshes) {
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            textureSlots = Math.max(textureSlots, Object.values(material).filter((value) => value instanceof THREE.Texture).length);
          }
        }
        hardwareLimit = detailedLightHardwareLimit(gl.capabilities.maxTextures, gl.capabilities.maxVaryings, textureSlots);
        if (state.detailedLightHardwareMax !== hardwareLimit) state.setDetailedLightHardwareMax(hardwareLimit);
      }
      const nextShadowInputs = [index, index?.assets.size, [...(index?.hiddenGroups ?? [])].sort().join(","),
        state.placements, state.editing, state.explode, state.layers, state.roofVisible, state.ceilingsVisible];
      const refreshOccluders = nextShadowInputs.some((value, i) => value !== shadowInputs[i]);
      shadowInputs = nextShadowInputs;
      if (refreshOccluders) {
        layer.invalidateShadows();
        const sun = scene.getObjectByName("vh-daylight") as THREE.DirectionalLight | undefined;
        if (sun?.shadow) sun.shadow.needsUpdate = true;
      }
      const manifest = runtime.manifest;
      const ha = haStore.getState();
      const candidates: EquipmentLightSpec[] = [];
      const now = Date.now();
      let pointCount = 0, spotCount = 0;
      if (index && manifest && state.layers.equipment) {
        for (const saved of state.placements) {
          const draft = state.editing?.placementId === saved.id ? state.editing : null;
          const p = draft ? { ...saved, position: draft.physical, rotationYDeg: draft.rotationYDeg, ledLengthM: draft.ledLengthM, lightAim: draft.lightAim, symbol: draft.symbol, floorId: draft.floorId, roomId: draft.roomId, surfaceId: draft.surfaceId, mount: draft.mount } : saved;
          const entityId = [p.entityId, ...(p.linkedEntities ?? []).map((e) => e.entityId)].find(isLightEntity);
          if (!entityId) continue;
          const group = p.surfaceId ? clipGroupOf(manifest, p.surfaceId) : p.floorId;
          if (index.hiddenGroups.has(group)) continue;
          const nodes = index.floorNodes.get(group);
          if (nodes?.length && !nodes.some(isVisibleUp)) continue;
          const position: [number, number, number] = [p.position[0], p.position[1] + (runtime.offsets.get(group) ?? 0), p.position[2]];
          if (runtime.clip && !runtime.clip.keeps(group, new THREE.Vector3(...position))) continue;
          const symbol = isPlacementSymbol(p.symbol) ? p.symbol : defaultSymbol({ category: p.category, entityId: p.entityId, mountKind: p.mount.kind, isOutdoor: !p.roomId });
          if (isSpotlightSymbol(symbol)) spotCount++; else pointCount++;
          const entity = ha.entities[entityId];
          if (!entity) continue;
          const appearance = lightAppearance({ ...entity, live: classifyState(entity, ha.connection, now) === "live" });
          if (!appearance || appearance.intensity <= 0) continue;
          const direction = lightDirection(symbol, p.lightAim, p.rotationYDeg);
          // Source follows the visible emitter, while the persisted coordinate remains its mount.
          const source = isLedBar(symbol) ? ledSource(p.position, symbol, ledLength(p.ledLengthM), runtime.offsets.get(group) ?? 0) : lightSourcePosition(p.position, symbol, p.rotationYDeg, runtime.offsets.get(group) ?? 0);
          candidates.push({ id: p.id, spot: isSpotlightSymbol(symbol), position: source, direction, color: appearance.color, brightness: appearance.intensity * (isLedBar(symbol) ? ledLength(p.ledLengthM) : 1) });
        }
      }
      const selected = state.selection?.kind === "equipment" ? state.selection.id : null;
      candidates.sort((a, b) =>
        Number(b.id === selected) - Number(a.id === selected) || a.id.localeCompare(b.id));
      const budget = detailedLightBudget(
        Math.min(requestedLimit, hardwareLimit, state.performanceMode ? 2 : Infinity),
        pointCount, spotCount,
      );
      const detailedIds = new Set([
        ...candidates.filter((candidate) => !candidate.spot).slice(0, budget.point),
        ...candidates.filter((candidate) => candidate.spot).slice(0, budget.spot),
      ].map((candidate) => candidate.id));
      const offsetSignature = JSON.stringify([...runtime.offsets].sort(([a], [b]) => a.localeCompare(b)));
      if (projectionCache.current.index !== index ||
          projectionCache.current.assetCount !== (index?.assets.size ?? -1) ||
          projectionCache.current.offsetSignature !== offsetSignature) {
        projectionCache.current = {
          index,
          assetCount: index?.assets.size ?? -1,
          offsetSignature,
          rays: createEquipmentLightProjectionCache(),
        };
      }
      const activeClip = runtime.clip;
      const projections = index && activeClip
        ? candidates
            .filter((candidate) => !detailedIds.has(candidate.id))
            .flatMap((candidate) => {
              const patches = projectOverflowLight(
                candidate,
                index,
                activeClip,
                projectionCache.current.rays,
              );
              return patches.map((patch) => ({
                ...patch,
                color: candidate.color,
                brightness: candidate.brightness,
              }));
            })
        : [];
      const changed = layer.set(
        candidates,
        budget,
        projections,
      );
      const surfacesChanged = index ? prepareEquipmentLightSurfaces(index) : false;
      if (layer.shadowsDirty || surfacesChanged || refreshOccluders) gl.shadowMap.needsUpdate = true;
      if (changed || surfacesChanged || refreshOccluders) {
        runtime.invalidate();
      }
    };
    refresh.current = update;
    update();
    const offStore = runtime.store.subscribe((next, previous) => {
      if (next.detailedLightLimit !== previous.detailedLightLimit) {
        // Keep slider feedback immediate, but compile only the settled budget during a drag.
        if (budgetTimer !== null) clearTimeout(budgetTimer);
        budgetTimer = setTimeout(() => { budgetTimer = null; requestedLimit = runtime.store.getState().detailedLightLimit; update(); }, 180);
      } else update();
    });
    const offHa = haStore.subscribe((s) => [s.entities, s.connection] as const, () => update());
    // Expire readings even when no HA message arrives, without rendering unchanged frames.
    const timer = setInterval(update, 30_000);
    return () => {
      clearInterval(timer);
      if (budgetTimer !== null) clearTimeout(budgetTimer);
      offStore(); offHa();
      refresh.current = null;
      runtime.equipmentLights = null;
      layer.dispose();
      gl.shadowMap.enabled = previousShadows.enabled;
      gl.shadowMap.autoUpdate = previousShadows.autoUpdate;
      gl.shadowMap.type = previousShadows.type;
    };
  }, [runtime, scene, gl]);

  useFrame((_, delta) => {
    const index = runtime.index;
    let sceneChanged = false;
    if (
      index &&
      (preparedIndex.current.index !== index || preparedIndex.current.assetCount !== index.assets.size)
    ) {
      // The house store survives a client-side navigation, so `assetLoaded(id)` can be a no-op on
      // re-entry even though a brand-new SceneIndex and meshes were built. Detect the scene itself
      // so those meshes always become shadow receivers/occluders and the new maps render once.
      preparedIndex.current = { index, assetCount: index.assets.size };
      prepareEquipmentLightSurfaces(index);
      runtime.equipmentLights?.invalidateShadows();
      gl.shadowMap.needsUpdate = true;
      runtime.invalidate();
      sceneChanged = true;
    }
    if (lastOcclusionRevision.current !== runtime.occlusionRevision) {
      lastOcclusionRevision.current = runtime.occlusionRevision;
      sceneChanged = true;
    }
    if (sceneChanged) refresh.current?.();
    // R3F's first delta after an idle demand loop includes the whole idle gap. Cap that first step
    // so a light event after a quiet second cannot complete its 160 ms fade in one frame.
    if (runtime.equipmentLights?.tick(Math.min(delta, 1 / 30))) runtime.invalidate();
  });
}
