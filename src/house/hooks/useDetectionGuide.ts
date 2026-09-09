"use client";

import { useEffect } from "react";
import * as THREE from "three";
import { useHouseRuntime } from "./useHouseStore";
import { detectionRange, isDirectionalSymbol, showDetectionGuide } from "../model/equipmentOptics";
import { lightDirection, lightSourcePosition } from "../model/equipmentLight";
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
      const next = eligible ? JSON.stringify([p.position, p.rotationYDeg, p.lightAim, p.detectionRangeM, symbol, runtime.offsets.get(group!) ?? 0]) : "";
      if (next === signature) return;
      signature = next;
      clear();
      guide.visible = Boolean(eligible);
      if (eligible) {
        const range = detectionRange(p.detectionRangeM);
        const geometry = new THREE.ConeGeometry(range * Math.tan(Math.PI / 6), range, 24, 1, true);
        geometry.rotateX(Math.PI);
        geometry.translate(0, range / 2, 0);
        guide.add(new THREE.Mesh(geometry, material));
        guide.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), lineMaterial));
        guide.position.fromArray(lightSourcePosition(p.position, symbol, p.rotationYDeg, runtime.offsets.get(group!) ?? 0, p.lightAim));
        guide.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...lightDirection(symbol, p.lightAim, p.rotationYDeg)));
      }
      runtime.invalidate();
    };
    update();
    const off = runtime.store.subscribe(update);
    return () => { off(); clear(); material.dispose(); lineMaterial.dispose(); scene.remove(guide); runtime.invalidate(); };
  }, [runtime]);
}
