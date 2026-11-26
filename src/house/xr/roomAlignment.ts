import { Box3, Matrix4, Scene, Vector3, type Object3D } from "three";
import { pointInFootprint } from "@/house/model/geometry2d";
import type { Room, Vec3 } from "@/house/model/types";
import type { SceneIndex } from "@/house/scene/SceneIndex";
import { explodeTargets, offsetsFor, type ExplodeState } from "@/house/scene/explode";
import { MAX_CALIBRATION_ERROR_M, type CalibrationFeature, type CalibrationFit } from "./mixedCalibration";

type Point = [number, number];
export interface AlignmentWall {
  a: Point;
  b: Point;
  low: number;
  high: number;
}
export interface AlignmentLandmark {
  kind: "door" | "window";
  center: Vec3;
  width: number;
  height: number;
}
export interface AlignmentModel {
  room: Room;
  walls: AlignmentWall[];
  corners: CalibrationFeature[];
  landmarks: AlignmentLandmark[];
}
export interface RoomEvidence {
  walls: AlignmentWall[];
  floor: { y: number; outline: Point[] } | null;
  landmarks: AlignmentLandmark[];
}
export interface AlignmentCandidate {
  fit: CalibrationFit;
  check: CalibrationFeature;
  errorM: number;
  landmarkCount: number;
  landmarkConflict: boolean;
}
export type AlignmentHint = { kind: "wall"; index: number } | { kind: "landmark"; index: number };
const LIMIT = MAX_CALIBRATION_ERROR_M + 1e-8;
const FLOOR_TOLERANCE_M = 0.2;
const MIN_WALL_M = 0.65;
const METRE_DEDUP = 0.045;
const ANGLE_DEDUP = Math.PI / 180;
const PARALLEL = Math.cos(2.5 * Math.PI / 180);

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Point, b: Point) => a[0] * b[1] - a[1] * b[0];
const length = (a: Point) => Math.hypot(...a);
const rotate = (p: Point, yaw: number): Point => [
  Math.cos(yaw) * p[0] + Math.sin(yaw) * p[1],
  -Math.sin(yaw) * p[0] + Math.cos(yaw) * p[1],
];
const normalize = (a: Point): Point => { const n = length(a); return [a[0] / n, a[1] / n]; };
const wallAxis = ({ a, b }: AlignmentWall): Point => normalize(sub(b, a));
const wallNormal = (wall: AlignmentWall): Point => { const [x, z] = wallAxis(wall); return [-z, x]; };
const planar = (p: Vec3): Point => [p[0], p[2]];
const projection = (p: Point, wall: AlignmentWall): number => dot(sub(p, wall.a), wallAxis(wall));
const lineError = (p: Point, wall: AlignmentWall): number => Math.abs(dot(sub(p, wall.a), wallNormal(wall)));
const finite = (point: Vector3) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);

function pointOnWall(p: Point, wall: AlignmentWall, tolerance: number): boolean {
  const position = projection(p, wall);
  return position >= -tolerance && position <= length(sub(wall.b, wall.a)) + tolerance && lineError(p, wall) <= tolerance;
}

