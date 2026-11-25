import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { classifyAirStream } from "@/domain/airStream";
import { roomAt } from "@/house/model/manifestIndex";
import { routePointPlace } from "@/house/model/routePlaces";
import type { Route } from "@/house/model/types";
import type { SceneIndex } from "./SceneIndex";

const PROBE_DISTANCE = 0.04;
const WALL_CONTACT_TOLERANCE = 0.008;
const LEVEL_TOLERANCE = Math.sin(THREE.MathUtils.degToRad(2));
const PERPENDICULAR_TOLERANCE = Math.cos(THREE.MathUtils.degToRad(5));
const ROOM_STANDOFF = 0.007;
const TEE_TOLERANCE = 0.005;
const MIN_VALVE_DROP = 0.02;
const MAX_VALVE_DROP = 0.35;
const OUTLET_NORMAL = new THREE.Vector3(0, 0, 1);

export interface DuctOutlet {
  surfaceId?: string;
  floorId: string;
  /** Physical contact point, without presentation offsets. */
  contact: THREE.Vector3;
  roomNormal: THREE.Vector3;
}

export function matchDuctOutlet(
  index: SceneIndex, route: Route, end: number, routes: readonly Route[],
): DuctOutlet | null {
  if (!activeDuct(route) || route.pointKinds?.[end] !== "outlet") return null;
  const stream = classifyAirStream(route.medium, route.airStream);
  if (stream !== "room_supply" && stream !== "room_extract") return null;
  const last = route.points.length - 1;
  if (last < 1 || (end !== 0 && end !== last)) return null;
  const { floorId, roomId } = routePointPlace(route, end);
  const manifest = index.manifest;
  if (!floorId || !roomId || manifest.rooms.get(roomId)?.floorId !== floorId) return null;

  const contact = new THREE.Vector3(...route.points[end]!);
  const axis = new THREE.Vector3();
  const step = end === 0 ? 1 : -1;
  for (let i = end + step; i >= 0 && i <= last; i += step) {
    axis.set(...route.points[i]!).sub(contact);
    if (axis.lengthSq() > 1e-10) break;
  }
  if (axis.lengthSq() <= 1e-10) return null;
  const length = axis.length();
  axis.divideScalar(length);
  if (axis.y >= PERPENDICULAR_TOLERANCE && length >= MIN_VALVE_DROP && length <= MAX_VALVE_DROP &&
      roomAt(manifest, floorId, contact.x, contact.z) === roomId &&
      hasHorizontalThroughRun(routes, route, floorId, contact.clone().addScaledVector(axis, length))) {
    return { floorId, contact, roomNormal: new THREE.Vector3(0, -1, 0) };
  }
  if (Math.abs(axis.y) > LEVEL_TOLERANCE) return null;
  return matchFinishedWall(index, floorId, roomId, contact, axis.setY(0).normalize());
}

function activeDuct(route: Route): boolean {
  return route.kind === "duct" && route.lifecycle === "installed" && route.certainty !== "unknown" &&
    route.flowState === "active" && !route.needsReconciliation;
}

