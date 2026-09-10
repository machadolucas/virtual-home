/** Lightweight procedural furniture authored as normalized unit envelopes. */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { FurnishingKind } from "../model/types";

function at(geometry: THREE.BufferGeometry, x: number, y: number, z: number) {
  geometry.translate(x, y, z);
  return geometry;
}

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  return at(new THREE.BoxGeometry(sx, sy, sz), x, y, z);
}

function cylinderBetween(from: THREE.Vector3, to: THREE.Vector3, radius: number) {
  const direction = to.clone().sub(from);
  const geometry = new THREE.CylinderGeometry(radius, radius, direction.length(), 7);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize(),
    ),
  );
  return at(geometry, ...from.clone().add(to).multiplyScalar(0.5).toArray());
}

function fourLegs(width = 0.72, depth = 0.64, height = 0.68, thickness = 0.08) {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-width / 2, width / 2]) {
    for (const z of [-depth / 2, depth / 2]) {
      parts.push(box(x, height / 2, z, thickness, height, thickness));
    }
  }
  return parts;
}

function rawGeometry(kind: FurnishingKind): THREE.BufferGeometry {
  let parts: THREE.BufferGeometry[];
  switch (kind) {
    case "sofa":
      parts = [
        box(0, 0.28, 0, 0.86, 0.32, 0.82),
        box(0, 0.68, 0.35, 0.9, 0.62, 0.16),
        box(-0.47, 0.42, 0, 0.12, 0.52, 0.84),
        box(0.47, 0.42, 0, 0.12, 0.52, 0.84),
        box(0, 0.48, -0.04, 0.72, 0.12, 0.62),
      ];
      break;
    case "sofa_l":
      // Rear run plus a left chaise leaves the front-right footprint visibly empty.
      parts = [
        box(0, 0.28, 0.25, 0.94, 0.32, 0.48),
        box(-0.32, 0.28, -0.22, 0.3, 0.32, 0.94),
        box(0, 0.67, 0.45, 0.98, 0.62, 0.12),
        box(-0.47, 0.43, 0, 0.1, 0.54, 0.92),
        box(0.47, 0.43, 0.25, 0.1, 0.54, 0.5),
      ];
      break;
    case "bed_single":
    case "bed_double":
      parts = [
        box(0, 0.16, 0, 0.94, 0.24, 0.92),
        box(0, 0.36, -0.02, 0.9, 0.2, 0.84),
        box(0, 0.55, 0.45, 1, 0.86, 0.1),
        box(0, 0.48, -0.27, kind === "bed_single" ? 0.5 : 0.78, 0.12, 0.28),
      ];
      break;
    case "bedside_table":
      parts = [
        ...fourLegs(0.66, 0.58, 0.64, 0.09),
        box(0, 0.7, 0, 0.84, 0.12, 0.78),
        box(0, 0.49, 0.34, 0.68, 0.24, 0.08),
        at(new THREE.SphereGeometry(0.035, 7, 5), 0, 0.49, 0.39),
      ];
      break;
    case "chair":
      parts = [
        ...fourLegs(0.66, 0.62, 0.48, 0.08),
        box(0, 0.52, 0, 0.82, 0.12, 0.78),
        box(0, 0.8, 0.34, 0.82, 0.52, 0.1),
      ];
      break;
    case "dining_table":
      parts = [...fourLegs(), box(0, 0.75, 0, 0.98, 0.14, 0.96)];
      break;
    case "computer_desk":
      parts = [
        ...fourLegs(0.8, 0.65, 0.6, 0.07),
        box(0, 0.64, 0, 1, 0.12, 0.8),
        box(0, 0.82, 0.12, 0.48, 0.3, 0.06),
        box(0, 0.69, 0.1, 0.06, 0.18, 0.06),
      ];
      break;
    case "bicycle": {
      const rear = new THREE.Vector3(-0.34, 0.31, 0);
      const front = new THREE.Vector3(0.34, 0.31, 0);
      const crank = new THREE.Vector3(-0.02, 0.31, 0);
      const seat = new THREE.Vector3(-0.11, 0.69, 0);
      const head = new THREE.Vector3(0.2, 0.65, 0);
      parts = [
        at(new THREE.TorusGeometry(0.27, 0.028, 7, 18), rear.x, rear.y, 0),
        at(new THREE.TorusGeometry(0.27, 0.028, 7, 18), front.x, front.y, 0),
        cylinderBetween(rear, crank, 0.025),
        cylinderBetween(crank, seat, 0.025),
        cylinderBetween(seat, rear, 0.025),
        cylinderBetween(seat, head, 0.025),
        cylinderBetween(head, crank, 0.025),
        cylinderBetween(head, front, 0.022),
        box(-0.13, 0.72, 0, 0.19, 0.055, 0.09),
        cylinderBetween(head, new THREE.Vector3(0.24, 0.77, 0), 0.018),
        box(0.24, 0.77, 0, 0.05, 0.04, 0.34),
      ];
      break;
    }
    case "shelves":
      parts = [
        box(-0.46, 0.5, 0, 0.08, 1, 0.72),
        box(0.46, 0.5, 0, 0.08, 1, 0.72),
        ...[0.04, 0.35, 0.66, 0.96].map((y) => box(0, y, 0, 0.92, 0.08, 0.72)),
      ];
      break;
    case "cabinet":
      parts = [
        box(-0.46, 0.5, 0, 0.08, 1, 0.9),
        box(0.46, 0.5, 0, 0.08, 1, 0.9),
        box(0, 0.04, 0, 0.92, 0.08, 0.9),
        box(0, 0.96, 0, 0.92, 0.08, 0.9),
        box(-0.23, 0.5, -0.47, 0.45, 0.84, 0.06),
        box(0.23, 0.5, -0.47, 0.45, 0.84, 0.06),
        at(new THREE.SphereGeometry(0.035, 7, 5), -0.05, 0.5, -0.515),
        at(new THREE.SphereGeometry(0.035, 7, 5), 0.05, 0.5, -0.515),
      ];
      break;
    case "kitchen_counter":
      parts = [
        box(0, 0.42, 0, 0.96, 0.8, 0.88),
        box(0, 0.88, 0, 1, 0.12, 1),
        box(-0.24, 0.43, -0.47, 0.43, 0.66, 0.05),
        box(0.24, 0.43, -0.47, 0.43, 0.66, 0.05),
        box(0, 0.46, -0.505, 0.035, 0.08, 0.035),
      ];
      break;
    case "rug":
      parts = [box(0, 0.025, 0, 1, 0.05, 1)];
      break;
    case "bench":
      parts = [
        ...fourLegs(0.78, 0.62, 0.62, 0.09),
        box(0, 0.68, 0, 1, 0.14, 0.78),
        box(0, 0.82, 0.33, 0.94, 0.36, 0.1),
      ];
      break;
  }
  return mergeGeometries(parts)!;
}

/** Normalize a recognisable authored shape for the instance's physical width/height/depth scale. */
function normalize(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box3 = geometry.boundingBox!;
  const size = box3.getSize(new THREE.Vector3());
  const center = box3.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -box3.min.y, -center.z);
  geometry.scale(1 / size.x, 1 / size.y, 1 / size.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

const cache = new Map<FurnishingKind, THREE.BufferGeometry>();

export function furnishingGeometry(kind: FurnishingKind): THREE.BufferGeometry {
  let geometry = cache.get(kind);
  if (!geometry) {
    geometry = normalize(rawGeometry(kind));
    cache.set(kind, geometry);
  }
  return geometry;
}

/** Test/app teardown only; live layers share these immutable geometries for their lifetime. */
export function disposeFurnishingGeometries(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}
