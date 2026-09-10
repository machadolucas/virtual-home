"use client";
/* eslint-disable react-hooks/immutability -- shadow maps and the HouseRuntime are imperative
   Three.js objects owned by the viewer, not React state. Geometry changes must dirty them. */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { Furnishing } from "@/house/model/types";
import { isVisibleUp } from "@/house/scene/applyVisibility";
import { disposeFurnishingGeometries, furnishingGeometry } from "@/house/scene/furnishingGeometry";
import { useHouseRuntime, useHouseStore } from "../../hooks/useHouseStore";
import { useFurnishings } from "./FurnishingsProvider";

export function FurnishingLayer() {
  const runtime = useHouseRuntime();
  const { items, preview } = useFurnishings();
  const shown = useHouseStore((s) => s.layers.furnishings);
  const gl = useThree((s) => s.gl);
  const rendered = preview ? [...items.filter((x) => x.id !== preview.id), preview] : items;
  const signature = rendered.map((x) => `${x.id}:${x.kind}:${x.floorId}:${x.position.join(",")}:${x.widthM}:${x.depthM}:${x.heightM}:${x.rotationYDeg}`).join("|");

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

  if (!shown) return null;
  return <group name="furnishings">{rendered.map((item) => <FurnishingObject key={item.id || "__preview"} item={item} />)}</group>;
}

function FurnishingObject({ item }: { item: Furnishing }) {
  const runtime = useHouseRuntime();
  const fingerprint = useHouseStore((s) => s.fingerprint);
  const { requestEdit } = useFurnishings();
  const root = useRef<THREE.Group>(null);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: colorFor(item.kind), roughness: 0.72 }), [item.kind]);

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

  return <group ref={root} name={`furnishing:${item.id}`} userData={{ furnishingSize: [item.widthM, item.heightM, item.depthM] }} position={[item.position[0], item.position[1], item.position[2]]} rotation={[0, THREE.MathUtils.degToRad(item.rotationYDeg), 0]} onClick={(event) => { event.stopPropagation(); if (item.id) requestEdit(item.id); }}>
    <mesh
      geometry={furnishingGeometry(item.kind)}
      material={material}
      scale={[item.widthM, item.heightM, item.depthM]}
      castShadow
      receiveShadow
      dispose={null}
    />
  </group>;
}
function colorFor(kind: string): number { return kind === "rug" ? 0x8b6f60 : kind.includes("bed") ? 0xb7c4ca : kind.includes("sofa") ? 0x9d826c : 0x9a8066; }
