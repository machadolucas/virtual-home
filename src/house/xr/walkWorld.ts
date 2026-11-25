import * as THREE from "three";
import type { SceneIndex } from "../scene/SceneIndex";
import type { Vec3 } from "../model/types";
import { pointInFootprint } from "../model/geometry2d";
import { walkable } from "./navigation";

const CELL = 2;
const STEP = 0.27;
const RADIUS = 0.16;
const edgeOffsets = [
  [RADIUS, 0],
  [-RADIUS, 0],
  [0, RADIUS],
  [0, -RADIUS],
] as const;
interface Triangle {
  shape: THREE.Triangle;
  mesh: THREE.Mesh;
  stand: boolean;
  visited: number;
  door?: Door;
}
interface Door {
  mesh: THREE.Mesh;
  base: THREE.Matrix4;
  bounds: THREE.Box3;
  movingBounds: THREE.Box3;
  shapes: THREE.Triangle[];
  transformed: THREE.Triangle[];
  auto: boolean;
  hinge: THREE.Vector3;
  center: THREE.Vector3;
  width: number;
  height: number;
  amount: number;
  sign: number;
  axis: THREE.Vector3;
}
export interface WalkHit {
  point: THREE.Vector3;
  walkable: boolean;
  placementId?: string;
  object: THREE.Mesh;
}

/** World-space X/Z grid shared by arc segments, pointer occlusion, floor support and body clearance. */
export class WalkWorld {
  private cells = new Map<number, Map<number, Triangle[]>>();
  private wide: Triangle[] = [];
  private query = 0;
  private doors: Door[] = [];
  private moving = new Set<Door>();
  private ray = new THREE.Ray();
  private intersection = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private body = new THREE.Box3();
  private transform = new THREE.Matrix4();
  private offset = new THREE.Matrix4();
  private parentInverse = new THREE.Matrix4();
  private yardCandidates: THREE.Vector3[] = [];
  yard: Vec3 | null = null;

