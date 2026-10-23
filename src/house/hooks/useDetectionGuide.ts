"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { useHouseRuntime } from "./useHouseStore";
import { detectionBoundary, detectionProfile, detectionRange, isDirectionalSymbol, showDetectionGuide } from "../model/equipmentOptics";
import { defaultLightAim, lightSourcePosition } from "../model/equipmentLight";
import { defaultSymbol, isPlacementSymbol } from "../scene/symbols";
import { clipGroupOf } from "../model/explodeGroups";
import { isVisibleUp } from "../scene/applyVisibility";

/** Selection-only optical guide, with no device command or continuous rendering. */
export function useDetectionGuide() {
  const runtime = useHouseRuntime();
  useEffect(() => {
    const scene = runtime.scene;
    if (!scene) return;
    const guide = new THREE.Group();
    guide.name = "vh-snap-indicator"; // Editing aids are excluded from PNG capture.
    guide.userData.detectionGuide = true;
    const material = new THREE.MeshBasicMaterial({ color: 0x448ee4, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false });
    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x448ee4, transparent: true, opacity: 0.65, depthWrite: false });
    scene.add(guide);
    let signature = "";
    const clear = () => {
      for (const child of [...guide.children]) {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) child.geometry.dispose();
        guide.remove(child);
      }
    };
    const update = () => {
      const s = runtime.store.getState();
      const saved = s.selection?.kind === "equipment" ? s.placements.find((p) => p.id === s.selection!.id) : undefined;
      const draft = s.editing;
      const p = draft ? { ...draft, position: draft.physical } : saved;
      const symbol = p && (isPlacementSymbol(p.symbol) ? p.symbol : defaultSymbol({ category: p.category, entityId: p.entityId, mountKind: p.mount.kind, isOutdoor: !p.roomId }));
      const group = p?.surfaceId && runtime.manifest ? clipGroupOf(runtime.manifest, p.surfaceId) : p?.floorId;
      const nodes = group ? runtime.index?.floorNodes.get(group) : undefined;
      const eligible = p && !runtime.index?.hiddenGroups.has(group!) && s.layers.equipment && isDirectionalSymbol(symbol) && (draft || showDetectionGuide({ ...p, symbol: symbol ?? null })) && (!nodes?.length || nodes.some(isVisibleUp));
      const next = eligible ? JSON.stringify([p.position, p.rotationYDeg, p.lightAim, p.detectionRangeM, p.modelName, p.roomId, symbol, runtime.offsets.get(group!) ?? 0]) : "";
      if (next === signature) return;
      signature = next;
      clear();
      guide.visible = Boolean(eligible);
      if (eligible) {
        const profile = detectionProfile({ ...p, symbol });
        const range = detectionRange(p.detectionRangeM, profile.rangeM);
        const boundary = detectionBoundary(profile, range);
        const positions: number[] = [];
        const lines: number[] = [];
        boundary.forEach((point, i) => {
          const nextPoint = boundary[(i + 1) % boundary.length]!;
          positions.push(0, 0, 0, ...point, ...nextPoint);
          lines.push(...point, ...nextPoint);
          if (i % (boundary.length / 4) === 0) lines.push(0, 0, 0, ...point);
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        const outline = new THREE.BufferGeometry();
        outline.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
        guide.add(new THREE.Mesh(geometry, material));
        guide.add(new THREE.LineSegments(outline, lineMaterial));
        guide.position.fromArray(lightSourcePosition(p.position, symbol, p.rotationYDeg, runtime.offsets.get(group!) ?? 0, p.lightAim));
        const aim = p.lightAim ?? defaultLightAim(symbol, p.rotationYDeg);
        // Yaw then pitch preserves the wide horizontal axis without adding roll.
        guide.quaternion.setFromEuler(new THREE.Euler(-aim.pitchDeg * Math.PI / 180, aim.yawDeg * Math.PI / 180, 0, "YXZ"));
      }
      runtime.invalidate();
    };
    update();
    const off = runtime.store.subscribe(update);
    return () => { off(); clear(); material.dispose(); lineMaterial.dispose(); scene.remove(guide); runtime.invalidate(); };
  }, [runtime]);
}
