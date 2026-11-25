import * as THREE from "three";
import { openingWallId } from "@/house/model/focusContext";
import type { ClipGroups } from "./clipGroups";
import { isVisibleUp, rebuildPickables } from "./applyVisibility";
import type { AssetEntry, SceneIndex } from "./SceneIndex";

type PlanPoint = [number, number];
type Triangle = [THREE.Vector3, THREE.Vector3, THREE.Vector3];
type Face = { mesh: THREE.Mesh; floorId: string };
type Section = { mesh: THREE.Mesh; entry: AssetEntry; height: number; surfaceId: string };

const EPS = 1e-7;

function cross(a: PlanPoint, b: PlanPoint, p: PlanPoint): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function convexHull(input: PlanPoint[]): PlanPoint[] {
  const sorted = input.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function half(points: PlanPoint[]) {
    const result: PlanPoint[] = [];
    for (const p of points) {
      while (result.length >= 2 && cross(result.at(-2)!, result.at(-1)!, p) <= EPS)
        result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  }
  return [...half(sorted), ...half(sorted.reverse())];
}

function clipPolygon<P>(vertices: P[], distance: (p: P) => number, mix: (a: P, b: P, t: number) => P): P[] {
  const result: P[] = [];
  if (!vertices.length) return result;
  let prev: P = vertices.at(-1)!;
  let prevD = distance(prev);
  for (const next of vertices) {
    const nextD = distance(next);
    if ((prevD >= 0) !== (nextD >= 0)) result.push(mix(prev, next, prevD / (prevD - nextD)));
    if (nextD >= 0) result.push(next);
    prev = next;
    prevD = nextD;
  }
  return result;
}

function subtractOpening(poly: PlanPoint[], hole: PlanPoint[]): PlanPoint[][] {
  const result: PlanPoint[][] = [];
  let remaining = poly;
  const mix = (a: PlanPoint, b: PlanPoint, t: number): PlanPoint =>
    [THREE.MathUtils.lerp(a[0], b[0], t), THREE.MathUtils.lerp(a[1], b[1], t)];
  for (let i = 0; i < hole.length && remaining.length >= 3; i++) {
    const a = hole[i]!, b = hole[(i + 1) % hole.length]!;
    const distance = (p: PlanPoint) => cross(a, b, p);
    const outside = clipPolygon(remaining, (p) => -distance(p), mix);
    if (outside.length >= 3) result.push(outside);
    remaining = clipPolygon(remaining, distance, mix);
  }
  return result;
}

function triangles(mesh: THREE.Mesh): Triangle[] {
  mesh.updateWorldMatrix(true, false);
  const xyz = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.getIndex();
  const get = (i: number) => new THREE.Vector3().fromBufferAttribute(xyz, index ? index.getX(i) : i)
    .applyMatrix4(mesh.matrixWorld);
  const result: Triangle[] = [];
  for (let i = 0; i + 2 < (index?.count ?? xyz.count); i += 3) result.push([get(i), get(i + 1), get(i + 2)]);
  return result;
}

type SliceSegment = [PlanPoint, PlanPoint];

function sliceSegments(mesh: THREE.Mesh, y: number): SliceSegment[] {
  const segments: SliceSegment[] = [];
  for (const triangle of triangles(mesh)) {
    const points: PlanPoint[] = [];
    for (let i = 0; i < 3; i++) {
      const a = triangle[i]!, b = triangle[(i + 1) % 3]!;
      if ((a.y < y) === (b.y < y)) continue;
      const t = (y - a.y) / (b.y - a.y);
      points.push([THREE.MathUtils.lerp(a.x, b.x, t), THREE.MathUtils.lerp(a.z, b.z, t)]);
    }
    if (points.length === 2) {
      const [a, b] = points as SliceSegment;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > EPS) segments.push([a,b]);
    }
  }
  return segments;
}

/** The vertical jambs define the aperture at the cut, even if its head slopes. */
function openingShape(reveal: THREE.Mesh, y: number): PlanPoint[] {
  return convexHull(sliceSegments(reveal, y).flat());
}