  constructor(index: SceneIndex) {
    for (const object of index.pickables) {
      if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) continue;
      const sid = index.meshSurfaceId.get(object);
      const surface = sid ? index.manifest.surfaces.get(sid) : undefined;
      const element = surface?.elementId ? index.manifest.elements.get(surface.elementId) : undefined;
      if (element?.kind === "scan-reference") continue;
      object.updateWorldMatrix(true, false);
      const geometry = object.geometry as THREE.BufferGeometry;
      const position = geometry.getAttribute("position");
      if (!position) continue;
      const vertices: THREE.Vector3[] = [];
      for (let i = 0; i < position.count; i++)
        vertices.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld));
      const box = new THREE.Box3().setFromPoints(vertices);
      let door: Door | undefined;
      if (surface?.role === "door-leaf") {
        const center = box.getCenter(new THREE.Vector3());
        let far = vertices[0]!,
          horizontal = 0;
        for (const v of vertices) {
          const distance = Math.hypot(v.x - center.x, v.z - center.z);
          if (distance > horizontal) {
            far = v;
            horizontal = distance;
          }
        }
        const axis = new THREE.Vector3(far.x - center.x, 0, far.z - center.z).normalize();
        door = {
          mesh: object,
          base: object.matrix.clone(),
          bounds: box,
          movingBounds: box.clone(),
          shapes: [],
          transformed: [],
          auto: object.matrixAutoUpdate,
          hinge: center.clone().addScaledVector(axis, horizontal),
          center,
          width: horizontal * 2,
          height: box.max.y - box.min.y,
          amount: 0,
          sign: 1,
          axis,
        };
        this.doors.push(door);
      }
      const inds = geometry.index;
      for (let i = 0; i + 2 < (inds?.count ?? position.count); i += 3) {
        const a = vertices[inds ? inds.getX(i) : i]!,
          b = vertices[inds ? inds.getX(i + 1) : i + 1]!,
          c = vertices[inds ? inds.getX(i + 2) : i + 2]!;
        const shape = new THREE.Triangle(a, b, c);
        const normal = shape.getNormal(this.normal);
        const yard = surface?.role === "paving" || surface?.role === "ground";
        // Some authored terrain and two-sided floors have downward winding.
        const stand = walkable(surface, normal.y, element?.kind) || (yard && Math.abs(normal.y) >= 0.72);
        const tri = { shape, mesh: object, stand, door, visited: 0 };
        if (door) {
          door.shapes.push(shape);
          door.transformed.push(shape.clone());
        }
        this.insert(tri);
        if (stand && yard) this.yardCandidates.push(shape.getMidpoint(new THREE.Vector3()));
      }
    }
    // Prefer outdoor ground near a building. Tiny slivers at the model boundary fail the footprint check.
    const room = [...index.manifest.rooms.values()].find((r) => r.footprint?.outer.length);
    const reference = room?.footprint?.outer[0];
    if (reference)
      this.yardCandidates.sort(
        (a, b) =>
          Math.hypot(a.x - reference[0], a.z - reference[1]) -
          Math.hypot(b.x - reference[0], b.z - reference[1]),
      );
    for (const p of this.yardCandidates) {
      if (
        this.canStand(p, 1.75) &&
        ![...index.manifest.rooms.values()].some(
          (r) =>
            r.footprint && Math.abs(r.floorElevation - p.y) < 1 && pointInFootprint(p.x, p.z, r.footprint),
        )
      ) {
        this.yard = p.toArray();
        break;
      }
    }
    this.yardCandidates.length = 0;
  }
  private insert(t: Triangle) {
    const { a, b, c } = t.shape;
    const x0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL),
      x1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL);
    const z0 = Math.floor(Math.min(a.z, b.z, c.z) / CELL),
      z1 = Math.floor(Math.max(a.z, b.z, c.z) / CELL);
    // Protect against enormous reference planes in third-party packages.
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > 2048) {
      this.wide.push(t);
      return;
    }
    for (let x = x0; x <= x1; x++) {
      let column = this.cells.get(x);
      if (!column) this.cells.set(x, (column = new Map()));
      for (let z = z0; z <= z1; z++) {
        let bucket = column.get(z);
        if (!bucket) column.set(z, (bucket = []));
        bucket.push(t);
      }
    }
  }
  hit(ray: THREE.Ray, limit: number, floorsOnly = false): WalkHit | null {
    const serial = ++this.query;
    let nearest = limit,
      mesh: THREE.Mesh | undefined,
      standing = false;
    const point = new THREE.Vector3();
    const visit = (triangles: Triangle[] | undefined) => {
      if (!triangles) return;
      for (const t of triangles) {
        if (t.visited === serial || (floorsOnly && !t.stand) || (t.door && t.door.amount > 0)) continue;
        t.visited = serial;
        const { a, b, c } = t.shape;
        if (!ray.intersectTriangle(a, b, c, false, this.intersection)) continue;
        const dist = ray.origin.distanceTo(this.intersection);
        if (dist > nearest || (mesh && Math.abs(nearest - dist) < 0.00001 && !t.stand)) continue;
        nearest = dist;
        mesh = t.mesh;
        standing = t.stand;
        point.copy(this.intersection);
      }
    };
    if (!floorsOnly) {
      for (const door of this.moving) {
        if (!ray.intersectsBox(door.movingBounds)) continue;
        for (const shape of door.transformed) {
          if (!ray.intersectTriangle(shape.a, shape.b, shape.c, false, this.intersection)) continue;
          const distance = ray.origin.distanceTo(this.intersection);
          if (distance > nearest) continue;
          nearest = distance;
          mesh = door.mesh;
          point.copy(this.intersection);
        }
      }
    }
    visit(this.wide);
    const { x, z } = ray.direction,
      origin = ray.origin;
    let ix = Math.floor(origin.x / CELL),
      iz = Math.floor(origin.z / CELL);
    const dx = Math.sign(x),
      dz = Math.sign(z);
    const stepX = x === 0 ? Infinity : CELL / Math.abs(x),
      stepZ = z === 0 ? Infinity : CELL / Math.abs(z);
    let tx = x === 0 ? Infinity : ((ix + (dx > 0 ? 1 : 0)) * CELL - origin.x) / x;
    let tz = z === 0 ? Infinity : ((iz + (dz > 0 ? 1 : 0)) * CELL - origin.z) / z;
    for (;;) {
      visit(this.cells.get(ix)?.get(iz));
      if (Math.min(tx, tz) > nearest) break;
      if (tx < tz) {
        ix += dx;
        tx += stepX;
      } else {
        iz += dz;
        tz += stepZ;
      }
    }
    return mesh
      ? { point, walkable: standing, object: mesh, placementId: (mesh as THREE.Mesh).userData.vhPlacementId }
      : null;
  }
  private support(x: number, z: number, y: number, rise = STEP, drop = STEP) {
    this.ray.origin.set(x, y + rise + 0.005, z);
    this.ray.direction.set(0, -1, 0);
    return this.hit(this.ray, rise + drop + 0.01, true)?.point;
  }
  canStand(p: THREE.Vector3, height: number) {
    for (const [dx, dz] of edgeOffsets) if (!this.support(p.x + dx, p.z + dz, p.y)) return false;
    const b = this.body;
    b.min.set(p.x - RADIUS, p.y + STEP + 0.012, p.z - RADIUS);
    b.max.set(p.x + RADIUS, p.y + Math.max(1.05, height) + 0.08, p.z + RADIUS);
    const obstacle = (t: Triangle) => !(t.door && t.door.amount > 0) && b.intersectsTriangle(t.shape);
    for (const door of this.moving)
      if (b.intersectsBox(door.movingBounds) && door.transformed.some((t) => b.intersectsTriangle(t)))
        return false;
    if (this.wide.some(obstacle)) return false;
    for (let x = Math.floor(b.min.x / CELL); x <= Math.floor(b.max.x / CELL); x++)
      for (let z = Math.floor(b.min.z / CELL); z <= Math.floor(b.max.z / CELL); z++)
        if (this.cells.get(x)?.get(z)?.some(obstacle)) return false;
    return true;
  }
  step(from: THREE.Vector3, dx: number, dz: number, height: number) {
    const p = this.support(from.x + dx, from.z + dz, from.y);
    return p && this.canStand(p, height) ? p : null;
  }
  landing(near: THREE.Vector3, height: number) {
    for (const radius of [0, 0.4, 0.8, 1.2]) {
      for (let i = 0; i < (radius === 0 ? 1 : 12); i++) {
        const angle = (i * Math.PI) / 6;
        const p = this.support(
          near.x + radius * Math.cos(angle),
          near.z + radius * Math.sin(angle),
          near.y,
          0.45,
          0.65,
        );
        if (p && this.canStand(p, height)) return p;
      }
    }
    return null;
  }
  updateDoors(head: THREE.Vector3, dt: number) {
    for (const d of this.doors) {
      const dx = head.x - d.center.x,
        dz = head.z - d.center.z;
      const close =
        Math.abs(head.y - d.center.y) < d.height / 2 + 0.35 &&
        Math.hypot(dx, dz) < Math.max(1.65, d.width * 0.65);
      if ((!close && d.amount === 0) || (close && d.amount === 1)) continue;
      if (close && !d.amount) d.sign = dx * d.axis.z - dz * d.axis.x >= 0 ? 1 : -1;
      d.amount = THREE.MathUtils.clamp(d.amount + (close ? 1 : -1) * dt * 3, 0, 1);
      const ease = d.amount * d.amount * (3 - 2 * d.amount);
      if (d.width > 2.15) this.transform.makeTranslation(0, (d.height + 0.1) * ease, 0);
      else
        this.transform
          .makeTranslation(d.hinge.x, d.hinge.y, d.hinge.z)
          .multiply(this.offset.makeRotationY(d.sign * ease * Math.PI * 0.49))
          .multiply(this.offset.makeTranslation(-d.hinge.x, -d.hinge.y, -d.hinge.z));
      if (d.amount > 0) {
        this.moving.add(d);
        d.movingBounds.copy(d.bounds).applyMatrix4(this.transform);
        d.shapes.forEach((shape, i) => {
          const out = d.transformed[i]!;
          out.a.copy(shape.a).applyMatrix4(this.transform);
          out.b.copy(shape.b).applyMatrix4(this.transform);
          out.c.copy(shape.c).applyMatrix4(this.transform);
        });
      } else this.moving.delete(d);
      const parent = d.mesh.parent;
      if (parent)
        this.transform
          .premultiply(this.parentInverse.copy(parent.matrixWorld).invert())
          .multiply(parent.matrixWorld);
      d.mesh.matrixAutoUpdate = false;
      d.mesh.matrix.multiplyMatrices(this.transform, d.base);
      d.mesh.matrixWorldNeedsUpdate = true;
    }
  }
  dispose() {
    for (const d of this.doors) {
      d.mesh.matrix.copy(d.base);
      d.mesh.matrixAutoUpdate = d.auto;
      d.mesh.matrixWorldNeedsUpdate = true;
    }
  }
}