export function buildAlignmentModel(
  room: Room, corners: CalibrationFeature[], index?: SceneIndex | null, explode?: ExplodeState,
): AlignmentModel {
  const floor = room.floorElevation, high = floor + (room.ceilingHeight ?? 2.6);
  const walls = corners.flatMap(({ point }, i) => {
    const a = planar(point), b = planar(corners[(i + 1) % corners.length]!.point);
    return length(sub(a, b)) >= MIN_WALL_M ? [{ a, b, low: floor, high }] : [];
  });
  const landmarks: AlignmentLandmark[] = [];
  if (!index) return { room, walls, corners, landmarks };
  const roots = new Set<Object3D>([...index.assets.values()].map(({ root }) => root));
  const presentation = new Map<Object3D, number>();
  if (explode?.enabled) {
    const offsets = offsetsFor(index, explode);
    for (const [group, nodes] of explodeTargets(index))
      for (const node of nodes) presentation.set(node, offsets.get(group) ?? 0);
  }
  const pose = new Matrix4(), step = new Matrix4(), vertex = new Vector3();
  for (const element of index.manifest.elements.values()) {
    if (element.kind !== "door" && element.kind !== "window") continue;
    if (element.floorId && element.floorId !== room.floorId) continue;
    const ids = index.manifest.surfacesByElement.get(element.id) ?? [];
    // A nearby opening can belong to a room on the other side of a partition.
    if (!element.roomIds?.includes(room.id) && !ids.some((id) => index.manifest.surfaces.get(id)?.roomId === room.id)) continue;
    const bounds = new Vector3();
    // A reveal is part of the opening. A door leaf may be depicted open.
    const meshes = ids.filter((id) => index.manifest.surfaces.get(id)?.role === "reveal").map((id) => index.surfaceMesh.get(id));
    const box = new Box3();
    const points: Vector3[] = [];
    for (const mesh of meshes) if (mesh) {
      pose.identity();
      for (let node: Object3D | null = mesh; node && !(node instanceof Scene); node = node.parent) {
        if (node.matrixAutoUpdate) node.updateMatrix();
        step.copy(node.matrix);
        step.elements[13]! -= presentation.get(node) ?? 0;
        pose.premultiply(step);
        if (roots.has(node)) break;
      }
      const positions = mesh.geometry.getAttribute("position");
      if (!positions) continue;
      for (let i = 0; i < positions.count; i++) {
        const point = vertex.fromBufferAttribute(positions, i).applyMatrix4(pose);
        if (finite(point)) { box.expandByPoint(point); points.push(point.clone()); }
      }
    }
    if (box.isEmpty()) continue;
    box.getCenter(bounds);
    if (bounds.y < floor || bounds.y > high) continue;
    const point: Point = [bounds.x, bounds.z];
    const wall = walls.find((w) => pointOnWall(point, w, 0.32));
    if (!wall) continue;
    let lo = Infinity, hi = -Infinity;
    for (const point of points) {
      const station = projection([point.x, point.z], wall);
      lo = Math.min(lo, station);
      hi = Math.max(hi, station);
    }
    const along = (lo + hi) / 2;
    const width = hi - lo, height = box.max.y - box.min.y, [x, z] = wallAxis(wall);
    if (width < 0.3 || height < 0.3) continue;
    landmarks.push({ kind: element.kind, center: [wall.a[0] + x * along, bounds.y, wall.a[1] + z * along], width, height });
  }
  return { room, walls, corners, landmarks };
}

function transformed(wall: AlignmentWall, yaw: number, translation: Point): AlignmentWall {
  const apply = (p: Point): Point => {
    const q = rotate(p, yaw);
    return [q[0] + translation[0], q[1] + translation[1]];
  };
  return { ...wall, a: apply(wall.a), b: apply(wall.b) };
}

/** The distance residual covers the overlapping part of two measured wall faces. */
function wallResidual(model: AlignmentWall, measured: AlignmentWall): number {
  if (Math.abs(dot(wallAxis(model), wallAxis(measured))) < PARALLEL) return Infinity;
  const [start, end] = [projection(measured.a, model), projection(measured.b, model)].sort((a, b) => a - b);
  const span = length(sub(model.b, model.a));
  const lo = Math.max(0, start!), hi = Math.min(span, end!);
  if (hi - lo < Math.min(span * 0.45, 1.2)) return Infinity;
  const [dx, dz] = wallAxis(model);
  const at = (s: number): Point => [model.a[0] + dx * s, model.a[1] + dz * s];
  return Math.max(lineError(at(lo), measured), lineError(at(hi), measured));
}

function angleClose(a: number, b: number): boolean {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= ANGLE_DEDUP;
}

