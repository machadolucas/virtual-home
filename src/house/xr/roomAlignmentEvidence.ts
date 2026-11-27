import { Box3, Matrix4, Plane, Ray, Vector3 } from "three";
import { pointInRing, ringSignedArea } from "@/house/model/geometry2d";
import { trackedFloorHeightAllowed, type AlignmentLandmark, type AlignmentWall, type RoomEvidence } from "./roomAlignment";
import type { AlignmentAttemptSnapshot } from "../alignmentAttemptTypes";
import { outlinesAgree } from "./roomOutline";

type Point = [number, number];
type StructuralKind = "wall" | "door" | "window";
type SurfaceRole = StructuralKind | "vertical" | "generic" | "floor" | "ceiling" | "object";
type Triangle = [Vector3, Vector3, Vector3] & { role?: SurfaceRole };

interface ScanPatch {
  role: SurfaceRole;
  boundary: Vector3[];
  plane: Plane;
  ring: Point[];
  project: (p: Vector3) => Point;
}
export interface AlignmentEvidence extends RoomEvidence {
  detections?: AlignmentAttemptSnapshot["detections"];
  patches: ScanPatch[];
  triangles: Triangle[];
  // A sampled furniture mesh can miss the exact triangle under the pointer.
  partialObjects: { box: Box3; toLocal: Matrix4; toWorld: Matrix4 }[];
  incompleteDepth: boolean;
}

function safe<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}
const planar = (v: Vector3): Point => [v.x, v.z];
const valid = (p: Vector3): boolean => [p.x, p.y, p.z].every(Number.isFinite);
const labelOf = (label: string | undefined) => (label ?? "").trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
const floorLabel = (label: string) => label === "floor" || label === "ground";
const wallLabel = (label: string) => label === "wall" || label === "wall-face" || label === "interior-wall" ||
  label === "inner-wall-face";
const partitionLabel = (label: string) => label === "invisible-wall" || label === "invisible-wall-face";
function openingLabel(label: string): AlignmentLandmark["kind"] | null {
  if (label === "door" || label === "door-frame" || label === "doorway") return "door";
  if (label === "window" || label === "window-frame") return "window";
  return null;
}
function surfaceRole(label: string, normalY: number): SurfaceRole {
  if (floorLabel(label)) return "floor";
  if (label === "ceiling") return "ceiling";
  const vertical = Math.abs(normalY) <= .10;
  if (wallLabel(label)) return vertical ? "wall" : "object";
  const opening = openingLabel(label);
  if (opening) return vertical ? opening : "object";
  if (label && label !== "global-mesh" && label !== "room" && label !== "room-mesh" && label !== "unknown") return "object";
  return vertical ? "vertical" : "generic";
}
function trackedTransform(frame: XRFrame, space: XRSpace, reference: XRReferenceSpace): Matrix4 | null {
  const pose = safe(() => frame.getPose(space, reference));
  return pose && !pose.emulatedPosition ? new Matrix4().fromArray(pose.transform.matrix) : null;
}

