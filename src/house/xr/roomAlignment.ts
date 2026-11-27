import { Box3, Matrix4, Scene, Vector3, type Object3D } from "three";
import { pointInFootprint } from "@/house/model/geometry2d";
import type { Room, Vec3 } from "@/house/model/types";
import type { SceneIndex } from "@/house/scene/SceneIndex";
import { explodeTargets, offsetsFor, type ExplodeState } from "@/house/scene/explode";
import { MAX_CALIBRATION_ERROR_M, type CalibrationFeature, type CalibrationFit } from "./mixedCalibration";
import { architectureFromOpenings, checkOpeningGeometry, checkVisibleFloorCorner } from "./roomArchitecture";

import { recordIndependentCheck, type AlignmentSearchDiagnostics, type AlignmentSearchOptions } from "./alignmentSearchDiagnostics";
export { newAlignmentSearchDiagnostics, type AlignmentSearchDiagnostics, type AlignmentSearchOptions } from "./alignmentSearchDiagnostics";
import { matchSelectedRoomCorners } from "./roomCornerConsensus";
export { matchSelectedRoomCorners };
export { openingCalibrationFeature } from "./roomArchitecture";

type Point = [number, number];
export interface AlignmentWall {
  a: Point;
  b: Point;
  low: number;
  high: number;
  baseOnly?: boolean;
  semanticWall?: boolean;
}
export interface AlignmentLandmark {
  kind: "door" | "window";
  center: Vec3;
  width: number;
  height: number;
  /** The original 3D opening center. The perimeter matcher projects center onto its supporting wall. */
  rawCenter?: Vec3;
  axis?: Point;
  elementId?: string;
}
export interface AlignmentModel {
  openingInventoryComplete?: boolean;
  room: Room;
  walls: AlignmentWall[];
  corners: CalibrationFeature[];
  landmarks: AlignmentLandmark[];
}
export interface RoomEvidence {
  walls: AlignmentWall[];
  floor: { y: number; outline: Point[]; source?: "plane" | "mesh" | "bounds"; semanticFloor?: boolean; confirmedHeight?: boolean } | null;
  landmarks: AlignmentLandmark[];
}
export interface AlignmentCandidate {
  fit: CalibrationFit;
  check: CalibrationFeature;
  errorM: number;
  landmarkCount: number;
  landmarkConflict: boolean;
  evidenceKind?: "architecture";
  separatedOpenings?: boolean;
  wallRegistration?: { supportCorners: number; supportWalls: number };
}
export type AlignmentHint = { kind: "wall"; index: number } | { kind: "landmark"; index: number };
const LIMIT = MAX_CALIBRATION_ERROR_M + 1e-8;
/** A labeled room floor may be on the next split level from the local-floor reference origin. */
export function trackedFloorHeightAllowed(y: number, semanticFloor = false): boolean {
  return Number.isFinite(y) && Math.abs(y) <= (semanticFloor ? 0.60 : 0.20);
}
const MIN_WALL_M = 0.28;
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
  if (!index) return { room, walls, corners, landmarks, openingInventoryComplete: false };
  let openingInventoryComplete = true;
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
    // Exterior openings can have a reveal and a wall ID but no room links.
    if (element.roomIds?.length && !element.roomIds.includes(room.id) &&
      !ids.some((id) => index.manifest.surfaces.get(id)?.roomId === room.id)) continue;
    const bounds = new Vector3();
    // A reveal is part of the opening. A door leaf may be depicted open.
    const meshes = ids.filter((id) => index.manifest.surfaces.get(id)?.role === "reveal").map((id) => index.surfaceMesh.get(id));
    if (meshes.some(mesh => !mesh)) openingInventoryComplete = false;
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
    const candidates = walls.flatMap((wall) => {
      if (!pointOnWall([bounds.x, bounds.z], wall, 0.32)) return [];
      let lo = Infinity, hi = -Infinity;
      for (const p of points) {
        const station = projection([p.x, p.z], wall);
        lo = Math.min(lo, station);
        hi = Math.max(hi, station);
      }
      const span = length(sub(wall.b, wall.a));
      return hi - lo >= 0.3 && lo >= -0.12 && hi <= span + 0.12 ? [{ wall, lo, hi }] : [];
    }).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo));
    const found = candidates[0];
    const height = box.max.y - box.min.y;
    if (!found || height < 0.3) continue;
    const { wall, lo, hi } = found;
    const along = (lo + hi) / 2, width = hi - lo, [x, z] = wallAxis(wall);
    landmarks.push({ kind: element.kind, elementId: element.id, rawCenter: bounds.toArray(), axis: [x, z],
      center: [wall.a[0] + x * along, bounds.y, wall.a[1] + z * along], width, height });
  }
  return { room, walls, corners, landmarks, openingInventoryComplete };
}

