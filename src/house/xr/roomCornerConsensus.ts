import { Matrix4, Vector3 } from "three";
import { pointInFootprint, signedClearance } from "../model/geometry2d";
import type { Vec2 } from "../model/types";
import { MAX_CALIBRATION_ERROR_M, type CalibrationFeature } from "./mixedCalibration";
import type { AlignmentCandidate, AlignmentLandmark, AlignmentModel, AlignmentWall, RoomEvidence } from "./roomAlignment";

const checkLimit = MAX_CALIBRATION_ERROR_M + 1e-8;
const cosFace = Math.cos(4 * Math.PI / 180);
const cosContext = Math.cos(8 * Math.PI / 180);
const gap = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
const unit = (a: Vec2, b: Vec2): Vec2 => [(b[0] - a[0]) / gap(a, b), (b[1] - a[1]) / gap(a, b)];
const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const rotate = (p: Vec2, c: number, s: number): Vec2 => [c * p[0] + s * p[1], -s * p[0] + c * p[1]];
const moved = (p: Vec2, c: number, s: number, t: Vec2): Vec2 => [c * p[0] + s * p[1] + t[0], -s * p[0] + c * p[1] + t[1]];

function side(wall: AlignmentWall, index: number) {
  const axis = unit(wall.a, wall.b);
  return { ...wall, index, axis, normal: [-axis[1], axis[0]] as Vec2, length: gap(wall.a, wall.b), mid: mid(wall.a, wall.b) };
}
type Face = ReturnType<typeof side>;
interface Turn { point: Vec2; u: Vec2; v: Vec2 }
interface ModelTurn extends Turn { h: number; feature: CalibrationFeature; broad: boolean }
interface SeenTurn extends Turn { faces: [number, number]; ends: [Vec2, Vec2]; bases: [number, number] }
interface CornerMatch { model: ModelTurn; seen: SeenTurn; error: number }
interface Hypothesis {
  matrix: Matrix4;
  corners: CornerMatch[];
  walls: number;
  check: CornerMatch;
  trainingError: number;
  score: number;
}
export interface SelectedRoomCorners {
  verified: AlignmentCandidate | null;
  estimate: { matrix: Matrix4; supportCorners: number; supportWalls: number; checkM: number | null } | null;
}

function modelTurns(model: AlignmentModel): ModelTurn[] {
  const ring = model.corners;
  return ring.flatMap((feature, i) => {
    const [x, h, z] = feature.point, p: Vec2 = [x, z];
    const a = ring[(i + ring.length - 1) % ring.length]!.point, b = ring[(i + 1) % ring.length]!.point;
    const prev: Vec2 = [a[0], a[2]], next: Vec2 = [b[0], b[2]];
    const left = gap(p, prev), right = gap(p, next);
    if (Math.min(left, right) < 0.24 || Math.max(left, right) < 0.8) return [];
    const u = unit(p, prev), v = unit(p, next);
    return Math.abs(cross(u, v)) < 0.55 ? [] : [{ point: p, h, u, v, feature, broad: Math.min(left, right) >= 0.7 }];
  });
}

function observedTurns(faces: Face[]): SeenTurn[] {
  const turns: SeenTurn[] = [];
  for (const [i, a] of faces.entries()) for (const b of faces.slice(i + 1)) {
    if (Math.abs(cross(a.axis, b.axis)) < 0.55 || Math.abs(a.low - b.low) > checkLimit) continue;
    for (const p of [a.a, a.b]) for (const q of [b.a, b.b]) {
      if (gap(p, q) > checkLimit) continue;
      const point = mid(p, q);
      const u = unit(p, p === a.a ? a.b : a.a), v = unit(q, q === b.a ? b.b : b.a);
      turns.push({ point, u, v, faces: [a.index, b.index], ends: [p, q], bases: [a.low, b.low] });
    }
  }
  return turns;
}

