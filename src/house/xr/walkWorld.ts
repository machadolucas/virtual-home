import * as THREE from "three";
import type { SceneIndex } from "../scene/SceneIndex";
import { pointInFootprint } from "../model/geometry2d";
import type { Room, Vec3 } from "../model/types";
import { DoorPassage } from "./doorPassage";
import { walkable } from "./navigation";
import { SolidInterior } from "./solidInterior";

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
  door?: DoorPassage;
  foundation: boolean;
}
export interface WalkHit {
  point: THREE.Vector3;
  walkable: boolean;
  placementId?: string;
  doorId?: string;
  object: THREE.Mesh;
}

/** World-space X/Z grid shared by arc segments, pointer occlusion, floor support and body clearance. */
export class WalkWorld {
  private cells = new Map<number, Map<number, Triangle[]>>();
  private wide: Triangle[] = [];
  private query = 0;
  private doors = new Map<THREE.Mesh, DoorPassage>();
  private buildingBounds: THREE.Box2[];
  private thresholds: THREE.Triangle[] = [];
  private nearThreshold = new THREE.Vector3();
  private skyRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  private ray = new THREE.Ray();
  private intersection = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private body = new THREE.Box3();
  private solids: SolidInterior[] = [];
  yard: Vec3 | null = null;
  yardHeading = 0;