function matchesLandmarks(
  matrix: Matrix4, modeled: AlignmentLandmark[], measured: AlignmentLandmark[], perimeter: AlignmentWall[], vertical: number,
) {
  let count = 0, error = 0;
  for (const landmark of modeled) {
    const expected = new Vector3(...landmark.center).applyMatrix4(matrix);
    let nearest = Infinity;
    for (const seen of measured) {
      if (seen.kind !== landmark.kind || Math.abs(seen.width - landmark.width) > 0.22 ||
        Math.abs(seen.height - landmark.height) > 0.22) continue;
      nearest = Math.min(nearest, expected.distanceTo(new Vector3(...seen.center)));
    }
    if (nearest <= LIMIT) { count++; error = Math.max(error, nearest); }
  }
  const plausible = measured.some((seen) => modeled.some(({ kind }) => seen.kind === kind) &&
    perimeter.some((wall) => seen.center[1] >= wall.low + vertical && seen.center[1] <= wall.high + vertical &&
      pointOnWall(planar(seen.center), wall, 0.10)));
  return { count, error, conflict: plausible && count === 0 };
}

export function matchRoomAlignment(model: AlignmentModel, evidence: RoomEvidence, viewer: Vector3): AlignmentCandidate[] {
  const { walls, floor, landmarks } = evidence;
  if (model.walls.length < 3 || model.walls.length > 20 || walls.length < 3 || !floor ||
    !Number.isFinite(floor.y) || Math.abs(floor.y) > FLOOR_TOLERANCE_M ||
    !pointInFootprint(viewer.x, viewer.z, { outer: floor.outline })) return [];
  if (viewer.y - floor.y < 0.45 || viewer.y - floor.y > (model.room.ceilingHeight ?? 2.7) + 0.2) return [];
  const vertical = floor.y - model.room.floorElevation;
  const measured = walls
    .filter((wall) => Math.abs(wall.low - floor.y) <= 0.2 && wall.high - floor.y >= 1.65)
    .sort((a, b) => length(sub(b.b, b.a)) - length(sub(a.b, a.a))).slice(0, 16);
  const candidates: AlignmentCandidate[] = [];
  const vec = new Vector3();
  for (const [i, a] of model.walls.entries()) for (const [j, b] of model.walls.entries()) {
    if (i >= j || Math.abs(cross(wallAxis(a), wallAxis(b))) < 0.5) continue;
    for (const [k, observedA] of measured.entries()) for (const [l, observedB] of measured.entries()) {
      if (k === l) continue;
      const na = wallNormal(observedA), nb = wallNormal(observedB);
      const det = cross(na, nb);
      if (Math.abs(det) < 0.5) continue;
      const da = wallAxis(a), oa = wallAxis(observedA);
      const baseYaw = Math.atan2(da[1], da[0]) - Math.atan2(oa[1], oa[0]);
      for (const yaw of [baseYaw, baseYaw + Math.PI]) {
        if (Math.abs(dot(rotate(wallAxis(b), yaw), wallAxis(observedB))) < PARALLEL) continue;
        const c1 = dot(sub(observedA.a, rotate(a.a, yaw)), na);
        const c2 = dot(sub(observedB.a, rotate(b.a, yaw)), nb);
        const shift: Point = [(c1 * nb[1] - c2 * na[1]) / det, (na[0] * c2 - nb[0] * c1) / det];
        const here = rotate([viewer.x - shift[0], viewer.z - shift[1]], -yaw);
        if (!pointInFootprint(here[0], here[1], model.room.footprint)) continue;
        if (wallResidual(transformed(a, yaw, shift), observedA) > LIMIT ||
          wallResidual(transformed(b, yaw, shift), observedB) > LIMIT) continue;

        // Only the two training walls set yaw and X/Z. Every other wall is withheld.
        const used = new Set([k, l]);
        let residual = 0;
        for (const [m, wall] of model.walls.entries()) {
          if (m === i || m === j) continue;
          const expected = transformed(wall, yaw, shift);
          let best = Infinity, bestIndex = -1;
          for (const [n, seen] of measured.entries()) {
            if (used.has(n)) continue;
            const error = Math.hypot(wallResidual(expected, seen), seen.low - floor.y);
            if (error < best) { best = error; bestIndex = n; }
          }
          residual = Math.max(residual, best);
          used.add(bestIndex);
          if (residual > LIMIT) break;
        }
        if (residual > LIMIT) continue;
        // Withhold a corner outside the intersection of the two training walls for later rechecks.
        const check = model.corners.find(({ point }) =>
          lineError(planar(point), a) > 0.3 && lineError(planar(point), b) > 0.3) ??
          model.corners.find(({ point }) => lineError(planar(point), a) > 0.3 || lineError(planar(point), b) > 0.3);
        if (!check) continue;
        const matrix = new Matrix4().makeRotationY(yaw).setPosition(shift[0], vertical, shift[1]);
        const opening = matchesLandmarks(matrix, model.landmarks, landmarks,
          landmarks.length ? model.walls.map((wall) => transformed(wall, yaw, shift)) : [], vertical);
        const fit: CalibrationFit = { matrix, yaw, modelOrigin: check.point, anchorPosition: vec.fromArray(check.point).applyMatrix4(matrix).toArray() };
        const candidate = {
          fit, check, errorM: Math.max(residual, opening.error), landmarkCount: opening.count, landmarkConflict: opening.conflict,
        };
        const existing = candidates.findIndex((entry) =>
          angleClose(entry.fit.yaw, yaw) && vec.fromArray(check.point).applyMatrix4(entry.fit.matrix)
            .distanceTo(new Vector3(...fit.anchorPosition)) <= METRE_DEDUP);
        if (existing < 0) candidates.push(candidate);
        else if (candidate.landmarkCount > candidates[existing]!.landmarkCount ||
          (candidate.landmarkCount === candidates[existing]!.landmarkCount && candidate.errorM < candidates[existing]!.errorM))
          candidates[existing] = candidate;
      }
    }
  }
  return candidates;
}