function overlapError(a: Face, b: Face, c: number, s: number, t: Vec2) {
  const axis = rotate(a.axis, c, s);
  if (Math.abs(dot(axis, b.axis)) < cosFace) return Infinity;
  const start = moved(a.a, c, s, t);
  const p = dot(sub(b.a, start), axis), q = dot(sub(b.b, start), axis);
  const lo = Math.max(0, Math.min(p, q)), hi = Math.min(a.length, Math.max(p, q));
  if (hi - lo < Math.min(0.85, a.length * 0.6, b.length * 0.6)) return Infinity;
  const offset = dot(sub(start, b.a), b.normal), slope = dot(axis, b.normal);
  return Math.max(Math.abs(offset + lo * slope), Math.abs(offset + hi * slope));
}

function cornerMatches(
  corners: ModelTurn[], turns: SeenTurn[], c: number, s: number, t: Vec2, vertical: number,
) {
  const matches: CornerMatch[] = [];
  for (const model of corners) {
    const u = rotate(model.u, c, s), v = rotate(model.v, c, s), point = moved(model.point, c, s, t);
    for (const seen of turns) {
      const error = Math.max(...seen.ends.map((end, i) => Math.hypot(gap(point, end), model.h + vertical - seen.bases[i]!)));
      if (error > 0.22 || !((dot(u, seen.u) >= cosContext && dot(v, seen.v) >= cosContext) ||
          (dot(u, seen.v) >= cosContext && dot(v, seen.u) >= cosContext))) continue;
      matches.push({ model, seen, error });
    }
  }
  matches.sort((a, b) => a.error - b.error);
  const used: CornerMatch[] = [];
  for (const match of matches) {
    if (!used.some(m => gap(m.model.point, match.model.point) < 0.65 || gap(m.seen.point, match.seen.point) < 0.65))
      used.push(match);
  }
  return used;
}

/** All three corners occupy different stations across the room. */
function spread(corners: CornerMatch[]) {
  for (const [i, a] of corners.entries()) for (const [j, b] of corners.slice(i + 1).entries()) {
    const baseline = sub(a.model.point, b.model.point), span = gap(a.model.point, b.model.point);
    if (span < 1.5) continue;
    for (const c of corners.slice(i + j + 2)) {
      if (Math.abs(cross(baseline, sub(c.model.point, b.model.point))) / span >= 1 &&
          gap(a.model.point, c.model.point) >= 1.5 && gap(b.model.point, c.model.point) >= 1.5) return true;
    }
  }
  return false;
}

/** Scanner-drawn opening dimensions vary. Nearby windows on two different wall bearings
 * corroborate room identity, but none of these loose comparisons are registration checks. */
function openingsAgree(model: AlignmentModel, openings: AlignmentLandmark[], c: number, s: number, t: Vec2, vertical: number) {
  const usable: { observed: number; axis: Vec2 }[] = [];
  for (const m of model.landmarks) {
    if (!m.axis || !m.rawCenter) continue;
    const axis = rotate(m.axis, c, s), at = moved([m.rawCenter[0], m.rawCenter[2]], c, s, t);
    for (const [i, mark] of openings.entries()) {
      if (mark.kind !== m.kind || !mark.axis || !mark.rawCenter || Math.abs(dot(axis, mark.axis)) < cosContext ||
          Math.min(m.width, mark.width) < Math.max(m.width, mark.width) * 0.55 ||
          Math.min(m.height, mark.height) < Math.max(m.height, mark.height) * 0.65) continue;
      if (Math.abs(m.rawCenter[1] + vertical - mark.rawCenter[1]) > 0.18 ||
          gap(at, [mark.rawCenter[0], mark.rawCenter[2]]) > 0.35) continue;
      if (usable.some(other => other.observed !== i && Math.abs(cross(other.axis, axis)) >= 0.55)) return true;
      usable.push({ observed: i, axis });
    }
  }
  return false;
}

function faceSupport(model: Face[], seen: Face[], c: number, s: number, t: Vec2) {
  const matches = model.flatMap(a => seen.flatMap(b => {
    const error = overlapError(a, b, c, s, t);
    return error <= 0.18 ? [{ a: a.index, b: b.index, error }] : [];
  })).sort((a, b) => a.error - b.error);
  const usedModel = new Set<number>(), usedSeen = new Set<number>();
  for (const { a, b } of matches) if (!usedModel.has(a) && !usedSeen.has(b)) {
    usedModel.add(a); usedSeen.add(b);
  }
  return usedModel.size;
}

