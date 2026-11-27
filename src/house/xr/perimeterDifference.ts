import { Matrix4 } from "three";
import { ringBBox, ringSignedArea } from "../model/geometry2d";
import type { Room, Vec2 } from "../model/types";
import { floorEdges, type Edge } from "./floorBoundary";
import type { AlignmentModel, AlignmentWall, RoomEvidence } from "./roomAlignment";

const tolerance = 0.05 + 1e-8;
const span = ([a, b]: Edge) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const bearing = ([a, b]: Edge) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const along = ([a, b]: Edge, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const mapPoint = ([x, z]: Vec2, m: Matrix4): Vec2 => [
  m.elements[0]! * x + m.elements[8]! * z + m.elements[12]!,
  m.elements[2]! * x + m.elements[10]! * z + m.elements[14]!,
];

function distance(p: Vec2, [a, b]: Edge) {
  const x = b[0] - a[0], z = b[1] - a[1], ux = p[0] - a[0], uz = p[1] - a[1];
  const t = Math.max(0, Math.min(1, (ux * x + uz * z) / (x * x + z * z)));
  return Math.hypot(ux - t * x, uz - t * z);
}

function edgeDeviation(edge: Edge, others: Edge[]) {
  const count = Math.min(48, Math.max(2, Math.ceil(span(edge) / 0.15)));
  let max = 0;
  for (let n = 0; n <= count; n++) {
    const p = along(edge, n / count);
    let best = Infinity;
    for (const other of others) best = Math.min(best, distance(p, other));
    max = Math.max(max, best);
  }
  return max;
}

function oneRun(changed: boolean[]) {
  return changed.filter((v, i) => v && !changed[(i + changed.length - 1) % changed.length]).length === 1;
}

function fromWall(wall: AlignmentWall): Edge { return [wall.a, wall.b]; }

function parallelSupport(edge: Edge, observed: readonly AlignmentWall[]) {
  return observed.some(face => {
    const other = fromWall(face);
    if (Math.abs(Math.cos(bearing(other) - bearing(edge))) < Math.cos(Math.PI / 30)) return false;
    // Compare a span, since two oblique walls can meet at a single point.
    return [0.25, 0.5, 0.75].every(t => distance(along(other, t), edge) <= tolerance) ||
      [0.25, 0.5, 0.75].every(t => distance(along(edge, t), other) <= tolerance);
  });
}

function floorRings(room: Room, floor: RoomEvidence["floor"], matrix: Matrix4) {
  if (floor?.source !== "plane" || floor.outline.length < 3 || floor.outline.length > 128 ||
      room.footprint.outer.length < 3 || room.footprint.outer.length > 128) return null;
  const mapped = room.footprint.outer.map(point => mapPoint(point, matrix));
  const edges = floorEdges(mapped), observed = floorEdges(floor.outline);
  if (edges.length < 3 || observed.length < 3) return null;
  return { edges, observed };
}

/** A complete, otherwise matching outline can replace a short run of angled perimeter with
 * one or more square segments. This only identifies the discrepant region of a supplied pose. */
export function localizedPerimeterDifference(room: Room, floor: RoomEvidence["floor"], matrix: Matrix4) {
  if (!floor?.semanticFloor || room.footprint.holes?.length) return null;
  const rings = floorRings(room, floor, matrix);
  if (!rings || rings.edges.length > 48 || rings.observed.length > 48) return null;
  const { edges, observed } = rings;
  const area = Math.abs(ringSignedArea(room.footprint.outer));
  if (area < 1 || Math.abs(Math.abs(ringSignedArea(floor.outline)) - area) > area * 0.15) return null;
  const changed = edges.map(edge => edgeDeviation(edge, observed) > tolerance);
  const otherChanged = observed.map(edge => edgeDeviation(edge, edges) > tolerance);
  if (!oneRun(changed) || !oneRun(otherChanged)) return null;
  if (edges.filter((e, i) => !changed[i] && span(e) >= 0.5).length < 3) return null;
  const differentModel = edges.filter((_, i) => changed[i]);
  const differentObserved = observed.filter((_, i) => otherChanged[i]);
  // Long unchanged portions of a continuous scan face may abut a niche. Bound the actual
  // disagreements, avoiding the arbitrary endpoints of long coplanar faces.
  const affected: Vec2[] = [];
  const measure = (from: Edge[], others: Edge[]) => {
    let mismatch = 0;
    for (const edge of from) {
      const count = Math.min(48, Math.max(2, Math.ceil(span(edge) / 0.12)));
      for (let i = 0; i < count; i++) {
        const p = along(edge, (i + 0.5) / count);
        if (others.some(other => distance(p, other) <= tolerance)) continue;
        affected.push(p);
        mismatch += span(edge) / count;
      }
    }
    return mismatch;
  };
  const perimeter = edges.reduce((sum, e) => sum + span(e), 0);
  const changedLength = Math.max(measure(differentModel, observed), measure(differentObserved, edges));
  if (!affected.length || changedLength > Math.min(4, perimeter * 0.25)) return null;
  const box = ringBBox(affected);
  if (Math.hypot(box.maxX - box.minX, box.maxZ - box.minZ) > 3.2) return null;
  // At least one displaced modeled face actually changes direction relative to the measured map.
  const angled = differentModel.some(edge => span(edge) >= 0.3 && differentObserved.some(other => {
    const similarity = Math.abs(Math.cos(bearing(edge) - bearing(other)));
    return distance(along(edge, 0.5), other) <= 1.25 &&
      similarity < Math.cos(Math.PI / 12) && similarity > Math.cos(5 * Math.PI / 12);
  }));
  if (!angled) return null;
  const nearEdit = (p: Vec2) => p[0] >= box.minX - 0.18 && p[0] <= box.maxX + 0.18 &&
    p[1] >= box.minZ - 0.18 && p[1] <= box.maxZ + 0.18;
  return {
    nearEdit,
    explains(face: AlignmentWall) {
      const edge = fromWall(face);
      const count = Math.max(2, Math.min(64, Math.ceil(span(edge) / 0.12)));
      let insideEdit = false;
      for (let i = 0; i <= count; i++) {
        const point = along(edge, i / count);
        if (edges.some(other => distance(point, other) <= tolerance)) continue;
        if (!nearEdit(point) || !differentObserved.some(other => distance(point, other) <= tolerance)) return false;
        insideEdit = true;
      }
      return insideEdit;
    },
  };
}

export function compareMeasuredOutline(
  model: AlignmentModel, evidence: RoomEvidence, pose: Matrix4, strokes: readonly AlignmentWall[],
) {
  const rings = floorRings(model.room, evidence.floor, pose);
  if (!rings) return null;
  const { edges, observed } = rings;
  const measured = evidence.walls.filter(w => !w.baseOnly);
  const details = model.walls.map((wall, wallIndex) => {
    const edge: Edge = [mapPoint(wall.a, pose), mapPoint(wall.b, pose)];
    const mid = along(edge, 0.5);
    const nearest = observed.reduce((best, other) => distance(mid, other) < distance(mid, best) ? other : best);
    return {
      wallIndex, outlineGapM: edgeDeviation(edge, observed),
      nearestAngleDeg: Math.acos(Math.min(1, Math.abs(Math.cos(bearing(edge) - bearing(nearest))))) * 180 / Math.PI,
      measuredSupport: parallelSupport(edge, measured),
      traceSupport: parallelSupport(edge, strokes),
    };
  });
  const maxDeviationM = Math.max(...observed.map(e => edgeDeviation(e, edges)), ...edges.map(e => edgeDeviation(e, observed)));
  const walls = details.filter(w => w.outlineGapM > tolerance).sort((a, b) => b.outlineGapM - a.outlineGapM).slice(0, 12);
  return { maxDeviationM, walls };
}

/** Diagnostic hypotheses only. A long model wall and a coincident scan wall endpoint propose
 * each rigid pose. A contiguous, bounded discrepancy and matching remaining geometry are required. */
export function likelyOutlinePoses(model: AlignmentModel, evidence: RoomEvidence): Matrix4[] {
  const floor = evidence.floor;
  if (!floor?.semanticFloor || floor.source !== "plane" || floor.outline.length > 48 || model.room.footprint.outer.length > 48) return [];
  const edges = floorEdges(model.room.footprint.outer).sort((a, b) => span(b) - span(a));
  const observations = floorEdges(floor.outline).sort((a, b) => span(b) - span(a));
  const longest = edges.find(edge => span(edge) >= 1);
  if (!longest || observations.length < 3) return [];
  const area = Math.abs(ringSignedArea(model.room.footprint.outer));
  if (area < 1 || Math.abs(Math.abs(ringSignedArea(floor.outline)) - area) > area * 0.15) return [];
  const results: Matrix4[] = [];
  for (const edge of observations.slice(0, 12)) {
    if (span(edge) < span(longest) * 0.55) break;
    for (const flip of [false, true]) for (const endpoint of [0, 1] as const) {
      const at = edge[flip ? 1 - endpoint : endpoint]!;
      const yaw = bearing(longest) - bearing(edge) + (flip ? Math.PI : 0);
      const pose = new Matrix4().makeRotationY(yaw);
      const from = mapPoint(longest[endpoint], pose);
      pose.setPosition(at[0] - from[0], floor.y - model.room.floorElevation, at[1] - from[1]);
      if (results.some(other => model.room.footprint.outer.every(p => {
        const a = mapPoint(p, pose), b = mapPoint(p, other);
        return Math.hypot(a[0] - b[0], a[1] - b[1]) < tolerance;
      }))) continue;
      // A rough hypothesis only advances to detailed comparison if most corners already lie near the scan.
      const near = model.room.footprint.outer.filter(p => observations.some(e => distance(mapPoint(p, pose), e) <= tolerance));
      if (near.length < model.room.footprint.outer.length * 0.55) continue;
      if (localizedPerimeterDifference(model.room, floor, pose)) results.push(pose);
      if (results.length > 6) return results;
    }
  }
  return results;
}
