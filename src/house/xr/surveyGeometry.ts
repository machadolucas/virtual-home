import { Box3, Matrix4, Vector3 } from "three";
import { pointInFootprint } from "@/house/model/geometry2d";
import type { Room, Vec3 } from "@/house/model/types";
import {
  MAX_ROOM_SURVEY_BODY_BYTES, MAX_ROOM_SURVEY_INDICES, MAX_ROOM_SURVEY_POINTS, MAX_ROOM_SURVEY_SURFACES,
  roomSurveyBounds, surveyMeasurementLengthM,
  type RoomSurveyGeometry,
} from "../roomSurveyTypes";

type SurveySurface = RoomSurveyGeometry["surfaces"][number];
const MAX_SENSOR_SURFACES = 32;
const MAX_SENSOR_VERTICES = 2_400;
const MAX_TRIANGLES_PER_MESH = 3_000;
const MAX_TRIANGLES_TO_INSPECT = 9_000;
const AXES = ["x", "y", "z"] as const;
const point = new Vector3();

export function surveyBounds(room: Room): Box3 {
  const { min, max } = roomSurveyBounds(room);
  return new Box3(new Vector3(...min), new Vector3(...max));
}

const millimetres = (n: number): number => Math.round(n * 1000) / 1000;

export function localToSurveyPoint(local: Vector3, modelFromTracking: Matrix4, bounds: Box3): Vec3 | null {
  point.copy(local).applyMatrix4(modelFromTracking);
  if (![point.x, point.y, point.z].every(Number.isFinite) || !bounds.containsPoint(point)) return null;
  return point.toArray().map(millimetres) as Vec3;
}

export { surveyMeasurementLengthM as measurementLength };