function hasHorizontalThroughRun(
  routes: readonly Route[], branch: Route, floorId: string, tee: THREE.Vector3,
): boolean {
  const directions: THREE.Vector3[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const projected = new THREE.Vector3();
  for (const route of routes) {
    if (route === branch || !activeDuct(route) || route.medium !== branch.medium) continue;
    for (let i = 0; i < route.points.length - 1; i++) {
      if (route.segments[i]?.floorId !== floorId) continue;
      a.set(...route.points[i]!);
      b.set(...route.points[i + 1]!);
      axis.subVectors(b, a);
      const length = axis.length();
      if (length <= TEE_TOLERANCE || Math.abs(axis.y) / length > LEVEL_TOLERANCE) continue;
      axis.divideScalar(length);
      const station = THREE.MathUtils.clamp(projected.subVectors(tee, a).dot(axis), 0, length);
      projected.copy(a).addScaledVector(axis, station);
      if (projected.distanceToSquared(tee) > TEE_TOLERANCE ** 2) continue;
      // A tee can lie inside one span or at a junction split across adjacent route records.
      const towardsA = station > TEE_TOLERANCE;
      const towardsB = length - station > TEE_TOLERANCE;
      if (towardsA && towardsB) return true;
      const direction = axis.clone().multiplyScalar(towardsA ? -1 : 1);
      if (directions.some((other) => other.dot(direction) <= -PERPENDICULAR_TOLERANCE)) return true;
      directions.push(direction);
    }
  }
  return false;
}

function matchFinishedWall(
  index: SceneIndex, floorId: string, roomId: string, contact: THREE.Vector3, axis: THREE.Vector3,
): DuctOutlet | null {
  const manifest = index.manifest;
  const sample = contact.clone();
  const roomOnSide = (sign: number) => {
    sample.copy(contact).addScaledVector(axis, sign * PROBE_DISTANCE);
    return roomAt(manifest, floorId, sample.x, sample.z) === roomId;
  };
  const positive = roomOnSide(1);
  const negative = roomOnSide(-1);
  if (positive === negative) return null;
  const roomNormal = axis.multiplyScalar(positive ? 1 : -1);

  const offsetY = index.floorNodes.get(floorId)?.[0]?.position.y ??
    index.overlay.floorGroups.get(floorId)?.position.y ?? 0;
  const origin = contact.clone().addScaledVector(roomNormal, PROBE_DISTANCE);
  origin.y += offsetY;
  const ray = new THREE.Raycaster(origin, roomNormal.clone().negate(), 0, PROBE_DISTANCE * 2);
  const normalMatrix = new THREE.Matrix3();
  const normal = new THREE.Vector3();
  for (const sid of manifest.roomSurfaces.get(roomId) ?? []) {
    if (manifest.surfaces.get(sid)?.kind !== "wall") continue;
    const mesh = index.surfaceMesh.get(sid);
    if (!mesh) continue;
    mesh.updateWorldMatrix(true, false);
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (const hit of ray.intersectObject(mesh, false)) {
      if (!hit.face || Math.abs(hit.distance - PROBE_DISTANCE) > WALL_CONTACT_TOLERANCE) continue;
      normal.copy(hit.face.normal).applyNormalMatrix(normalMatrix);
      if (Math.abs(normal.y) > LEVEL_TOLERANCE ||
          Math.abs(normal.dot(roomNormal)) < PERPENDICULAR_TOLERANCE) continue;
      // The span establishes the room side. The face normal keeps the entire grille flush.
      if (normal.dot(roomNormal) < 0) normal.negate();
      hit.point.y -= offsetY;
      return { surfaceId: sid, floorId, contact: hit.point, roomNormal: normal };
    }
  }
  return null;
}

/** A display-only, shallow grille. Vertex colours keep it in one draw call. */
export function ductOutletGeometry(route: Route, outlet: DuctOutlet, bodyColor: number): THREE.BufferGeometry {
  const radius = THREE.MathUtils.clamp((route.diameterM ?? route.widthM ?? 0.125) / 2, 0.025, 0.16);
  const pale = new THREE.Color(0xf0ebdf);
  const recess = new THREE.Color(bodyColor).multiplyScalar(0.48);
  const pieces = [
    paint(new THREE.CircleGeometry(radius, 24), recess),
    paint(new THREE.RingGeometry(radius * 0.78, radius, 24).translate(0, 0, 0.0008), pale),
  ];
  if (outlet.surfaceId) {
    for (const height of [-0.37, 0, 0.37]) {
      const halfLength = radius * Math.sqrt(0.76 ** 2 - height ** 2);
      const slat = new THREE.PlaneGeometry(halfLength * 2, radius * 0.11)
        .translate(0, height * radius, 0.0016);
      pieces.push(paint(slat, pale));
    }
  } else {
    // The hanging diffuser is a disc with an annular gap inside the fixed rim.
    pieces.push(paint(new THREE.CircleGeometry(radius * 0.65, 24).translate(0, 0, 0.0016), pale));
  }
  const geometry = mergeGeometries(pieces)!;
  for (const piece of pieces) piece.dispose();
  const position = outlet.contact.clone().addScaledVector(outlet.roomNormal, ROOM_STANDOFF);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(OUTLET_NORMAL, outlet.roomNormal));
  geometry.translate(...position.toArray());
  return geometry;
}

function paint(geometry: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const colors = new Float32Array(geometry.getAttribute("position").count * 3);
  for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}