function dot(a: PlanPoint,b: PlanPoint): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** Reconstruct only the thickness supported by opposite wall faces when the top mesh is invalid. */
export function supportedWallSections(faces: readonly THREE.Mesh[], y: number): PlanPoint[][] {
  const segments = faces.flatMap((face) => sliceSegments(face, y));
  const lengths = segments.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const longest = Math.max(...lengths);
  if (!(longest > EPS)) return [];
  const [first, last] = segments[lengths.indexOf(longest)]!;
  const axis: PlanPoint = [(last[0] - first[0]) / longest, (last[1] - first[1]) / longest];
  const normal: PlanPoint = [-axis[1], axis[0]];
  const planes: Array<{ side: number; ranges: Array<[number, number]>; length: number }> = [];
  for (const [a,b] of segments) {
    const side = dot(a, normal);
    if (Math.abs(dot(b, normal) - side) > .0001) continue;
    let plane = planes.find((p) => Math.abs(side - p.side) < .0001);
    if (!plane) { plane = { side, ranges: [], length: 0 }; planes.push(plane); }
    const u = dot(a, axis), v = dot(b, axis);
    plane.ranges.push([Math.min(u, v), Math.max(u, v)]);
    plane.length += Math.abs(v - u);
  }
  planes.sort((a,b) => b.length - a.length);
  const [a,b] = planes;
  if (!a || !b || Math.abs(a.side - b.side) > 1) return [];
  const point = (u: number, side: number): PlanPoint =>
    [axis[0] * u + normal[0] * side, axis[1] * u + normal[1] * side];
  const polygons: PlanPoint[][] = [];
  for (const [loA,hiA] of a.ranges) {
    for (const [loB,hiB] of b.ranges) {
      const lo = Math.max(loA,loB), hi = Math.min(hiA,hiB);
      if (hi - lo > EPS)
        polygons.push([point(lo,a.side),point(hi,a.side),point(hi,b.side),point(lo,b.side)]);
    }
  }
  return polygons;
}

