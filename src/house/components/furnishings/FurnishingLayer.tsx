"use client";
/* eslint-disable react-hooks/immutability -- shadow maps and the HouseRuntime are imperative
   Three.js objects owned by the viewer, not React state. Geometry changes must dirty them. */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Furnishing } from "@/house/model/types";
import { isVisibleUp } from "@/house/scene/applyVisibility";
import { disposeFurnishingGeometries, furnishingGeometry } from "@/house/scene/furnishingGeometry";
import { furnishingRaycast } from "@/house/scene/furnishingRaycast";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";
import { useFurnitureEditor } from "./FurnitureEditorContext";
import { useFurnishings } from "./FurnishingsProvider";

export function FurnishingLayer() {
  const runtime = useHouseRuntime();
  const { items, preview } = useFurnishings();
  const shown = useHouseStore((s) => s.layers.furnishings);
  const gl = useThree((s) => s.gl);
  const rendered = preview ? [...items.filter((x) => x.id !== preview.id), preview] : items;
  const signature = items.filter((x) => x.id !== preview?.id).map((x) => `${x.id}:${x.kind}:${x.floorId}:${x.position.join(",")}:${x.widthM}:${x.depthM}:${x.heightM}:${x.rotationYDeg}`).join("|");

  useEffect(() => {
    gl.shadowMap.needsUpdate = true;
    runtime.scene?.traverse((object) => {
      if ((object as THREE.Light).isLight && (object as THREE.Light & { shadow?: { needsUpdate: boolean } }).shadow)
        (object as THREE.Light & { shadow: { needsUpdate: boolean } }).shadow.needsUpdate = true;
    });
    runtime.equipmentLights?.invalidateShadows();
    runtime.invalidate();
  }, [gl, runtime, signature, shown]);

  useEffect(() => () => disposeFurnishingGeometries(), []);
  useEffect(() => runtime.invalidate(), [runtime, preview]);

  if (!shown) return null;
  return <group name="furnishings">{rendered.map((item) => <FurnishingObject key={item.id || "__preview"} item={item} preview={item === preview} />)}</group>;
}

function FurnishingObject({ item, preview }: { item: Furnishing; preview: boolean }) {
  const runtime = useHouseRuntime();
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const { requestEdit } = useFurnishings();
  const { previewInvalid, draft } = useFurnitureEditor();
  const tool = useHouseStore((s) => s.tool);
  const root = useRef<THREE.Group>(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: preview ? (previewInvalid ? 0xd94d4d : 0x4cad9b) : colorFor(item.kind), roughness: 0.85, transparent: preview, opacity: preview ? .65 : 1 }), [item.kind, preview, previewInvalid]);
  const raycast = useMemo(
    () => furnishingRaycast((point) => runtime.clip?.keeps(item.floorId, point) !== false),
    [item.floorId, runtime],
  );

  useEffect(() => {
    const group = root.current;
    if (!group || !runtime.clip) return;
    group.traverse((object) => { if ((object as THREE.Mesh).isMesh) runtime.clip!.attach(object, item.floorId); });
  }, [fingerprint, item.floorId, material, runtime]);
  useEffect(() => () => material.dispose(), [material]);

  useFrame(() => {
    const group = root.current;
    if (!group) return;
    const floorNodes = runtime.index?.floorNodes.get(item.floorId);
    group.visible = !!runtime.manifest?.floors.has(item.floorId) &&
      !runtime.index?.hiddenGroups.has(item.floorId) && (!floorNodes?.length || floorNodes.some(isVisibleUp));
    group.position.y = item.position[1] + (runtime.offsets.get(item.floorId) ?? 0);
  });

  return <group ref={root} name={preview ? "vh-furniture-preview" : `furnishing:${item.id}`} userData={{ furnishingId: item.id, furnishingSize: [item.widthM, item.heightM, item.depthM] }} position={[item.position[0], item.position[1], item.position[2]]} rotation={[0, THREE.MathUtils.degToRad(item.rotationYDeg), 0]} onClick={(event) => { if (tool !== "select") return; event.stopPropagation(); if (item.id && !draft) requestEdit(item.id); }}>
    <mesh
      geometry={furnishingGeometry(item.kind)}
      material={material}
      raycast={raycast}
      scale={[item.widthM, item.heightM, item.depthM]}
      castShadow={!preview}
      receiveShadow={!preview}
      dispose={null}
    />
  </group>;
}
function colorFor(kind: string): number { return kind === "rug" ? 0x8b6f60 : kind.includes("bed") ? 0xb7c4ca : kind.includes("sofa") ? 0x9d826c : 0x9a8066; }