export function surveyExtent(geometry: RoomSurveyGeometry, room: Room) {
  const bounds = new Box3();
  let adjoining = false;
  const sources = new Set<SurveySurface["source"] | "measurements">();
  const outside = (x: number, z: number) => !pointInFootprint(x, z, room.footprint);
  const add = (v: Vec3) => {
    bounds.expandByPoint(point.fromArray(v));
    if (!adjoining && outside(v[0], v[2])) adjoining = true;
  };
  const outsideEdge = (a: Vec3, b: Vec3) => outside((a[0] + b[0]) / 2, (a[2] + b[2]) / 2);
  for (const { points, source, indices } of geometry.surfaces) {
    sources.add(source);
    points.forEach(add);
    // A boundary or triangle can cross a concave room edge even if its vertices lie inside.
    if (!adjoining && source === "plane") adjoining = points.some((a, i) => outsideEdge(a, points[(i + 1) % points.length]!));
    if (!adjoining && indices) {
      for (let i = 0; i + 2 < indices.length && !adjoining; i += 3) {
        const a = points[indices[i]!]!, b = points[indices[i + 1]!]!, c = points[indices[i + 2]!]!;
        adjoining = outsideEdge(a, b) || outsideEdge(b, c) || outsideEdge(c, a) ||
          outside((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
      }
    }
  }
  for (const { a, b } of geometry.measurements) {
    sources.add("measurements");
    add(a);
    add(b);
    if (!adjoining && outsideEdge(a, b)) adjoining = true;
  }
  return { bounds, size: bounds.getSize(new Vector3()), adjoining, sources };
}

function clipPolygon(poly: Vector3[], bounds: Box3): Vector3[] {
  let result = poly;
  for (const axis of AXES) for (const side of ["min", "max"] as const) {
    if (!result.length) return result;
    const edge = bounds[side][axis];
    const inside = (v: Vector3) => side === "min" ? v[axis] >= edge : v[axis] <= edge;
    const input = result;
    result = [];
    let previous = input[input.length - 1]!;
    for (const current of input) {
      const wasIn = inside(previous);
      const nowIn = inside(current);
      if (wasIn !== nowIn) {
        const t = (edge - previous[axis]) / (current[axis] - previous[axis]);
        result.push(previous.clone().lerp(current, t));
      }
      if (nowIn) result.push(current);
      previous = current;
    }
  }
  return result;
}

const finite = (v: Vector3): boolean => [v.x, v.y, v.z].every(Number.isFinite);
const encodePoint = (v: Vector3): Vec3 => [millimetres(v.x), millimetres(v.y), millimetres(v.z)];

function poseInModel(frame: XRFrame, source: XRSpace, reference: XRReferenceSpace, inverse: Matrix4): Matrix4 | null {
  const pose = safelyRead(() => frame.getPose(source, reference));
  return pose && !pose.emulatedPosition ? new Matrix4().multiplyMatrices(inverse, new Matrix4().fromArray(pose.transform.matrix)) : null;
}

function safelyRead<T>(get: () => T | undefined): T | undefined {
  try { return get(); } catch { return undefined; }
}

type FullCapture =
  | { kind: "full"; surfaces: SurveySurface[] }
  | { kind: "unavailable" | "too-large" | "untracked" | "invalid" };

/** Full capture preserves every available plane and indexed triangle, with no model-volume clip. */
export function readFullRoomSurfaces(
  frame: XRFrame,
  reference: XRReferenceSpace,
  modelFromTracking: Matrix4,
): FullCapture {
  const meshes = safelyRead(() => frame.detectedMeshes);
  const planes = safelyRead(() => frame.detectedPlanes);
  const count = (meshes?.size ?? 0) + (planes?.size ?? 0);
  if (!count) return { kind: "unavailable" };
  if (count > MAX_ROOM_SURVEY_SURFACES) return { kind: "too-large" };
  const surfaces: SurveySurface[] = [];
  let pointCount = 0;
  let indexCount = 0;
  const coord = new Vector3();
  const totalTooLarge = () => pointCount > MAX_ROOM_SURVEY_POINTS || indexCount > MAX_ROOM_SURVEY_INDICES;
  const acceptable = (v: Vector3) => finite(v) && Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) <= 100_000;
  for (const mesh of meshes ?? []) {
    const { vertices, indices } = mesh;
    if (vertices.length < 9 || indices.length < 3 || vertices.length % 3 || indices.length % 3) return { kind: "invalid" };
    pointCount += vertices.length / 3;
    indexCount += indices.length;
    if (totalTooLarge()) return { kind: "too-large" };
    const transform = poseInModel(frame, mesh.meshSpace, reference, modelFromTracking);
    if (!transform) return { kind: "untracked" };
    const points: Vec3[] = [];
    for (let i = 0; i < vertices.length; i += 3) {
      coord.fromArray(vertices, i).applyMatrix4(transform);
      if (!acceptable(coord)) return { kind: "invalid" };
      points.push(coord.toArray());
    }
    if (indices.some((i) => i >= points.length)) return { kind: "invalid" };
    const label = mesh.semanticLabel?.trim().slice(0, 80);
    surfaces.push({ source: "mesh", ...(label ? { label } : {}), points, indices: Array.from(indices) });
  }
  for (const plane of planes ?? []) {
    if (plane.polygon.length < 3) return { kind: "invalid" };
    pointCount += plane.polygon.length;
    if (totalTooLarge()) return { kind: "too-large" };
    const transform = poseInModel(frame, plane.planeSpace, reference, modelFromTracking);
    if (!transform) return { kind: "untracked" };
    const points: Vec3[] = [];
    for (const p of plane.polygon) {
      coord.set(p.x, p.y, p.z).applyMatrix4(transform);
      if (!acceptable(coord)) return { kind: "invalid" };
      points.push(coord.toArray());
    }
    const label = plane.semanticLabel?.trim().slice(0, 80);
    surfaces.push({ source: "plane", ...(label ? { label } : {}), points,
      ...(plane.orientation ? { orientation: plane.orientation } : {}) });
  }
  return { kind: "full", surfaces };
}

/** Keep spare bytes for the request envelope. The final write also checks its exact size. */
export function fitsSurveyUpload(geometry: RoomSurveyGeometry): boolean {
  const { surfaces } = geometry;
  if (surfaces.length > MAX_ROOM_SURVEY_SURFACES ||
    surfaces.reduce((n, surface) => n + surface.points.length, 0) > MAX_ROOM_SURVEY_POINTS ||
    surfaces.reduce((n, surface) => n + (surface.indices?.length ?? 0), 0) > MAX_ROOM_SURVEY_INDICES) return false;
  return new TextEncoder().encode(JSON.stringify(geometry)).byteLength <= MAX_ROOM_SURVEY_BODY_BYTES - 2_048;
}

/** A bounded snapshot of the browser geometry intersecting the selected room's nearby volume. */
export function readRoomSurfaces(
  frame: XRFrame,
  reference: XRReferenceSpace,
  modelFromTracking: Matrix4,
  bounds: Box3,
): SurveySurface[] {
  const surfaces: SurveySurface[] = [];
  let available = MAX_SENSOR_VERTICES;
  let trianglesRemaining = MAX_TRIANGLES_TO_INSPECT;
  for (const plane of safelyRead(() => frame.detectedPlanes) ?? []) {
    if (available < 3 || surfaces.length >= MAX_SENSOR_SURFACES) break;
    const transform = poseInModel(frame, plane.planeSpace, reference, modelFromTracking);
    if (!transform || plane.polygon.length > 128) continue;
    const polygon = plane.polygon.map((p) => new Vector3(p.x, p.y, p.z).applyMatrix4(transform));
    if (polygon.length < 3 || !polygon.every(finite)) continue;
    const within = clipPolygon(polygon, bounds);
    if (within.length < 3 || within.length > Math.min(available, 144)) continue;
    const label = plane.semanticLabel?.trim().slice(0, 80);
    surfaces.push({
      source: "plane",
      ...(plane.orientation ? { orientation: plane.orientation } : {}),
      ...(label ? { label } : {}),
      points: within.map(encodePoint),
    });
    available -= within.length;
  }
  for (const mesh of safelyRead(() => frame.detectedMeshes) ?? []) {
    if (available < 3 || surfaces.length >= MAX_SENSOR_SURFACES || trianglesRemaining <= 0) break;
    const transform = poseInModel(frame, mesh.meshSpace, reference, modelFromTracking);
    if (!transform) continue;
    const { vertices, indices } = mesh;
    const points: Vec3[] = [];
    const clipped: number[] = [];
    const stride = Math.max(1, Math.ceil(indices.length / (3 * MAX_TRIANGLES_PER_MESH)));
    // Device scene meshes can be dense. Bound scan work and preserve a subset of source triangles.
    for (let i = 0; i + 2 < indices.length; i += 3 * stride) {
      if (available - points.length < 3 || trianglesRemaining <= 0) break;
      trianglesRemaining--;
      const triangle = [indices[i]!, indices[i + 1]!, indices[i + 2]!]
        .map((j) => new Vector3().fromArray(vertices, j * 3).applyMatrix4(transform));
      if (!triangle.every(finite)) continue;
      const within = clipPolygon(triangle, bounds);
      if (within.length < 3 || points.length + within.length > available) continue;
      const offset = points.length;
      points.push(...within.map(encodePoint));
      for (let j = 1; j + 1 < within.length; j++) clipped.push(offset, offset + j, offset + j + 1);
    }
    if (clipped.length === 0) continue;
    const label = mesh.semanticLabel?.trim().slice(0, 80);
    surfaces.push({
      source: "mesh",
      ...(label ? { label } : {}),
      points,
      indices: clipped,
    });
    available -= points.length;
  }
  return surfaces;
}

/** Yaw is the Three.js rotation of an object's forward (-Z) axis toward the heading point. */
export function surveyHeading(origin: Vec3, toward: Vec3): number | null {
  const dx = toward[0] - origin[0];
  const dz = toward[2] - origin[2];
  if (Math.hypot(dx, dz) < 0.15) return null;
  return Math.round(Math.atan2(-dx, -dz) * 180 / Math.PI * 10) / 10;
}