/** Project the source wall cap footprint to the section plane and subtract aperture sections. */
export function wallSectionGeometry(source: THREE.Mesh, reveals: readonly THREE.Mesh[], height: number,
  sides: readonly THREE.Mesh[] = []): THREE.BufferGeometry {
  const holes = reveals.map((reveal) => openingShape(reveal, height)).filter((h) => h.length >= 3);
  source.parent?.updateWorldMatrix(true, false);
  const inverseParent = source.parent?.matrixWorld.clone().invert() ?? new THREE.Matrix4();
  const positions: number[] = [];
  const point = new THREE.Vector3();
  const polygons = source.userData.vhInvalidWallCap ? supportedWallSections(sides, height) :
    triangles(source).map((triangle) =>
      clipPolygon(triangle, (p) => p.y - height, (a, b, t) => a.clone().lerp(b, t))
        .map(({ x, z }): PlanPoint => [x,z]),
    ).filter((poly) => poly.length >= 3);
  for (const polygon of polygons) {
    let shape = [polygon];
    for (const hole of holes) shape = shape.flatMap((poly) => subtractOpening(poly, hole));
    for (const poly of shape) {
      for (let j = 1; j + 1 < poly.length; j++) {
        const a = poly[0]!, b = poly[j]!, c = poly[j + 1]!;
        const area = cross(a, b, c);
        if (Math.abs(area) <= EPS) continue;
        for (const [x, z] of area < 0 ? [a, b, c] : [a, c, b]) {
          point.set(x, height - .0005, z).applyMatrix4(inverseParent);
          positions.push(point.x, point.y, point.z);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Preserve the GLB's wall ownership for selection, while the section cap follows its wall's floor. */
export class WallSectionCaps {
  private readonly sections = new Map<string, Section>();
  private readonly wallFaces = new Map<string, Face>();
  private readonly reveals = new Map<string, THREE.Mesh[]>();
  private readonly sideFaces = new Map<string, THREE.Mesh[]>();
  private readonly worldBounds = new THREE.Box3();
  private loadedAssets = -1;

  constructor(private readonly index: SceneIndex, private readonly clip: ClipGroups) {}

  private updateSources() {
    if (this.index.assets.size === this.loadedAssets) return;
    this.loadedAssets = this.index.assets.size;
    this.wallFaces.clear();
    this.reveals.clear();
    this.sideFaces.clear();
    for (const surface of this.index.manifest.surfaces.values()) {
      const element = surface.elementId && this.index.manifest.elements.get(surface.elementId);
      const mesh = this.index.surfaceMesh.get(surface.id);
      if (!element || !mesh) continue;
      if (surface.role === "wall-top" && element.kind === "wall" && element.floorId) {
        this.wallFaces.set(element.id, { mesh, floorId: element.floorId });
      } else if (surface.kind === "wall" && element.kind === "wall") {
        const existing = this.sideFaces.get(element.id);
        if (existing) existing.push(mesh);
        else this.sideFaces.set(element.id, [mesh]);
      } else if (surface.role === "reveal") {
        const wall = openingWallId(element);
        if (!wall) continue;
        const existing = this.reveals.get(wall);
        if (existing) existing.push(mesh);
        else this.reveals.set(wall, [mesh]);
      }
    }
  }

  update(cuts: ReadonlyMap<string, number>): boolean {
    this.updateSources();
    let changed = false;
    const cutting = new Map<string, { height: number; surfaceId: string }>();
    for (const [sid, height] of cuts) {
      const surface = this.index.manifest.surfaces.get(sid);
      const wall = surface?.elementId;
      const side = this.index.surfaceMesh.get(sid);
      if (surface?.kind !== "wall" || !wall || !this.wallFaces.has(wall) || !side || !isVisibleUp(side)) continue;
      const found = cutting.get(wall);
      if (!found || height < found.height) cutting.set(wall, { height, surfaceId: sid });
    }
    for (const [wall, section] of this.sections) {
      if (!cutting.has(wall) && section.mesh.visible) {
        section.mesh.visible = false;
        changed = true;
      }
    }
    for (const [wall, cut] of cutting) {
      const source = this.wallFaces.get(wall)!;
      const openingReveals = this.reveals.get(wall) ?? [];
      // A wall starts at the occupied floor. Ignore section planes below its base.
      const side = this.index.surfaceMesh.get(cut.surfaceId)!;
      if (!side.geometry.boundingBox) side.geometry.computeBoundingBox();
      side.updateWorldMatrix(true, false);
      const sideBase = this.worldBounds.copy(side.geometry.boundingBox!).applyMatrix4(side.matrixWorld).min.y;
      const existing = this.sections.get(wall);
      if (cut.height <= sideBase + EPS || !source.mesh.parent) {
        if (existing?.mesh.visible) { existing.mesh.visible = false; changed = true; }
        continue;
      }
      source.mesh.parent.updateWorldMatrix(true, false);
      const localHeight = cut.height - source.mesh.parent.matrixWorld.elements[13]!;
      if (existing && existing.surfaceId === cut.surfaceId && Math.abs(existing.height - localHeight) < EPS) {
        if (!existing.mesh.visible) { existing.mesh.visible = true; changed = true; }
        continue;
      }
      const geometry = wallSectionGeometry(source.mesh, openingReveals, cut.height, this.sideFaces.get(wall));
      if (existing) {
        existing.entry.disposables.geometries.delete(existing.mesh.geometry);
        existing.mesh.geometry.dispose();
        existing.mesh.geometry = geometry;
        existing.mesh.visible = true;
        existing.entry.disposables.geometries.add(geometry);
        existing.surfaceId = cut.surfaceId;
        existing.height = localHeight;
        this.index.meshSurfaceId.set(existing.mesh, existing.surfaceId);
      } else {
        const sourceMaterial = source.mesh.material;
        if (Array.isArray(sourceMaterial)) { geometry.dispose(); continue; }
        const entry = this.index.assets.get(this.index.manifest.surfaces.get(cut.surfaceId)!.nodeRefs[0]!.assetId);
        if (!entry) { geometry.dispose(); continue; }
        const material = sourceMaterial.clone();
        material.side = THREE.DoubleSide;
        const cap = new THREE.Mesh(geometry, material);
        cap.name = `vh-wall-section-${wall}`;
        this.clip.attach(cap, source.floorId);
        source.mesh.parent.add(cap);
        entry.meshes.push(cap);
        entry.disposables.geometries.add(geometry);
        entry.disposables.materials.add(material);
        this.index.meshSurfaceId.set(cap, cut.surfaceId);
        this.sections.set(wall, { mesh: cap, entry, height: localHeight, surfaceId: cut.surfaceId });
      }
      changed = true;
    }
    if (changed) rebuildPickables(this.index);
    return changed;
  }

  dispose(): void {
    for (const { mesh, entry } of this.sections.values()) {
      mesh.removeFromParent();
      const i = entry.meshes.indexOf(mesh);
      if (i >= 0) entry.meshes.splice(i, 1);
      entry.disposables.geometries.delete(mesh.geometry);
      const material = mesh.material as THREE.Material;
      entry.disposables.materials.delete(material);
      mesh.geometry.dispose();
      material.dispose();
    }
    this.sections.clear();
    rebuildPickables(this.index);
  }
}