function transformed(wall: AlignmentWall, yaw: number, translation: Point): AlignmentWall {
  const apply = (p: Point): Point => {
    const q = rotate(p, yaw);
    return [q[0] + translation[0], q[1] + translation[1]];
  };
  return { ...wall, a: apply(wall.a), b: apply(wall.b) };
}

/** The distance residual covers the overlapping part of two measured wall faces. */
function wallResidual(model: AlignmentWall, measured: AlignmentWall, minimumOverlap = measured.baseOnly ? 0.65 : 1.2): number {
  if (Math.abs(dot(wallAxis(model), wallAxis(measured))) < PARALLEL) return Infinity;
  const [start, end] = [projection(measured.a, model), projection(measured.b, model)].sort((a, b) => a - b);
  const span = length(sub(model.b, model.a));
  const lo = Math.max(0, start!), hi = Math.min(span, end!);
  if (hi - lo < Math.min(span * 0.45, minimumOverlap)) return Infinity;
  const [dx, dz] = wallAxis(model);
  const at = (s: number): Point => [model.a[0] + dx * s, model.a[1] + dz * s];
  return Math.max(lineError(at(lo), measured), lineError(at(hi), measured));
}

function nativeFloorEdges(floor: NonNullable<RoomEvidence["floor"]>, perimeter: AlignmentWall[]): AlignmentWall[] {
  if (floor.source !== "plane") return [];
  const edges = floor.outline.flatMap((a, i) => {
    const b = floor.outline[(i + 1) % floor.outline.length]!;
    return length(sub(a, b)) >= MIN_WALL_M ? [{ a, b, low: floor.y, high: floor.y }] : [];
  });
  // A floor that extends into adjacent spaces, or records only a partial scan, cannot
  // stand in for hidden room walls. Its outline needs support in both directions.
  if (edges.length < 3 || edges.some((edge) => !perimeter.some((wall) =>
    wallResidual(edge, wall) <= LIMIT && pointOnWall(edge.a, wall, LIMIT * 1.5) &&
    pointOnWall(edge.b, wall, LIMIT * 1.5)))) return [];
  return edges;
}

function angleClose(a: number, b: number): boolean {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= ANGLE_DEDUP;
}

function wallDistance(point: Point, wall: AlignmentWall): number {
  const station = projection(point, wall), span = length(sub(wall.b, wall.a));
  return Math.hypot(lineError(point, wall), Math.max(0, -station, station - span));
}

function matchesLandmarks(
  matrix: Matrix4, modeled: AlignmentLandmark[], measured: AlignmentLandmark[], perimeter: AlignmentWall[], vertical: number,
) {
  let count = 0, error = 0, conflict = false;
  const expected = modeled.map((mark) => ({ mark, point: new Vector3(...mark.center).applyMatrix4(matrix) }));
  const claimed = new Set<AlignmentLandmark>();
  for (const seen of measured) {
    if (!perimeter.some((wall) => seen.center[1] >= wall.low + vertical && seen.center[1] <= wall.high + vertical &&
      pointOnWall(planar(seen.center), wall, 0.10))) continue;
    const similar = expected.filter(({ mark }) => seen.kind === mark.kind &&
      Math.abs(seen.width - mark.width) <= 0.22 && Math.abs(seen.height - mark.height) <= 0.22);
    const point = new Vector3(...seen.center);
    let best: AlignmentLandmark | null = null, distance = Infinity;
    for (const entry of similar) {
      if (claimed.has(entry.mark)) continue;
      const gap = entry.point.distanceTo(point);
      if (gap < distance) { best = entry.mark; distance = gap; }
    }
    if (best && distance <= LIMIT) {
      claimed.add(best);
      count++;
      error = Math.max(error, distance);
    } else if (similar.length) conflict = true;
  }
  return { count, error, conflict };
}

