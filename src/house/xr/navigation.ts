import * as THREE from "three";
import { poleOfInaccessibility } from "../model/geometry2d";
import type { Room, Surface, Vec3 } from "../model/types";

export function roomLanding(room: Room): Vec3 | null {
  if (!room.footprint || room.kind === "void" || room.kind === "attic") return null;
  const { point, clearance } = poleOfInaccessibility(room.footprint);
  return clearance > 0.2 ? [point[0], room.floorElevation, point[1]] : null;
}

const walkRoles = new Set([
  "ground",
  "terrain",
  "paving",
  "step",
  "outdoor-stair",
  "terrace",
  "balcony",
  "door-threshold",
]);
const walkElements = new Set(["stair", "step", "paving", "terrain", "terrace", "balcony"]);
export function walkable(surface: Surface | undefined, normalY: number, elementKind?: string): boolean {
  if (!surface || normalY < 0.72) return false;
  return surface.kind === "floor" || walkRoles.has(surface.role ?? "") || walkElements.has(elementKind ?? "");
}

/** Move the tracked head's horizontal projection to the destination, keeping physical eye height. */
export function teleport(rig: THREE.Group, headInLocalFloor: THREE.Vector3, destination: THREE.Vector3) {
  const offset = headInLocalFloor.clone().applyQuaternion(rig.quaternion);
  rig.position.set(destination.x - offset.x, destination.y, destination.z - offset.z);
  rig.updateMatrixWorld(true);
}

export function turnAroundHead(rig: THREE.Group, head: THREE.Vector3, angle: number) {
  const before = head.clone().applyQuaternion(rig.quaternion);
  rig.rotateY(angle);
  const after = head.clone().applyQuaternion(rig.quaternion);
  rig.position.add(before.sub(after));
  rig.updateMatrixWorld(true);
}

export const smoothTurnMin = 35;
export const smoothTurnMax = 125;
export const smoothTurnDefault = 90;

export function smoothTurnAngle(x: number, y: number, dt: number, degreesPerSecond: number) {
  const magnitude = Math.min(1, Math.abs(x));
  if (magnitude <= 0.24 || magnitude <= 1.1 * Math.abs(y)) return 0;
  return -Math.sign(x) * THREE.MathUtils.degToRad(degreesPerSecond) * ((magnitude - 0.24) / 0.76) ** 1.35 * dt;
}

/** Collision uses the accepted tread; the tracked view follows it without a vertical snap. */
export class WalkElevation {
  floor = 0;
  rendered = 0;

  arrive(y: number) { this.floor = this.rendered = y; }

  follow(dt: number) {
    if (this.rendered === this.floor) return this.rendered;
    const remaining = (this.rendered - this.floor) * Math.exp(-dt / 0.042);
    this.rendered = Math.abs(remaining) <= 0.002 ? this.floor : this.floor + remaining;
    return this.rendered;
  }
}

/** Yaw of the wearer's gaze in the model. A positive yaw turns model north toward west. */
export function viewHeading(rig: THREE.Group, headOrientation: THREE.Quaternion): number {
  const forward = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(headOrientation)
    .applyQuaternion(rig.quaternion);
  return Math.atan2(-forward.x, -forward.z);
}

export function landFacing(
  rig: THREE.Group,
  head: THREE.Vector3,
  orientation: THREE.Quaternion,
  point: THREE.Vector3,
  heading: number,
) {
  rig.rotateY(heading - viewHeading(rig, orientation));
  teleport(rig, head, point);
}