function hull(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (slice: Point[]) => {
    const result: Point[] = [];
    for (const p of slice) {
      while (result.length >= 2 && turn(result[result.length - 2]!, result[result.length - 1]!, p) <= 0) result.pop();
      result.push(p);
    }
    result.pop();
    return result;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

function patch(vertices: Vector3[], label: string): ScanPatch | null {
  if (vertices.length < 3) return null;
  const a = vertices[0]!, b = vertices.find((v) => v.distanceToSquared(a) > 0.000001);
  if (!b) return null;
  const direction = new Vector3().subVectors(b, a);
  const c = vertices.find((v) => new Vector3().subVectors(v, a).cross(direction).lengthSq() > 0.000001);
  if (!c) return null;
  const plane = new Plane().setFromCoplanarPoints(a, b, c);
  const [x, y, z] = plane.normal.toArray().map(Math.abs);
  const project = y! > x! && y! > z! ? planar : x! > z!
    ? (v: Vector3): Point => [v.y, v.z] : (v: Vector3): Point => [v.x, v.y];
  return { role: surfaceRole(label, plane.normal.y), plane, project, ring: vertices.map(project), boundary: vertices };
}

function wallFromPoints(vertices: Vector3[], minSpan = 0.28): AlignmentWall | null {
  if (vertices.length < 3) return null;
  const centre = new Vector3();
  let low = Infinity, high = -Infinity;
  for (const v of vertices) { centre.add(v); low = Math.min(low, v.y); high = Math.max(high, v.y); }
  centre.divideScalar(vertices.length);
  let xx = 0, zz = 0, xz = 0;
  for (const { x, z } of vertices) {
    const dx = x - centre.x, dz = z - centre.z;
    xx += dx * dx; zz += dz * dz; xz += dx * dz;
  }
  const theta = Math.atan2(2 * xz, xx - zz) / 2;
  const x = Math.cos(theta), z = Math.sin(theta);
  let start = Infinity, end = -Infinity;
  for (const v of vertices) {
    const dx = v.x - centre.x, dz = v.z - centre.z;
    if (Math.abs(x * dz - z * dx) > 0.065) return null;
    const station = dx * x + dz * z;
    start = Math.min(start, station);
    end = Math.max(end, station);
  }
  if (end - start < minSpan || high - low < 0.35) return null;
  return { a: [centre.x + x * start, centre.z + z * start], b: [centre.x + x * end, centre.z + z * end], low, high };
}

const wallLength = (wall: AlignmentWall) => Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);

function mergeWalls(first: AlignmentWall, second: AlignmentWall): AlignmentWall | null {
  const [a, b] = wallLength(first) >= wallLength(second) ? [first, second] : [second, first];
  const length = wallLength(a);
  const x = (a.b[0] - a.a[0]) / length, z = (a.b[1] - a.a[1]) / length;
  const bx = b.b[0] - b.a[0], bz = b.b[1] - b.a[1];
  if (Math.abs((x * bx + z * bz) / wallLength(b)) < 0.999 ||
    [b.a, b.b].some((p) => Math.abs((p[0] - a.a[0]) * z - (p[1] - a.a[1]) * x) > 0.024)) return null;
  const range = [b.a, b.b].map((p) => (p[0] - a.a[0]) * x + (p[1] - a.a[1]) * z);
  if (Math.max(...range) < -0.24 || Math.min(...range) > length + 0.24 ||
    Math.max(a.low, b.low) - Math.min(a.high, b.high) > 0.15) return null;
  const point = (along: number): Point => [a.a[0] + x * along, a.a[1] + z * along];
  return { a: point(Math.min(0, ...range)), b: point(Math.max(length, ...range)),
    low: Math.min(a.low, b.low), high: Math.max(a.high, b.high),
    semanticWall: !!(a.semanticWall && b.semanticWall) };
}

function addWall(walls: AlignmentWall[], candidate: AlignmentWall) {
  if (candidate.high - candidate.low < 0.43) return;
  for (let i = walls.length - 1; i >= 0; i--) {
    const merged = mergeWalls(walls[i]!, candidate);
    if (!merged) continue;
    candidate = merged;
    walls.splice(i, 1);
  }
  if (walls.length < 72) walls.push(candidate);
}

function addOpening(evidence: AlignmentEvidence, kind: AlignmentLandmark["kind"], wall: AlignmentWall) {
  const center: [number, number, number] = [(wall.a[0] + wall.b[0]) / 2, (wall.low + wall.high) / 2, (wall.a[1] + wall.b[1]) / 2];
  const width = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
  const height = wall.high - wall.low;
  if (width > 3 || height > 3) return;
  if (!evidence.landmarks.some((other) => other.kind === kind &&
    Math.hypot(other.center[0] - center[0], other.center[1] - center[1], other.center[2] - center[2]) < 0.06))
    evidence.landmarks.push({ kind, center, rawCenter: [...center], width, height,
      axis: [(wall.b[0] - wall.a[0]) / width, (wall.b[1] - wall.a[1]) / width] });
}

function floorFromPoints(evidence: AlignmentEvidence, vertices: Vector3[], viewer: Vector3, semanticFloor: boolean, polygon?: Point[]) {
  const height = vertices.reduce((sum, v) => sum + v.y, 0) / vertices.length;
  if (!trackedFloorHeightAllowed(height, semanticFloor) || vertices.some((v) => Math.abs(v.y - height) > 0.05)) return;
  const outline = polygon ?? hull(vertices.map(planar));
  if (outline.length < 3 || Math.abs(ringSignedArea(outline)) < 0.65 || !pointInRing(viewer.x, viewer.z, outline)) return;
  const previous = evidence.floor;
  const source = polygon ? "plane" : "mesh";
  if (previous?.semanticFloor && !semanticFloor) return;
  if (!previous || (semanticFloor && !previous.semanticFloor) || (previous.source !== "plane" && source === "plane") ||
    (previous.source === source && (Math.abs(height) + 0.025 < Math.abs(previous.y) ||
      (Math.abs(height - previous.y) < 0.025 && Math.abs(ringSignedArea(outline)) < Math.abs(ringSignedArea(previous.outline)))))) {
    evidence.floor = { y: height, outline, source, semanticFloor };
  }
}

function onWall(wall: AlignmentWall, x: number, z: number): boolean {
  const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1], length = Math.hypot(dx, dz);
  if (length < .001) return false;
  const station = ((x - wall.a[0]) * dx + (z - wall.a[1]) * dz) / length;
  return station >= -.025 && station <= length + .025 &&
    Math.abs((x - wall.a[0]) * dz - (z - wall.a[1]) * dx) <= .025 * length;
}