const TRACE_PARALLEL = Math.cos(6 * Math.PI / 180);
const midpoint = (w: AlignmentWall): Point => [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];

function strokeResidual(face: AlignmentWall, stroke: AlignmentWall) {
  // Both ends must actually lie on this finite face. Collinear walls in separate parts
  // of a concave footprint and a stroke across a doorway cannot trade places.
  return Math.max(wallDistance(stroke.a, face), wallDistance(stroke.b, face));
}

interface WallValidation {
  check: CalibrationFeature;
  residual: number;
  assignment?: string;
}

function checkTraces(
  model: AlignmentModel, perimeter: AlignmentWall[], strokes: AlignmentWall[], floorY: number,
  i: number, j: number, k: number, l: number, yaw: number, shift: Point, trainingError: number, diagnostics?: AlignmentSearchDiagnostics,
): WallValidation | null {
  const claimed = new Set([i, j]);
  const assignment = new Array<number>(strokes.length);
  assignment[k] = i;
  assignment[l] = j;
  const withheld: { observed: AlignmentWall; expected: AlignmentWall }[] = [];
  let residual = trainingError;
  for (const [n, observed] of strokes.entries()) {
    if (n === k || n === l) continue;
    // Unlike an automatic room search, the wearer has explicitly identified the room.
    // Explain every recorded stroke; unseen wall returns are not missing observations.
    let index = -1, error = Infinity;
    for (const [m, face] of perimeter.entries()) {
      if (claimed.has(m)) continue;
      const distance = strokeResidual(face, observed);
      if (distance < error) { error = distance; index = m; }
    }
    residual = Math.max(residual, Math.hypot(error, observed.low - floorY));
    if (index < 0 || (residual > LIMIT && (!diagnostics || diagnostics.traceComparisons >= 128))) return null;
    claimed.add(index);
    assignment[n] = index;
    withheld.push({ observed, expected: model.walls[index]! });
  }

  if (diagnostics && Number.isFinite(residual)) {
    diagnostics.traceComparisons++;
    diagnostics.bestTraceGapM = Math.min(diagnostics.bestTraceGapM ?? Infinity, residual);
  }
  if (residual > LIMIT) return null;
  // Intersect two held-out wall lines and check their shared model corner in full 3D.
  // A repeated or parallel stroke alone cannot certify the translation along a wall.
  let best: WallValidation | null = null;
  for (const [n, a] of withheld.entries()) for (const b of withheld.slice(n + 1)) {
    const axis = wallAxis(a.observed), second = wallAxis(b.observed), det = cross(axis, second);
    if (Math.abs(det) < 0.5) continue;
    const check = model.corners.find(({ point }) =>
      wallDistance(planar(point), a.expected) < 0.015 && wallDistance(planar(point), b.expected) < 0.015 &&
      (lineError(planar(point), model.walls[i]!) > 0.3 || lineError(planar(point), model.walls[j]!) > 0.3));
    if (!check) continue;
    const t = cross(sub(b.observed.a, a.observed.a), second) / det;
    const point: Point = [a.observed.a[0] + t * axis[0], a.observed.a[1] + t * axis[1]];
    const expected = rotate(planar(check.point), yaw);
    const pointGap = Math.hypot(point[0] - expected[0] - shift[0], point[1] - expected[1] - shift[1],
      (a.observed.low + b.observed.low) / 2 - floorY);
    recordIndependentCheck(diagnostics, pointGap);
    const error = Math.max(residual, pointGap);
    if (error <= LIMIT && (!best || error < best.residual)) best = { check, residual: error };
  }
  return best && { ...best, assignment: assignment.join(",") };
}

