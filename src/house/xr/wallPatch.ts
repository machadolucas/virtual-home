import { Matrix4, Ray, Vector3 } from "three";
import { pointInFootprint, polylineLength } from "@/house/model/geometry2d";
import type { Room, Route, Vec3 } from "@/house/model/types";
import type { RenderRoute } from "@/house/scene/routes";
import type { AlignmentWall } from "./roomAlignment";

const HALF_WIDTH = 0.45;
const HALF_HEIGHT = 0.425;
const DEPTH_M = 0.8;
const EPSILON = 1e-6;

export interface WallPatch {
  hit: Vec3;
  origin: Vec3;
  along: Vec3;
  behind: Vec3;
  widthM: number;
  heightM: number;
  depthM: number;
}

export interface WallCrossing {
  upper: Route;
  lower: Route;
  upperPoint: Vec3;
  lowerPoint: Vec3;
  separationM: number;
}

/** The calibration maps the selected room's modeled wall surfaces into the real scene. */
export function pickWallPatch(room: Room, walls: AlignmentWall[], ray: Ray, trackingFromModel: Matrix4): WallPatch | null {
  const local = ray.clone().applyMatrix4(trackingFromModel.clone().invert());
  if (!pointInFootprint(local.origin.x, local.origin.z, room.footprint)) return null;
  let best = Infinity;
  let patch: WallPatch | null = null;
  for (const wall of walls) {
    const length = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    if (length <= EPSILON) continue;
    const along = new Vector3((wall.b[0] - wall.a[0]) / length, 0, (wall.b[1] - wall.a[1]) / length);
    const behind = new Vector3(-along.z, 0, along.x);
    const centreX = (wall.a[0] + wall.b[0]) / 2, centreZ = (wall.a[1] + wall.b[1]) / 2;
    const side = (sign: number) => pointInFootprint(
      centreX + 0.035 * behind.x * sign, centreZ + 0.035 * behind.z * sign, room.footprint,
    );
    if (side(1) === side(-1)) continue;
    if (side(1)) behind.negate();
    const incidence = local.direction.dot(behind);
    if (incidence <= 0.08) continue;
    const start = new Vector3(wall.a[0], wall.low, wall.a[1]);
    const distance = start.clone().sub(local.origin).dot(behind) / incidence;
    if (distance < 0.035 || distance > 8 || distance >= best) continue;
    const point = local.at(distance, new Vector3());
    const station = point.clone().sub(start).dot(along);
    if (station < 0 || station > length || point.y < wall.low || point.y > wall.high) continue;
    const u = Math.max(0, station - HALF_WIDTH), v = Math.max(wall.low, point.y - HALF_HEIGHT);
    patch = {
      hit: point.toArray(),
      origin: [start.x + along.x * u, v, start.z + along.z * u],
      along: along.toArray(), behind: behind.toArray(),
      widthM: Math.min(length, station + HALF_WIDTH) - u,
      heightM: Math.min(wall.high, point.y + HALF_HEIGHT) - v,
      depthM: DEPTH_M,
    };
    best = distance;
  }
  return patch;
}

function localPoint(p: Vec3, patch: WallPatch): Vec3 {
  const x = p[0] - patch.origin[0], y = p[1] - patch.origin[1], z = p[2] - patch.origin[2];
  return [x * patch.along[0] + z * patch.along[2], y, x * patch.behind[0] + z * patch.behind[2]];
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function clipSegment(a: Vec3, b: Vec3, patch: WallPatch) {
  const p = localPoint(a, patch), q = localPoint(b, patch);
  let entry = 0, exit = 1;
  const max = [patch.widthM, patch.heightM, patch.depthM];
  for (const axis of [0, 1, 2] as const) {
    const delta = q[axis] - p[axis];
    if (Math.abs(delta) < EPSILON) {
      if (p[axis] < -EPSILON || p[axis] > max[axis]! + EPSILON) return null;
      continue;
    }
    const lo = -p[axis] / delta, hi = (max[axis]! - p[axis]) / delta;
    entry = Math.max(entry, Math.min(lo, hi));
    exit = Math.min(exit, Math.max(lo, hi));
    if (exit - entry <= EPSILON) return null;
  }
  return [lerp(a, b, entry), lerp(a, b, exit)] as const;
}

/** Retain only the actual centre-line sections in the 3D wall volume. */
export function clipWallRoutes(routes: readonly RenderRoute[], patch: WallPatch): RenderRoute[] {
  const clipped: RenderRoute[] = [];
  const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const route of routes) {
    const total = route.arcLengthM ?? polylineLength(route.points);
    let station = route.arcStartM ?? 0, run: RenderRoute | null = null;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1]!, b = route.points[i]!, start = station;
      station += distance(a, b);
      const span = clipSegment(a, b, patch);
      const group = route.segments[i - 1];
      if (!span || !group) { run = null; continue; }
      if (run && distance(span[0], a) < EPSILON && distance(run.points.at(-1)!, a) < EPSILON) {
        run.points.push(span[1]); run.segments.push(group);
      } else {
        const entire = route.points.length === 2 && distance(a, span[0]) < EPSILON && distance(b, span[1]) < EPSILON;
        run = { ...route, points: [...span], segments: [group], pointPlaces: undefined, pointKinds: undefined,
          endpoints: [], ductFitting: entire ? route.ductFitting : undefined,
          arcStartM: start + distance(a, span[0]), arcLengthM: total };
        clipped.push(run);
      }
    }
  }
  return clipped;
}

type Segment = { route: Route; a: Vec3; b: Vec3 };
function crossing(a: Segment, b: Segment): WallCrossing | null {
  if (a.route.id === b.route.id) return null;
  const ux = a.b[0] - a.a[0], uz = a.b[2] - a.a[2];
  const vx = b.b[0] - b.a[0], vz = b.b[2] - b.a[2];
  const determinant = ux * vz - uz * vx;
  if (Math.abs(determinant) <= EPSILON * Math.max(1, Math.hypot(ux, uz) * Math.hypot(vx, vz))) return null;
  const dx = b.a[0] - a.a[0], dz = b.a[2] - a.a[2];
  const t = (dx * vz - dz * vx) / determinant, u = (dx * uz - dz * ux) / determinant;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  const p = lerp(a.a, a.b, t), q = lerp(b.a, b.b, u);
  // Solve in X/Z, then independently interpolate the two model heights at that same plan location.
  const [upper, lower, upperPoint, lowerPoint] = p[1] >= q[1] ? [a.route, b.route, p, q] : [b.route, a.route, q, p];
  return { upper, lower, upperPoint, lowerPoint, separationM: upperPoint[1] - lowerPoint[1] };
}

export function wallCrossings(routes: readonly Route[]): WallCrossing[] {
  const segments = routes.flatMap((route) => route.points.slice(1).map((b, i) => ({ route, a: route.points[i]!, b })));
  const results: WallCrossing[] = [];
  for (const [i, first] of segments.entries()) for (let j = i + 1; j < segments.length; j++) {
    const pass = crossing(first, segments[j]!);
    if (!pass) continue;
    if (results.some((other) => other.upper.id === pass.upper.id && other.lower.id === pass.lower.id &&
      Math.hypot(...other.upperPoint.map((p, axis) => p - pass.upperPoint[axis]!)) < 0.015 &&
      Math.abs(other.lowerPoint[1] - pass.lowerPoint[1]) < 0.015)) continue;
    results.push(pass);
  }
  return results;
}