// Space Setup can derive floor AND ceiling boundaries from one room layout. Require
// directly measured adjoining wall ends as well, so clipping both to a rack is insufficient.
function corroborateGenericWalls(evidence: AlignmentEvidence, generic: AlignmentWall[], partitions: AlignmentWall[]) {
  const floor = evidence.floor;
  if (!generic.length || !floor?.semanticFloor || floor.source !== "plane") return;
  const ceiling = evidence.patches.find(({ role, plane, boundary }) => role === "ceiling" &&
    Math.abs(plane.normal.y) >= .98 && boundary[0]!.y - floor.y > 1.6 &&
    outlinesAgree(floor.outline, boundary.map(planar), .04));
  if (!ceiling) return;
  const top = ceiling.boundary[0]!.y;
  const measuredEnd = (edge: AlignmentWall, [x, z]: Point) => evidence.walls.some(seen => {
    if (!seen.semanticWall) return false;
    const cross = (edge.b[0] - edge.a[0]) * (seen.b[1] - seen.a[1]) -
      (edge.b[1] - edge.a[1]) * (seen.b[0] - seen.a[0]);
    return Math.abs(cross) > .4 * wallLength(edge) * wallLength(seen) &&
      [seen.a, seen.b].some(([sx, sz]) => Math.hypot(sx - x, sz - z) <= .035);
  });
  const edges = floor.outline.map((a, i) => ({ a, b: floor.outline[(i + 1) % floor.outline.length]!, low: floor.y, high: top }))
    .filter(edge => measuredEnd(edge, edge.a) && measuredEnd(edge, edge.b));
  for (const wall of generic) {
    if (Math.abs(wall.low - floor.y) > .15 || Math.abs(wall.high - top) > .15 ||
      !edges.some(edge => onWall(edge, ...wall.a) && onWall(edge, ...wall.b)) ||
      partitions.some(partition => mergeWalls(partition, wall))) continue;
    // Keep directly observed semantic patches and their measured vertical extents intact.
    if (!evidence.walls.some(other => other.semanticWall && mergeWalls(other, wall))) addWall(evidence.walls, wall);
  }
}