function checkPerimeter(
  model: AlignmentModel, perimeter: AlignmentWall[], measured: AlignmentWall[],
  floor: NonNullable<RoomEvidence["floor"]>, lowRoom: boolean, i: number, j: number, k: number, l: number,
) {
  const a = model.walls[i]!, b = model.walls[j]!;
  const used = new Set([k, l]);
  const floorEdges = nativeFloorEdges(floor, perimeter);
  if (lowRoom && !floorEdges.length) return null;
  let residual = 0;
  for (let m = 0; m < perimeter.length; m++) {
    if (m === i || m === j) continue;
    const expected = perimeter[m]!;
    const floorError = floorEdges.reduce((best, edge) => Math.min(best, wallResidual(expected, edge)), Infinity);
    let best = Infinity, bestIndex = -1;
    let contradictory = false;
    for (const [n, seen] of measured.entries()) {
      if (used.has(n)) continue;
      const lateral = wallResidual(expected, seen);
      const verticalError = floorError <= LIMIT ? Math.min(Math.abs(seen.low - floor.y), floorError) : seen.low - floor.y;
      const error = Math.hypot(lateral, verticalError);
      if (lateral > LIMIT && lateral < 0.17) contradictory = true;
      if (error < best) { best = error; bestIndex = n; }
    }
    if (best > LIMIT && !contradictory && floorError <= LIMIT) { best = floorError; bestIndex = -1; }
    residual = Math.max(residual, best);
    used.add(bestIndex);
    if (residual > LIMIT) break;
  }
  if (residual > LIMIT) return null;
  // Withhold a corner outside the intersection of the two training walls for later rechecks.
  const check = model.corners.find(({ point }) =>
    lineError(planar(point), a) > 0.3 && lineError(planar(point), b) > 0.3) ??
    model.corners.find(({ point }) => lineError(planar(point), a) > 0.3 || lineError(planar(point), b) > 0.3);
  return check && { check, residual };
}

export function matchRoomAlignment(
  model: AlignmentModel, evidence: RoomEvidence, viewer: Vector3, options: AlignmentSearchOptions = {},
): AlignmentCandidate[] {
  // Foreground recognition has its own incremental per-room budget. Only the optional
  // outlier diagnostic yields part way through an individual room.
  const result = alignmentSearch(model, evidence, viewer, false, options).next();
  if (result.done && result.value.length) return result.value;
  const openings = architectureFromOpenings(model, evidence, viewer, options);
  if (openings.length || !options.selectedRoom) return openings;
  const local = matchSelectedRoomCorners(model, evidence, viewer);
  if (local.estimate?.checkM != null) recordIndependentCheck(options.diagnostics, local.estimate.checkM);
  return local.verified ? [local.verified] : [];
}