export function uniqueRoomAlignment(candidates: AlignmentCandidate[]): AlignmentCandidate | null {
  if (candidates.length === 1) return candidates[0]!.landmarkConflict ? null : candidates[0]!;
  const withOpening = candidates.filter((candidate) => candidate.landmarkCount > 0);
  return withOpening.length === 1 ? withOpening[0]! : null;
}

export function applyAlignmentHint(
  model: AlignmentModel, candidates: AlignmentCandidate[], hint: AlignmentHint, physical: Vector3,
): AlignmentCandidate | null {
  if (!finite(physical)) return null;
  const local = new Vector3();
  const inverse = new Matrix4();
  const matching = candidates.filter(({ fit }) => {
    local.copy(physical).applyMatrix4(inverse.copy(fit.matrix).invert());
    if (hint.kind === "wall") {
      const wall = model.walls[hint.index];
      if (!wall || !pointOnWall([local.x, local.z], wall, LIMIT)) return false;
      const station = projection([local.x, local.z], wall);
      return station >= 0.2 && station <= length(sub(wall.b, wall.a)) - 0.2 &&
        local.y >= wall.low + 0.25 && local.y <= wall.high;
    }
    const landmark = model.landmarks[hint.index];
    if (!landmark) return false;
    // The whole opening can be aimed at, while the candidate's geometric residual remains held-out.
    const wall = model.walls.find((w) => pointOnWall(planar(landmark.center), w, LIMIT));
    if (!wall || !pointOnWall([local.x, local.z], wall, 0.09)) return false;
    return Math.abs(projection([local.x, local.z], wall) - projection(planar(landmark.center), wall)) <= landmark.width / 2 &&
      Math.abs(local.y - landmark.center[1]) <= landmark.height / 2;
  });
  return matching.length === 1 ? matching[0]! : null;
}