/** Reads optional native features in local-floor metres. Meshes and occlusion data are transient. */
export function readAlignmentEvidence(frame: XRFrame, reference: XRReferenceSpace, viewer: Vector3): AlignmentEvidence {
  const evidence: AlignmentEvidence = { walls: [], floor: null, landmarks: [], patches: [], triangles: [],
    partialObjects: [], incompleteDepth: false };
  const genericWalls: AlignmentWall[] = [];
  const partitions: AlignmentWall[] = [];
  const inRange = ({ x, z }: Vector3) => (x - viewer.x) ** 2 + (z - viewer.z) ** 2 < 9 ** 2;
  const planes = safe(() => frame.detectedPlanes), meshes = safe(() => frame.detectedMeshes);
  const labels = {wall:0, door:0, window:0, floor:0, object:0, other:0};
  evidence.detections = {planes:planes?.size ?? null, meshes:meshes?.size ?? null, labels};
  const countLabel = (label: string) => {
    const kind = openingLabel(label) ?? (wallLabel(label) ? "wall" : floorLabel(label) ? "floor" :
      !partitionLabel(label) && surfaceRole(label,0) === "object" ? "object" : "other");
    labels[kind]++;
  };
  let examinedPlanes = 0;
  for (const native of planes ?? []) {
    if (examinedPlanes++ >= 160) { evidence.incompleteDepth = true; break; }
    const label = labelOf(native.semanticLabel);
    countLabel(label);
    const transform = trackedTransform(frame, native.planeSpace, reference);
    if (!transform) continue;
    if (native.polygon.length > 128) { evidence.incompleteDepth = true; continue; }
    const points = native.polygon.map((p) => new Vector3(p.x, p.y, p.z).applyMatrix4(transform));
    if (points.length < 3 || !points.every(valid)) continue;
    if (partitionLabel(label)) {
      const partition = wallFromPoints(points);
      if (partition) partitions.push(partition);
      continue;
    }
    const feature = patch(points, label);
    if (!feature) continue;
    if (points.some(inRange)) {
      evidence.patches.push(feature);
    }
    const opening = openingLabel(label);
    if (Math.abs(feature.plane.normal.y) >= 0.98 && (!label || floorLabel(label)))
      floorFromPoints(evidence, points, viewer, floorLabel(label), points.map(planar));
    if (feature.role !== "vertical" && feature.role !== "wall" && !opening) continue;
    if (Math.abs(feature.plane.normal.y) > .10) continue;
    const wall = wallFromPoints(points, opening ? 0.3 : undefined);
    if (!wall) continue;
    if (opening) addOpening(evidence, opening, wall);
    else if (feature.role === "wall") addWall(evidence.walls, { ...wall, semanticWall: true });
    else addWall(genericWalls, wall);
  }

  const meshWalls: Array<{ x: number; z: number; offset: number; points: Vector3[]; semantic: boolean }> = [];
  const meshFloors: Array<{ y: number; points: Vector3[] }> = [];
  const nativePerimeter = evidence.floor?.source === "plane" && evidence.floor.outline.every((a, i, ring) => {
    const b = ring[(i + 1) % ring.length]!, edge = { a, b, low: 0, high: 1.7 };
    const length = wallLength(edge);
    if (length < 0.42) return true;
    return evidence.walls.some((wall) => {
      if (!mergeWalls(wall, edge)) return false;
      const along = ([x, z]: Point) => ((x - a[0]) * (b[0] - a[0]) + (z - a[1]) * (b[1] - a[1])) / length;
      const [start, end] = [along(wall.a), along(wall.b)].sort((x, y) => x - y);
      return Math.min(length, end!) - Math.max(0, start!) >= Math.min(0.65 * length, 1.4);
    });
  });
  const meshBudget = nativePerimeter ? 1_200 : 5_500;
  let examined = 0;
  let examinedMeshes = 0;
  let objectVertexBudget = 24_000;
  const normal = new Vector3(), vertical = new Vector3();
  for (const mesh of meshes ?? []) {
    if (examinedMeshes++ >= 40) { evidence.incompleteDepth = true; break; }
    const label = labelOf(mesh.semanticLabel), opening = openingLabel(label);
    countLabel(label);
    const transform = trackedTransform(frame, mesh.meshSpace, reference);
    if (!transform) continue;
    const { vertices, indices } = mesh;
    if (opening || wallLabel(label) || floorLabel(label) || partitionLabel(label)) {
      const points: Vector3[] = [];
      const stride = 3 * Math.max(1, Math.ceil(vertices.length / 3 / 500));
      for (let i = 0; i + 2 < vertices.length; i += stride) {
        const p = new Vector3().fromArray(vertices, i).applyMatrix4(transform);
        if (valid(p)) points.push(p);
      }
      if (partitionLabel(label)) {
        const partition = wallFromPoints(points);
        if (partition) partitions.push(partition);
        continue;
      }
      if (floorLabel(label)) floorFromPoints(evidence, points, viewer, true);
      else {
        const wall = wallFromPoints(points, opening ? 0.3 : undefined);
        if (wall) { if (opening) addOpening(evidence, opening, wall); else addWall(evidence.walls, { ...wall, semanticWall: true }); }
      }
    }
    const stride = 3 * Math.max(1, Math.ceil(indices.length / 3 / Math.min(3_000, meshBudget)));
    const meshRole = surfaceRole(label, 0);
    if (meshRole === "object" && (stride > 3 || indices.length / 3 > Math.min(meshBudget - examined, 1_100 - evidence.triangles.length))) {
      // Don't let an omitted furniture triangle expose a labelled wall behind it.
      // Use the complete local bounds only for conservative occlusion, never for measurements.
      if (vertices.length / 3 > objectVertexBudget) evidence.incompleteDepth = true;
      else {
        objectVertexBudget -= vertices.length / 3;
        const box = new Box3().makeEmpty();
        for (let i = 0; i + 2 < vertices.length; i += 3) {
          vertical.fromArray(vertices, i);
          if (valid(vertical)) box.expandByPoint(vertical);
        }
        if (!box.isEmpty()) evidence.partialObjects.push({ box, toLocal: transform.clone().invert(), toWorld: transform });
      }
    }
    if (examined >= meshBudget) continue;
    for (let i = 0; i + 2 < indices.length && examined < meshBudget; i += stride) {
      examined++;
      const tri: Triangle = [
        new Vector3().fromArray(vertices, indices[i]! * 3).applyMatrix4(transform),
        new Vector3().fromArray(vertices, indices[i + 1]! * 3).applyMatrix4(transform),
        new Vector3().fromArray(vertices, indices[i + 2]! * 3).applyMatrix4(transform),
      ];
      if (!tri.every(valid) || !tri.some(inRange)) continue;
      const [a, b, c] = tri;
      normal.subVectors(b, a).cross(vertical.subVectors(c, a));
      if (normal.lengthSq() < 1e-8) continue;
      normal.normalize();
      tri.role = surfaceRole(label, normal.y);
      // The occlusion/hit sample is bounded independently of the survey snapshot.
      if (evidence.triangles.length < 1_100) evidence.triangles.push(tri);
      if (nativePerimeter) continue;
      if ((tri.role === "generic" || tri.role === "floor") && Math.abs(normal.y) > 0.985 && Math.abs(a.y) < 0.21) {
        const group = meshFloors.find((floor) => Math.abs(floor.y - a.y) < 0.035);
        if (group && group.points.length < 750) group.points.push(...tri);
        else if (!group && meshFloors.length < 12) meshFloors.push({ y: a.y, points: [...tri] });
      } else if ((tri.role === "vertical" || tri.role === "wall") && Math.abs(normal.y) < 0.07) {
        if (normal.x < -1e-8 || (Math.abs(normal.x) <= 1e-8 && normal.z < 0)) normal.negate();
        const offset = normal.x * a.x + normal.z * a.z;
        const semantic = tri.role === "wall";
        const group = meshWalls.find((wall) => wall.semantic === semantic && wall.x * normal.x + wall.z * normal.z > 0.9975 &&
          Math.abs(wall.offset - offset) < 0.032);
        if (group && group.points.length < 650) group.points.push(...tri);
        else if (!group && meshWalls.length < 40) meshWalls.push({ x: normal.x, z: normal.z, offset, points: [...tri], semantic });
      }
    }
  }
  if (!evidence.floor) for (const group of meshFloors) floorFromPoints(evidence, group.points, viewer, false);
  if (!nativePerimeter) for (const { points, semantic } of meshWalls) {
    const wall = wallFromPoints(points);
    if (wall) addWall(semantic ? evidence.walls : genericWalls, { ...wall, semanticWall: semantic });
  }
  corroborateGenericWalls(evidence, genericWalls, partitions);
  // Door/window depth varies with the room scanner. Normalize onto the measured supporting wall.
  for (const mark of evidence.landmarks) {
    const [x, , z] = mark.center;
    const wall = evidence.walls.find(({ a, b }) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], n = Math.hypot(dx, dz);
      const along = ((x - a[0]) * dx + (z - a[1]) * dz) / n;
      return along >= 0 && along <= n && Math.abs((x - a[0]) * dz - (z - a[1]) * dx) / n < 0.2;
    });
    if (!wall) continue;
    const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1];
    const t = ((x - wall.a[0]) * dx + (z - wall.a[1]) * dz) / (dx * dx + dz * dz);
    mark.center[0] = wall.a[0] + t * dx;
    mark.center[2] = wall.a[1] + t * dz;
  }
  return evidence;
}