function* alignmentSearch(
  model: AlignmentModel, evidence: RoomEvidence, viewer: Vector3, incremental: boolean, options: AlignmentSearchOptions = {},
): Generator<void, AlignmentCandidate[]> {
  const { walls, floor, landmarks } = evidence;
  const confirmed = floor?.source === "bounds" && floor.confirmedHeight && walls.some(wall => wall.baseOnly);
  if (model.walls.length < 3 || model.walls.length > 20 || walls.length < 2 || !floor ||
    !trackedFloorHeightAllowed(floor.y, floor.semanticFloor || confirmed) ||
    (floor.source !== "bounds" && !pointInFootprint(viewer.x, viewer.z, { outer: floor.outline }))) return [];
  if (viewer.y - floor.y < 0.45 || viewer.y - floor.y > (model.room.ceilingHeight ?? 2.7) + 0.2) return [];
  const vertical = floor.y - model.room.floorElevation;
  const px = model.room.footprint.outer.map(([x]) => x), pz = model.room.footprint.outer.map(([, z]) => z);
  const span = Math.hypot(Math.max(...px) - Math.min(...px), Math.max(...pz) - Math.min(...pz));
  const station: Point = [viewer.x, viewer.z];
  const modeledHeight = model.room.ceilingHeight ?? 2.7;
  const lowRoom = modeledHeight < 1.8 && floor.source === "plane";
  const wallTop = lowRoom ? Math.max(0.52, modeledHeight - 0.15) : 1.65;
  const wallSpan = lowRoom ? Math.max(0.43, modeledHeight * 0.65) : 1.2;
  const handwritten = walls.filter(wall => wall.baseOnly);
  const traces = floor.source === "bounds" && handwritten.length >= 4;
  const traditionalFace = (wall: AlignmentWall) => Math.abs(wall.low - floor.y) <= (floor.source === "plane" ? 0.45 : 0.2) &&
    (wall.baseOnly ? floor.source === "bounds" && Math.abs(wall.high - wall.low) < 1e-6
      : wall.high - floor.y >= wallTop && wall.high - wall.low >= wallSpan);
  const haveOpening = model.landmarks.some(mark => mark.rawCenter && mark.axis) && landmarks.some(mark => mark.rawCenter && mark.axis);
  const haveFloorOutline = floor.source === "plane" && floor.semanticFloor && model.room.ceilingHeight;
  const architectureFace = (wall: AlignmentWall) => (haveOpening || haveFloorOutline) && wall.semanticWall && !wall.baseOnly &&
    (floor.source === "plane" || floor.source === "mesh") && wall.high - wall.low >= 0.5 &&
    wall.low >= floor.y - 0.15 && wall.high <= floor.y + modeledHeight + 0.25 &&
    length(sub(wall.b, wall.a)) >= 0.8;
  const measured = (traces ? handwritten : walls)
    .filter((wall) => traditionalFace(wall) || architectureFace(wall))
    .map((wall) => ({ wall, distance: wallDistance(station, wall), span: length(sub(wall.b, wall.a)) }))
    .filter(({ distance, span: size }) => Number.isFinite(distance) && distance <= span + 0.35 && size >= 0.28)
    .sort((a, b) => Math.floor(a.distance * 2) - Math.floor(b.distance * 2) || b.span - a.span)
    .slice(0, traces ? 20 : 16).map(({ wall }) => wall);
  if (traces && (measured.length > model.walls.length || measured.length !== handwritten.length ||
    measured.some(stroke => Math.abs(stroke.low - floor.y) > LIMIT))) return [];
  const candidates: AlignmentCandidate[] = [];
  const perimeterFaces = measured.filter(traditionalFace);
  const traditional = measured.map(wall => perimeterFaces.indexOf(wall));
  const tagged = measured.map(architectureFace);
  const traceAssignments = new Map<string, number>();
  const vec = new Vector3();
  let deadline = incremental ? performance.now() + 2 : Infinity;
  for (const [i, a] of model.walls.entries()) for (const [j, b] of model.walls.entries()) {
    if (i >= j || Math.abs(cross(wallAxis(a), wallAxis(b))) < 0.5) continue;
    for (const [k, observedA] of measured.entries()) for (const [l, observedB] of measured.entries()) {
      if (incremental && l === 0 && performance.now() >= deadline) {
        yield;
        deadline = performance.now() + 2;
      }
      if (k === l) continue;
      const taggedPair = !traces && tagged[k] && tagged[l];
      const elevated = traditional[k]! < 0 || traditional[l]! < 0;
      if (elevated && !taggedPair) continue;
      const observedNa = wallNormal(observedA), observedNb = wallNormal(observedB);
      if (Math.abs(cross(observedNa, observedNb)) < 0.5) continue;
      const da = wallAxis(a), oa = wallAxis(observedA);
      const baseYaw = Math.atan2(da[1], da[0]) - Math.atan2(oa[1], oa[0]);
      for (const initialYaw of [baseYaw, baseYaw + Math.PI]) {
        const db = rotate(wallAxis(b), initialYaw), ob = wallAxis(observedB);
        const alignment = dot(db, ob);
        if (Math.abs(alignment) < (traces ? TRACE_PARALLEL : PARALLEL)) continue;
        const correction = Math.atan2(cross(db, ob) * -Math.sign(alignment), Math.abs(alignment));
        const spanA = Math.min(length(sub(a.b, a.a)), length(sub(observedA.b, observedA.a)));
        const spanB = Math.min(length(sub(b.b, b.a)), length(sub(observedB.b, observedB.a)));
        const yaw = initialYaw + correction * spanB / (spanA + spanB);
        // A short stroke represents a local piece of a long face. Fit its midpoint to
        // the rotated modeled line, avoiding extrapolation of a shaky heading to a distant corner.
        const na = traces ? rotate(wallNormal(a), yaw) : observedNa;
        const nb = traces ? rotate(wallNormal(b), yaw) : observedNb;
        const det = cross(na, nb);
        const c1 = dot(sub(traces ? midpoint(observedA) : observedA.a, rotate(a.a, yaw)), na);
        const c2 = dot(sub(traces ? midpoint(observedB) : observedB.a, rotate(b.a, yaw)), nb);
        const shift: Point = [(c1 * nb[1] - c2 * na[1]) / det, (na[0] * c2 - nb[0] * c1) / det];
        const here = rotate([viewer.x - shift[0], viewer.z - shift[1]], -yaw);
        if (!pointInFootprint(here[0], here[1], model.room.footprint)) continue;
        const residualFor = traces ? strokeResidual : taggedPair
          ? (face: AlignmentWall, seen: AlignmentWall) => wallResidual(face, seen, 0.8) : wallResidual;
        const trainingError = Math.max(residualFor(transformed(a, yaw, shift), observedA),
          residualFor(transformed(b, yaw, shift), observedB));
        if (trainingError > LIMIT) continue;
        if (options.diagnostics) options.diagnostics.fittedPairs++;

        // Only the two training walls set yaw and X/Z. Every other wall is withheld.
        const perimeter = model.walls.map((wall) => transformed(wall, yaw, shift));
        const matrix = new Matrix4().makeRotationY(yaw).setPosition(shift[0], vertical, shift[1]);
        const validation: WallValidation | null | undefined = traces
          ? checkTraces(model, perimeter, measured, floor.y, i, j, k, l, yaw, shift, trainingError, options.diagnostics)
          : elevated ? null : checkPerimeter(model, perimeter, perimeterFaces, floor, lowRoom,
            i, j, traditional[k]!, traditional[l]!);
        let candidate: AlignmentCandidate;
        if (validation) {
          const { check, residual } = validation;
          const opening = matchesLandmarks(matrix, model.landmarks, landmarks, perimeter, vertical);
          const fit: CalibrationFit = { matrix, yaw, modelOrigin: check.point,
            anchorPosition: vec.fromArray(check.point).applyMatrix4(matrix).toArray() };
          candidate = { fit, check, errorM: Math.max(residual, opening.error, trainingError),
            landmarkCount: opening.count, landmarkConflict: opening.conflict };
        } else {
          if (!taggedPair) continue;
          let architectural: AlignmentCandidate | null = null;
          if (haveOpening) {
            const first = wallAxis(observedA), second = wallAxis(observedB);
            const t = cross(sub(observedB.a, observedA.a), second) / cross(first, second);
            const intersection: Point = [observedA.a[0] + t * first[0], observedA.a[1] + t * first[1]];
            architectural = checkOpeningGeometry(model, evidence, matrix, undefined, intersection, options, [observedA, observedB]);
          }
          if (!architectural && !landmarks.length && floor.source === "plane" && floor.semanticFloor) {
            const check = model.corners.find(({ point }) =>
              lineError(planar(point), a) > 0.5 && lineError(planar(point), b) > 0.5);
            if (check) architectural = checkVisibleFloorCorner(model, floor, perimeter, check, matrix, observedA, observedB, options.diagnostics);
          }
          if (!architectural) continue;
          candidate = architectural;
          candidate.errorM = Math.max(candidate.errorM, trainingError);
        }
        const { fit, check } = candidate;
        const assignment = validation?.assignment;
        // Different training pairs can return slightly different noisy fits for exactly
        // the same observed-to-modeled wall assignment. They describe one orientation.
        const existing = (assignment ? traceAssignments.get(assignment) : undefined) ?? candidates.findIndex((entry) =>
          angleClose(entry.fit.yaw, yaw) && vec.fromArray(check.point).applyMatrix4(entry.fit.matrix)
            .distanceTo(new Vector3(...fit.anchorPosition)) <= METRE_DEDUP);
        if (existing < 0) {
          if (candidates.length >= 24) return [];
          candidates.push(candidate);
        }
        else if (candidate.landmarkCount > candidates[existing]!.landmarkCount ||
          (candidate.landmarkCount === candidates[existing]!.landmarkCount && candidate.errorM < candidates[existing]!.errorM))
          candidates[existing] = candidate;
        if (assignment) traceAssignments.set(assignment, existing < 0 ? candidates.length - 1 : existing);
      }
    }
  }
  return candidates;
}

