import * as THREE from "three";
import type { HeadsetLocateTarget } from "./headsetTasksTypes";
import type { WalkWorld } from "./walkWorld";
import type { Room } from "../model/types";

/** Prefer a clear sightline from an actual walkable patch, facing the requested item. */
export function inspectionLanding(
  world: WalkWorld,
  target: THREE.Vector3,
  room: Room | undefined,
  floor: number,
  height: number,
  placementId?: string | null,
) {
  const sight = new THREE.Ray(),
    delta = new THREE.Vector3();
  for (const r of [1.15, 1.65, 0.85, 2.1]) {
    for (let i = 0; i < 12; i++) {
      const yaw = (i * Math.PI) / 6;
      const p = world.landing(
        new THREE.Vector3(target.x + r * Math.sin(yaw), floor, target.z + r * Math.cos(yaw)),
        height,
        room,
      );
      if (!p || Math.hypot(target.x - p.x, target.z - p.z) < 0.55) continue;
      sight.origin.copy(p).y += height;
      delta.subVectors(target, sight.origin);
      const length = delta.length();
      sight.direction.copy(delta.normalize());
      const obstruction = world.hit(sight, Math.max(0, length - 0.28));
      if (obstruction && (!placementId || obstruction.placementId !== placementId)) continue;
      return { point: p, heading: Math.atan2(p.x - target.x, p.z - target.z) };
    }
  }
  return null;
}

export class GuidanceMarker {
  readonly group = new THREE.Group();
  private ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.105, 0.008, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0x75ffcd }),
  );
  target: HeadsetLocateTarget | null = null;
  constructor() {
    this.group.add(this.ring);
    this.group.visible = false;
  }
  set(target: HeadsetLocateTarget | null) {
    this.target = target;
    this.group.visible = false;
  }
  update(matrix: THREE.Matrix4 | null, roomId: string | null, head: THREE.Vector3) {
    const t = this.target;
    this.group.visible = !!(matrix && t?.position && (!roomId || roomId === t.roomId));
    if (!this.group.visible || !t?.position || !matrix) return;
    this.group.position.fromArray(t.position).applyMatrix4(matrix);
    this.group.lookAt(head);
    this.group.updateWorldMatrix(true, true);
  }
  hit(ray: THREE.Ray) {
    if (!this.group.visible || !this.target) return null;
    const sphere = new THREE.Sphere(this.group.position, 0.13);
    return ray.intersectSphere(sphere, new THREE.Vector3());
  }
  dispose() {
    this.group.removeFromParent();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
  }
}