function visitHits(evidence: AlignmentEvidence, ray: Ray, hit: (point: Vector3, role: SurfaceRole) => void, objectsOnly = false) {
  const scratch = new Vector3();
  for (const { plane, ring, project, role } of evidence.patches) {
    if (objectsOnly && role !== "object") continue;
    if (ray.intersectPlane(plane, scratch) && pointInRing(...project(scratch), ring)) hit(scratch, role);
  }
  for (const tri of evidence.triangles) {
    if (objectsOnly && tri.role !== "object") continue;
    if (ray.intersectTriangle(tri[0], tri[1], tri[2], false, scratch)) hit(scratch, tri.role ?? "generic");
  }
}

function partialObjectDepth(evidence: AlignmentEvidence, ray: Ray) {
  let depth = Infinity;
  if (!evidence.partialObjects.length) return depth;
  const local = new Ray(), point = new Vector3();
  for (const { box, toLocal, toWorld } of evidence.partialObjects) {
    local.copy(ray).applyMatrix4(toLocal);
    if (box.containsPoint(local.origin)) return 0;
    if (local.intersectBox(box, point)) depth = Math.min(depth, ray.origin.distanceTo(point.applyMatrix4(toWorld)));
  }
  return depth;
}

/** A projected floor point or a manual two-ray fallback must not pass through known furniture. */
export function furnitureBeforePoint(evidence: AlignmentEvidence, ray: Ray, point: Vector3): boolean {
  const end = ray.origin.distanceTo(point) + .015;
  if (partialObjectDepth(evidence, ray) <= end) return true;
  let blocked = false;
  visitHits(evidence, ray, hit => { if (ray.origin.distanceTo(hit) <= end) blocked = true; }, true);
  return blocked;
}