/** Identify one suspect stroke only when dropping it alone recovers a checked pose. */
export function* reviewTraceOutlier(
  model: AlignmentModel, walls: readonly AlignmentWall[], viewer: Vector3, floorY: number,
  semanticFloor = false, confirmedHeight = false,
): Generator<void, number | null> {
  if (walls.length < 5 || walls.length > 20 || walls.length - 1 > model.walls.length) return null;
  const strokes = [...walls], eye = viewer.clone();
  let suspect: number | null = null;
  for (let i = 0; i < strokes.length; i++) {
    const evidence: RoomEvidence = { floor: { y: floorY, outline: [], source: "bounds", semanticFloor, confirmedHeight },
      walls: strokes.filter((_, n) => n !== i), landmarks: [] };
    const candidates = yield* alignmentSearch(model, evidence, eye, true);
    if (viableRoomAlignments(candidates).length) {
      if (suspect !== null) return null;
      suspect = i;
    }
    if (i + 1 < strokes.length) yield;
  }
  return suspect;
}

export function viableRoomAlignments(candidates: readonly AlignmentCandidate[]): AlignmentCandidate[] {
  return candidates.filter(({ landmarkConflict }) => !landmarkConflict);
}

export function uniqueRoomAlignment(candidates: AlignmentCandidate[]): AlignmentCandidate | null {
  // Conflict alone does not certify orientation if a different pose also explained every wall.
  if (candidates.length === 1) return viableRoomAlignments(candidates)[0] ?? null;
  const withOpening = viableRoomAlignments(candidates).filter((candidate) => candidate.landmarkCount > 0);
  return withOpening.length === 1 ? withOpening[0]! : null;
}

