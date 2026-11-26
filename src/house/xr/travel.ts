import * as THREE from "three";
import type { WalkWorld } from "./walkWorld";
import type { MarkerLayer } from "../scene/markers";
import { isVisibleUp } from "../scene/applyVisibility";

export const HAND_AIM_MS = 240;
export function stickAxes(pad?: Gamepad) {
  const a = pad?.axes;
  return { x: a?.[2] ?? a?.[0] ?? 0, y: a?.[3] ?? a?.[1] ?? 0 };
}
export function stickIntent(x: number, y: number): "aim" | "left" | "right" | null {
  if (y < -0.63 && -y > Math.abs(x) * 1.1) return "aim";
  if (Math.abs(x) > 0.72 && Math.abs(x) > Math.abs(y) * 1.1) return x > 0 ? "right" : "left";
  return null;
}

/** Single reusable arc and landing footprint. Coordinates are in the physical model's world space. */
export class TeleportArc {
  readonly group = new THREE.Group();
  private points = new Float32Array(3 * 41);
  private geometry = new THREE.BufferGeometry();
  private ink = new THREE.LineBasicMaterial({ color: 0x72e2d3, depthWrite: false });
  private ring = new THREE.Mesh(
    new THREE.RingGeometry(0.17, 0.21, 36),
    new THREE.MeshBasicMaterial({
      color: 0x68e9bf,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    }),
  );
  // An asymmetric chevron makes arrival orientation readable at a glance.
  private readonly arrow = new THREE.Mesh(
    new THREE.ShapeGeometry(
      new THREE.Shape([
        new THREE.Vector2(0, 0.31),
        new THREE.Vector2(-0.105, 0.12),
        new THREE.Vector2(0, 0.16),
        new THREE.Vector2(0.105, 0.12),
      ]),
    ),
    this.ring.material,
  );
  private previous = new THREE.Vector3();
  private current = new THREE.Vector3();
  private segment = new THREE.Ray();
  landing: THREE.Vector3 | null = null;
  constructor() {
    this.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(this.points, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const line = new THREE.Line(this.geometry, this.ink);
    line.frustumCulled = false;
    this.group.name = "vh-teleport-preview";
    this.ring.name = "vh-teleport-landing";
    this.group.add(line, this.ring);
    this.ring.add(this.arrow);
    this.arrow.renderOrder = 999;
    this.group.visible = false;
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 998;
  }
  aim(world: WalkWorld, ray: THREE.Ray, height: number, heading = 0) {
    this.landing = null;
    this.group.visible = true;
    this.previous.copy(ray.origin);
    this.previous.toArray(this.points, 0);
    let count = 1;
    for (let i = 1; i <= 40; i++) {
      const t = i * 0.055;
      this.current.copy(ray.origin).addScaledVector(ray.direction, 6 * t);
      this.current.y += 1.6 * t - 4.9 * t * t;
      this.segment.origin.copy(this.previous);
      const length = this.segment.direction.subVectors(this.current, this.previous).length();
      this.segment.direction.normalize();
      const hit = world.hit(this.segment, length);
      if (hit) this.current.copy(hit.point);
      this.current.toArray(this.points, count++ * 3);
      if (hit) {
        if (hit.walkable && world.canStand(hit.point, height)) this.landing = hit.point;
        break;
      }
      this.previous.copy(this.current);
    }
    this.geometry.setDrawRange(0, count);
    this.geometry.attributes.position!.needsUpdate = true;
    this.ink.color.setHex(this.landing ? 0x72e2d3 : 0xe8a471);
    this.ring.visible = !!this.landing;
    if (this.landing) {
      this.ring.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, heading);
      this.ring.rotateX(-Math.PI / 2);
      this.ring.position.copy(this.landing);
      this.ring.position.y += 0.02;
    }
  }
  clear() {
    this.group.visible = false;
    this.landing = null;
  }
  dispose() {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.ink.dispose();
    this.ring.geometry.dispose();
    this.ring.material.dispose();
    this.arrow.geometry.dispose();
  }
}

export interface WorldTarget {
  id: string | null;
  point: THREE.Vector3;
  floor: boolean;
  mesh: THREE.Mesh;
  instanceId?: number;
  doorId?: string;
}
interface Instances {
  version: number;
  world: THREE.Matrix4;
  boxes: THREE.Box3[];
}
export class EquipmentPicker {
  private cache = new WeakMap<THREE.InstancedMesh, Instances>();
  private instance = new THREE.Matrix4();
  private proxy = new THREE.Mesh();
  private hits: THREE.Intersection[] = [];
  private near = new THREE.Vector3();
  target(world: WalkWorld, ray: THREE.Raycaster, markers: MarkerLayer | null): WorldTarget | null {
    const hit = world.hit(ray.ray, 18);
    let limit = hit ? ray.ray.origin.distanceTo(hit.point) + 0.012 : 18;
    let result: WorldTarget | null = hit
      ? {
          id: hit.placementId ?? null,
          point: hit.point,
          floor: hit.walkable,
          mesh: hit.object,
          doorId: hit.doorId,
        }
      : null;
    for (const mesh of markers?.meshes ?? []) {
      if (!mesh.count || !isVisibleUp(mesh)) continue;
      mesh.updateWorldMatrix(true, false);
      let group = this.cache.get(mesh);
      if (
        !group ||
        group.version !== mesh.instanceMatrix.version ||
        group.boxes.length !== mesh.count ||
        !group.world.equals(mesh.matrixWorld)
      ) {
        mesh.geometry.computeBoundingBox();
        group = { version: mesh.instanceMatrix.version, world: mesh.matrixWorld.clone(), boxes: [] };
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, this.instance);
          this.instance.premultiply(mesh.matrixWorld);
          group.boxes.push(mesh.geometry.boundingBox!.clone().applyMatrix4(this.instance));
        }
        this.cache.set(mesh, group);
      }
      for (let i = 0; i < mesh.count; i++) {
        const box = group.boxes[i]!;
        if (
          !ray.ray.intersectBox(box, this.near) ||
          (!box.containsPoint(ray.ray.origin) && ray.ray.origin.distanceTo(this.near) > limit)
        )
          continue;
        this.proxy.geometry = mesh.geometry;
        this.proxy.material = mesh.material;
        mesh.getMatrixAt(i, this.proxy.matrixWorld);
        this.proxy.matrixWorld.premultiply(mesh.matrixWorld);
        this.hits.length = 0;
        this.proxy.raycast(ray, this.hits);
        for (const item of this.hits)
          if (item.distance <= limit) {
            const id = markers!.placementAt(mesh, i);
            if (id) {
              result = { id, floor: false, point: item.point, mesh, instanceId: i };
              limit = item.distance;
            }
          }
      }
    }
    return result;
  }
}