export function intersectAlignmentEvidence(evidence: AlignmentEvidence, ray: Ray, target: Vector3): Vector3 | null {
  let best = 9 ** 2;
  visitHits(evidence, ray, point => {
    const distance = ray.origin.distanceToSquared(point);
    if (distance > 0.025 ** 2 && distance < best) { best = distance; target.copy(point); }
  });
  return best < 9 ** 2 ? target : null;
}

/** Depth for a deliberate structural measurement. An ordinary hit test has no semantic label. */
export function classifyStructuralHit(
  evidence: AlignmentEvidence, ray: Ray, target: Vector3, nativeHit?: Vector3 | null, kind: StructuralKind = "wall",
): "matched" | "blocked" | "unverified" {
  // Capture first because callers may reuse target for the native hit.
  const nativeDistance = nativeHit && valid(nativeHit) ? ray.origin.distanceTo(nativeHit) : Infinity;
  let matched = Infinity, object = Infinity, wrongKind = Infinity, generic = Infinity;
  visitHits(evidence, ray, (point, role) => {
    const distance = point.distanceTo(ray.origin);
    if (distance < .025 || distance >= 9) return;
    const backedWall = role === "vertical" && kind === "wall" && evidence.walls.some(wall =>
      point.y >= wall.low - .025 && point.y <= wall.high + .025 && onWall(wall, point.x, point.z));
    if (role === kind || backedWall) {
      if (distance < matched) { matched = distance; target.copy(point); }
    } else if (role === "object" || (kind === "wall" && (role === "door" || role === "window"))) {
      object = Math.min(object, distance);
    } else if (role === "generic" || role === "vertical") generic = Math.min(generic, distance);
    else wrongKind = Math.min(wrongKind, distance);
  });
  object = Math.min(object, partialObjectDepth(evidence, ray));
  if (matched < Infinity) {
    if (object <= matched + .015 || Math.min(wrongKind, generic, nativeDistance) < matched - .025) return "blocked";
    if (Number.isFinite(nativeDistance) && nativeDistance > matched + .05) return "unverified";
    return evidence.incompleteDepth ? "unverified" : "matched";
  }
  const known = Math.min(object, wrongKind);
  return known < 9 && known <= Math.min(generic, nativeDistance) + .025 ? "blocked" : "unverified";
}

/** Snap a remote measurement only to a measured floor/wall intersection near the physical hit. */
export function snapScannedCorner(evidence: RoomEvidence, hit: Vector3): void {
  if (!evidence.floor || Math.abs(hit.y - evidence.floor.y) > 0.11) return;
  let best = 0.11 ** 2;
  let x = hit.x, z = hit.z;
  for (const [i, a] of evidence.walls.entries()) for (const b of evidence.walls.slice(i + 1)) {
    const da = [a.b[0] - a.a[0], a.b[1] - a.a[1]] as const;
    const db = [b.b[0] - b.a[0], b.b[1] - b.a[1]] as const;
    const det = da[0] * db[1] - da[1] * db[0];
    if (Math.abs(det) < 0.3 * Math.hypot(...da) * Math.hypot(...db)) continue;
    const dx = b.a[0] - a.a[0], dz = b.a[1] - a.a[1];
    const t = (dx * db[1] - dz * db[0]) / det, u = (dx * da[1] - dz * da[0]) / det;
    if (t < -0.12 || t > 1.12 || u < -0.12 || u > 1.12) continue;
    const sx = a.a[0] + t * da[0], sz = a.a[1] + t * da[1];
    const gap = (hit.x - sx) ** 2 + (hit.z - sz) ** 2 + (hit.y - evidence.floor.y) ** 2;
    if (gap < best) { best = gap; x = sx; z = sz; }
  }
  if (best < 0.11 ** 2) hit.set(x, evidence.floor.y, z);
}