export function applyAlignmentHint(
  model: AlignmentModel, candidates: AlignmentCandidate[], hint: AlignmentHint, physical: Vector3,
): AlignmentCandidate | null {
  if (!finite(physical)) return null;
  const local = new Vector3();
  const inverse = new Matrix4();
  const matching = viableRoomAlignments(candidates).filter(({ fit }) => {
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

/** Maximum change in metres anywhere on the modeled floor perimeter. */
export function roomPoseDrift(room: Room, a: Matrix4, b: Matrix4): number {
  const p = new Vector3(),
    q = new Vector3();
  let maximum = 0;
  for (const [x, z] of room.footprint.outer) {
    p.set(x, room.floorElevation, z);
    q.copy(p).applyMatrix4(b);
    maximum = Math.max(maximum, p.applyMatrix4(a).distanceTo(q));
  }
  return maximum;
}

/** Check a previously tracked pose against a measured floor/wall corner without fitting a new transform. */
export function checkAnchoredCorner(
  model: AlignmentModel,
  evidence: RoomEvidence,
  viewer: Vector3,
  matrix: Matrix4,
  featureId?: string,
): AlignmentCandidate | null {
  const floor = evidence.floor;
  if (
    !floor ||
    (floor.source !== "plane" && floor.source !== "mesh") ||
    !trackedFloorHeightAllowed(floor.y, floor.semanticFloor) ||
    !pointInFootprint(viewer.x, viewer.z, { outer: floor.outline })
  )
    return null;
  const localViewer = viewer.clone().applyMatrix4(matrix.clone().invert());
  if (!pointInFootprint(localViewer.x, localViewer.z, model.room.footprint)) return null;
  const y = matrix.elements[13]!;
  const floorError = Math.abs(model.room.floorElevation + y - floor.y);
  if (
    floorError > LIMIT ||
    viewer.y - floor.y < 0.45 ||
    viewer.y - floor.y > (model.room.ceilingHeight ?? 2.7) + 0.2
  )
    return null;
  const yaw = Math.atan2(matrix.elements[8]!, matrix.elements[10]!);
  const perimeter = model.walls.map((w) =>
    transformed(w, yaw, [matrix.elements[12]!, matrix.elements[14]!]),
  );
  const marks = matchesLandmarks(matrix, model.landmarks, evidence.landmarks, perimeter, y);
  if (marks.conflict) return null;
  // Match overlapping wall faces first. A nearby contradictory surface is grounds to seek a full scan.
  const observed = evidence.walls.filter(
    (w) => !w.baseOnly && Math.abs(w.low - floor.y) < 0.35 && w.high - w.low >= 1.2,
  );
  const faces = perimeter.map((wall) => {
    const matches = observed
      .map((seen) => ({ seen, error: wallResidual(wall, seen) }))
      .sort((a, b) => a.error - b.error);
    return matches[0];
  });
  if (faces.some((hit) => hit && hit.error > LIMIT && hit.error < 0.22)) return null;
  for (const check of model.corners) {
    if (featureId && check.id !== featureId) continue;
    const expected = new Vector3(...check.point).applyMatrix4(matrix);
    const corner: Point = [expected.x, expected.z];
    const sides = perimeter.flatMap((wall, i) => {
      const hit = faces[i];
      if (
        !hit ||
        hit.error > LIMIT ||
        Math.min(length(sub(corner, wall.a)), length(sub(corner, wall.b))) > 0.01 ||
        wallDistance(corner, hit.seen) > 0.16
      )
        return [];
      return [{ wall, seen: hit.seen }];
    });
    for (let i = 0; i < sides.length; ++i)
      for (let j = i + 1; j < sides.length; ++j) {
        const first = sides[i]!,
          second = sides[j]!;
        const a = wallAxis(first.seen),
          b = wallAxis(second.seen),
          det = cross(a, b);
        if (Math.abs(det) < 0.55) continue;
        const t = cross(sub(second.seen.a, first.seen.a), b) / det;
        const intersection = new Vector3(first.seen.a[0] + t * a[0], floor.y, first.seen.a[1] + t * a[1]);
        const error = expected.distanceTo(intersection);
        // A rotation around the check point must also stay within tolerance across the room.
        const reach = Math.max(
          ...model.corners.map((c) => length(sub(planar(c.point), planar(check.point)))),
        );
        const angle = Math.max(
          ...[first, second].map((s) =>
            Math.acos(Math.min(1, Math.abs(dot(wallAxis(s.seen), wallAxis(s.wall))))),
          ),
        );
        const errorM = Math.max(marks.error, error + 2 * reach * Math.sin(angle / 2));
        if (Number.isFinite(errorM) && errorM <= MAX_CALIBRATION_ERROR_M) {
          return {
            fit: {
              matrix: matrix.clone(),
              yaw,
              modelOrigin: check.point,
              anchorPosition: expected.toArray(),
            },
            check,
            errorM,
            landmarkCount: marks.count,
            landmarkConflict: false,
          };
        }
      }
  }
  return null;
}