function crossesLocalRoom(model: AlignmentModel, faces: Face[], corners: CornerMatch[], c: number, s: number, t: Vec2) {
  // The convex hull of the agreeing junctions is the part of the room supported by this scan.
  const sorted = corners.map(m => m.seen.point).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (points: Vec2[]) => {
    const hull: Vec2[] = [];
    for (const p of points) {
      while (hull.length >= 2 && cross(sub(hull[hull.length - 1]!, hull[hull.length - 2]!), sub(p, hull[hull.length - 1]!)) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  const area = { outer: [...half(sorted), ...half([...sorted].reverse())] };
  return faces.some(face => {
    const steps = Math.max(4, Math.min(72, Math.ceil(face.length / 0.14)));
    let interiorM = 0;
    for (let i = 0; i < steps; i++) {
      const along = face.length * (i + 0.5) / steps;
      const x = face.a[0] + along * face.axis[0], z = face.a[1] + along * face.axis[1];
      const local = rotate([x - t[0], z - t[1]], c, -s);
      if (signedClearance(x, z, area) > 0.16 && signedClearance(local[0], local[1], model.room.footprint) > 0.18) {
        interiorM += face.length / steps;
        if (interiorM >= 0.65) return true;
      } else interiorM = 0;
    }
    return false;
  });
}

function perimeterDrift(model: AlignmentModel, a: Matrix4, b: Matrix4) {
  const p = new Vector3(), q = new Vector3();
  return Math.max(...model.corners.map(({ point }) => p.fromArray(point).applyMatrix4(a).distanceTo(q.fromArray(point).applyMatrix4(b))));
}

/** In a room named by the wearer, register against its exposed same-level wall junctions.
 * Two nonparallel faces set the fit. Both faces at the independent check corner are held out. */
export function matchSelectedRoomCorners(model: AlignmentModel, evidence: RoomEvidence, eye: Vector3): SelectedRoomCorners {
  const none: SelectedRoomCorners = { verified: null, estimate: null };
  const floor = evidence.floor;
  if (!floor?.semanticFloor || (floor.source !== "plane" && floor.source !== "mesh") ||
      ![eye.x, eye.y, eye.z, floor.y].every(Number.isFinite) || Math.abs(floor.y) > 0.6 ||
      floor.outline.length < 3 || floor.outline.length > 128 || !pointInFootprint(eye.x, eye.z, { outer: floor.outline }) ||
      model.landmarks.length < 2 || evidence.landmarks.length < 2 ||
      eye.y - floor.y < 0.45 || eye.y - floor.y > (model.room.ceilingHeight ?? 2.7) + 0.2 ||
      model.walls.length > 24 || model.corners.length > 48 || evidence.landmarks.length > 48) return none;
  const walls = model.walls.map(side).filter(w => w.length >= 0.75);
  const seen = evidence.walls.map(side).filter(w => w.semanticWall && !w.baseOnly && Math.abs(w.low - floor.y) <= checkLimit &&
    w.length >= 0.75 && w.high - w.low >= Math.min(1.2, (model.room.ceilingHeight ?? 2.7) / 2));
  if (walls.length < 4 || seen.length < 4 || seen.length > 16) return none;
  // The same capture can include another floor's windows. Keep only openings attached to a
  // finite wall face at the wearer's measured floor level before testing any candidate pose.
  const openings = evidence.landmarks.filter(mark => {
    if (!mark.rawCenter || !mark.axis) return false;
    const center: Vec2 = [mark.rawCenter[0], mark.rawCenter[2]];
    return seen.some(f => {
      const delta = sub(center, f.a), station = dot(delta, f.axis);
      return Math.abs(dot(mark.axis!, f.axis)) >= cosContext && station >= -0.12 && station <= f.length + 0.12 &&
        Math.abs(dot(delta, f.normal)) <= 0.15;
    });
  });
  if (openings.length < 2 || !openings.some((m, i) => openings.slice(i + 1).some(n => Math.abs(cross(m.axis!, n.axis!)) > 0.55))) return none;
  const corners = modelTurns(model), turns = observedTurns(seen);
  if (corners.length < 3 || turns.length < 3 || turns.length > 24) return none;
  const vertical = floor.y - model.room.floorElevation;
  const hypotheses: Hypothesis[] = [];
  for (const [i, a] of walls.entries()) for (const b of walls.slice(i + 1)) {
    if (Math.abs(cross(a.axis, b.axis)) < 0.55) continue;
    for (const p of seen) for (const q of seen) {
      const det = cross(p.normal, q.normal);
      if (Math.abs(det) < 0.55) continue;
      const base = Math.atan2(a.axis[1], a.axis[0]) - Math.atan2(p.axis[1], p.axis[0]);
      for (const seed of [base, base + Math.PI]) {
        const second = rotate(b.axis, Math.cos(seed), Math.sin(seed)), agreement = dot(second, q.axis);
        if (Math.abs(agreement) < cosFace) continue;
        const yaw = seed - Math.sign(agreement) * Math.atan2(cross(second, q.axis), Math.abs(agreement)) / 2;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const offA = dot(sub(p.mid, rotate(a.mid, c, s)), p.normal), offB = dot(sub(q.mid, rotate(b.mid, c, s)), q.normal);
        const t: Vec2 = [(offA * q.normal[1] - offB * p.normal[1]) / det, (p.normal[0] * offB - q.normal[0] * offA) / det];
        const localEye = rotate(sub([eye.x, eye.z], t), c, -s);
        if (!pointInFootprint(localEye[0], localEye[1], model.room.footprint)) continue;
        const trainingError = Math.max(overlapError(a, p, c, s, t), overlapError(b, q, c, s, t));
        if (trainingError > checkLimit) continue;
        const matched = cornerMatches(corners, turns, c, s, t, vertical);
        if (matched.length < 3 || !spread(matched)) continue;
        const check = matched.find(m => m.model.broad && !m.seen.faces.includes(p.index) && !m.seen.faces.includes(q.index) &&
          ![a, b].some(w => Math.min(gap(w.a, m.model.point), gap(w.b, m.model.point)) < 0.25));
        if (!check) continue;
        const support = faceSupport(walls, seen, c, s, t);
        if (support < 4 || !openingsAgree(model, openings, c, s, t, vertical) ||
            crossesLocalRoom(model, seen, matched, c, s, t)) continue;
        const score = matched.reduce((sum, m) => sum + m.error, 0) / matched.length;
        hypotheses.push({ matrix: new Matrix4().makeRotationY(yaw).setPosition(t[0], vertical, t[1]), corners: matched,
          walls: support, check, trainingError, score });
        if (hypotheses.length > 96) return none;
      }
    }
  }
  if (!hypotheses.length) return none;
  hypotheses.sort((a, b) => b.corners.length - a.corners.length || b.walls - a.walls || a.score - b.score);
  const best = hypotheses[0]!;
  // A different plausible room orientation cannot be resolved by picking the smallest error.
  if (hypotheses.some(h => perimeterDrift(model, h.matrix, best.matrix) > 0.45)) return none;
  const estimate = { matrix: best.matrix, supportCorners: best.corners.length, supportWalls: best.walls, checkM: best.check.error };
  const verified = hypotheses.filter(h => h.check.error <= checkLimit);
  if (!verified.length || verified.some(h => perimeterDrift(model, h.matrix, verified[0]!.matrix) > checkLimit))
    return { estimate, verified: null };
  const fit = verified[0]!, point = fit.check.model.feature.point;
  return { estimate, verified: {
    fit: { matrix: fit.matrix, yaw: Math.atan2(fit.matrix.elements[8]!, fit.matrix.elements[0]!),
      modelOrigin: point, anchorPosition: new Vector3(...point).applyMatrix4(fit.matrix).toArray() },
    check: fit.check.model.feature, errorM: Math.max(fit.check.error, fit.trainingError), landmarkCount: 0,
    landmarkConflict: false, evidenceKind: "architecture",
    wallRegistration: { supportCorners: fit.corners.length, supportWalls: fit.walls },
  } };
}