  constructor(
    index: SceneIndex,
    private openedDoors = new Set<string>(),
  ) {
    // Project the whole building including upper floors. Terrain can extend underneath it.
    const buildings = new Map<string, THREE.Box2>();
    const point = new THREE.Vector2();
    for (const room of index.manifest.rooms.values()) {
      const id = room.buildingId ?? index.manifest.floors.get(room.floorId)?.buildingId ?? room.floorId;
      const bounds = buildings.get(id) ?? new THREE.Box2();
      for (const [x, z] of room.footprint?.outer ?? []) bounds.expandByPoint(point.set(x, z));
      buildings.set(id, bounds);
    }
    this.buildingBounds = [...buildings.values()].filter((box) => !box.isEmpty());
    const yardCandidates: THREE.Vector3[] = [];
    const floors = [...index.manifest.floors.values()];
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
      let door: DoorPassage | undefined;
      if (sid && surface?.role === "door-leaf") {
        door = new DoorPassage(sid, object, new THREE.Box3().setFromPoints(vertices));
        this.doors.set(object, door);
        if (this.openedDoors.has(sid)) door.clear(true);
      }
      const inds = geometry.index;
      const physicalSolid = element?.kind === "wall" || surface?.kind === "wall" || surface?.role === "wall" ||
        !!object.userData.vhPlacementId;
      const shell = physicalSolid ? new THREE.Box3().setFromPoints(vertices) : null;
      const solidFaces = shell && shell.max.x - shell.min.x > 2 * RADIUS &&
        shell.max.z - shell.min.z > 2 * RADIUS && shell.max.y - shell.min.y > .75 ? [] as THREE.Triangle[] : null;
      for (let i = 0; i + 2 < (inds?.count ?? position.count); i += 3) {
        const a = vertices[inds ? inds.getX(i) : i]!,
          b = vertices[inds ? inds.getX(i + 1) : i + 1]!,
          c = vertices[inds ? inds.getX(i + 2) : i + 2]!;
        const shape = new THREE.Triangle(a, b, c);
        solidFaces?.push(shape);
        const normal = shape.getNormal(this.normal);
        const yard = surface?.role === "paving" || surface?.role === "ground";
        // Some authored terrain and two-sided floors have downward winding.
        const slab =
          element?.kind === "slab" &&
          normal.y > 0.95 &&
          floors.some(
            (floor) =>
              (!element.buildingId || element.buildingId === floor.buildingId) &&
              Math.abs(a.y - floor.elevation) < 0.12,
          );
        const stand =
          slab || walkable(surface, normal.y, element?.kind) || (yard && Math.abs(normal.y) >= 0.72);
        if (stand && surface?.role === "door-threshold") this.thresholds.push(shape);
        const foundation = surface?.role === "plinth" || element?.kind === "footing";
        const tri = { shape, mesh: object, stand, door, foundation, visited: 0 };
        this.insert(tri);
        if (stand && yard) {
          yardCandidates.push(shape.getMidpoint(new THREE.Vector3()));
          // A coarse plot may have only two triangles with centroids underneath the house.
          if (shape.getArea() > 4) {
            const divisions = Math.min(16, Math.ceil(Math.sqrt(shape.getArea()) / 1.5));
            for (let u = 0; u < divisions; u++)
              for (let v = 0; v < divisions - u; v++) {
                const x = (u + 0.33) / divisions,
                  z = (v + 0.33) / divisions;
                yardCandidates.push(
                  a
                    .clone()
                    .multiplyScalar(1 - x - z)
                    .addScaledVector(b, x)
                    .addScaledVector(c, z),
                );
              }
          }
        }
      }
      if (shell && solidFaces) this.solids.push(new SolidInterior(shell, solidFaces));
    }
    const scored = yardCandidates
      .map((p) => {
        point.set(p.x, p.z);
        const distance = this.buildingBounds.length
          ? Math.min(...this.buildingBounds.map((box) => box.distanceToPoint(point)))
          : 3;
        return { p, distance };
      })
      .filter((item) => item.distance >= 1.35);
    scored.sort((a, b) => Math.abs(a.distance - 3) - Math.abs(b.distance - 3));
    for (const { p } of scored) {
      if (!this.safeYard(p, 1.75)) continue;
      this.yard = p.toArray();
      if (this.buildingBounds.length) {
        point.set(p.x, p.z);
        const nearest = this.buildingBounds.reduce((a, b) =>
          a.distanceToPoint(point) <= b.distanceToPoint(point) ? a : b,
        );
        const centre = nearest.getCenter(point);
        this.yardHeading = Math.atan2(p.x - centre.x, p.z - centre.y);
      }
      break;
    }
  }

  private safeYard(p: THREE.Vector3, height: number) {
    this.skyRay.origin.copy(p).y += 0.05;
    if (this.hit(this.skyRay, 25) || !this.canStand(p, height)) return false;
    // Reserve space to leave the destination in every direction, including on gently graded terrain.
    for (let i = 0; i < 8; i++) {
      const angle = (Math.PI * i) / 4;
      let foot = p;
      const dx = 0.22 * Math.sin(angle),
        dz = 0.22 * Math.cos(angle);
      for (let stride = 0; stride < 5; stride++) {
        const next = this.step(foot, dx, dz, height);
        if (!next || Math.abs(next.y - p.y) > 0.42) return false;
        foot = next;
      }
    }
    return true;
  }

  outdoorLandingAt(point: THREE.Vector3, height: number) {
    const inBuilding = this.buildingBounds.some(box => box.containsPoint(new THREE.Vector2(point.x, point.z)));
    if (inBuilding || !this.safeYard(point, height)) return null;
    return point.clone();
  }

  yardLanding(height: number) {
    if (!this.yard) return null;
    const point = new THREE.Vector3(...this.yard);
    return this.safeYard(point, height) ? point : null;
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
        if (t.visited === serial || (floorsOnly && !t.stand) || t.door?.open) continue;
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
      ? {
          point,
          walkable: standing,
          object: mesh,
          doorId: this.doors.get(mesh)?.id,
          placementId: (mesh as THREE.Mesh).userData.vhPlacementId,
        }
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
    const obstacle = (t: Triangle) => {
      if (t.door?.open || !b.intersectsTriangle(t.shape)) return false;
      // A continuous foundation may run below a modeled doorway. Give its actual sill priority
      // within one footstep of that threshold, without removing walls, frames or head clearance.
      if (t.foundation) {
        const top = Math.max(t.shape.a.y, t.shape.b.y, t.shape.c.y);
        for (const sill of this.thresholds) {
          const nearest = sill.closestPointToPoint(p, this.nearThreshold);
          if (
            top <= nearest.y + STEP + 0.01 &&
            Math.abs(p.y - nearest.y) <= STEP &&
            Math.hypot(p.x - nearest.x, p.z - nearest.z) < 0.45
          )
            return false;
        }
      }
      return true;
    };
    if (this.wide.some(obstacle)) return false;
    for (let x = Math.floor(b.min.x / CELL); x <= Math.floor(b.max.x / CELL); x++)
      for (let z = Math.floor(b.min.z / CELL); z <= Math.floor(b.max.z / CELL); z++)
        if (this.cells.get(x)?.get(z)?.some(obstacle)) return false;
    return !this.solids.some(solid => solid.containsBody(b));
  }
  step(from: THREE.Vector3, dx: number, dz: number, height: number) {
    const p = this.support(from.x + dx, from.z + dz, from.y);
    return p && this.canStand(p, height) ? p : null;
  }
  landingAt(x: number, z: number, floor: number, height: number, room?: Room) {
    const p = this.support(x, z, floor, 0.45, 0.65);
    return p && (!room || pointInFootprint(x, z, room.footprint)) && this.canStand(p, height) ? p : null;
  }
  landing(near: THREE.Vector3, height: number, room?: Room) {
    for (const radius of [0, 0.4, 0.8, 1.2]) {
      for (let i = 0; i < (radius === 0 ? 1 : 12); i++) {
        const angle = (i * Math.PI) / 6;
        const p = this.landingAt(
          near.x + radius * Math.cos(angle),
          near.z + radius * Math.sin(angle),
          near.y,
          height,
          room,
        );
        if (p) return p;
      }
    }
    return null;
  }
  openDoor(id: string) {
    this.openedDoors.add(id);
    for (const door of this.doors.values()) if (door.id === id) door.clear();
  }

  updateDoors(head: THREE.Vector3, dt: number) {
    for (const door of this.doors.values()) {
      if (!door.open && door.bounds.distanceToPoint(head) < 1.2) this.openDoor(door.id);
      door.tick(dt);
    }
  }

  dispose() {
    for (const door of this.doors.values()) door.dispose();
  }
}
