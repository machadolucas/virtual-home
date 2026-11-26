import { pointInFootprint } from "../model/geometry2d";
import type { FitPose, FitSpec } from "../model/fitProposal";
import { Box3, Matrix4, Triangle, Vector3 } from "three";
import type { Room, Vec2, Vec3 } from "../model/types";
import type { PlacementEnvelope } from "../scene/furnishingPlacement";

const rad = Math.PI / 180;
function worldPoint(p: FitPose, x: number, z: number): Vec2 {
  const c = Math.cos(p.yaw * rad),
    s = Math.sin(p.yaw * rad);
  return [p.x + c * x + s * z, p.z - s * x + c * z];
}

function crosses(a: Vec2, b: Vec2, c: Vec2, d: Vec2) {
  const side = (u: Vec2, v: Vec2, w: Vec2) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  return side(a, b, c) * side(a, b, d) < -1e-12 && side(c, d, a) * side(c, d, b) < -1e-12;
}

export function insideRoom(box: PlacementEnvelope, room: Room) {
  const p = { x: box.position[0], z: box.position[2], yaw: box.rotationYDeg };
  const w = box.widthM / 2,
    d = box.depthM / 2;
  const corners = [
    [-w, -d],
    [w, -d],
    [w, d],
    [-w, d],
  ].map(([x, z]) => worldPoint(p, x!, z!));
  if (corners.some(([x, z]) => !pointInFootprint(x, z, room.footprint))) return false;
  for (const ring of [room.footprint.outer, ...(room.footprint.holes ?? [])]) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      if (corners.some((c, j) => crosses(a, b, c, corners[(j + 1) % 4]!))) return false;
      if (
        pointInFootprint(a[0], a[1], { outer: corners }) &&
        Math.abs((a[0] - p.x) * Math.cos(p.yaw * rad) - (a[1] - p.z) * Math.sin(p.yaw * rad)) < w - 1e-6 &&
        Math.abs((a[0] - p.x) * Math.sin(p.yaw * rad) + (a[1] - p.z) * Math.cos(p.yaw * rad)) < d - 1e-6
      )
        return false;
    }
  }
  return true;
}

export function fitBody(p: FitPose, s: FitSpec, y: number): PlacementEnvelope {
  return {
    id: "proposal",
    position: [p.x, y, p.z],
    rotationYDeg: p.yaw,
    widthM: s.width,
    depthM: s.depth,
    heightM: s.height,
  };
}

export function fitOpening(p: FitPose, s: FitSpec, y: number, fraction: number): PlacementEnvelope {
  const drawer = s.opening === "Drawer";
  const side = s.opening === "Right hinge" ? -1 : 1;
  const angle = (Math.PI / 2) * fraction;
  const depth = drawer ? Math.max(0.0001, s.reach * fraction) : 0.036;
  const x = drawer ? 0 : (side * s.reach * (Math.cos(angle) - 1)) / 2;
  const z = s.depth / 2 + (drawer ? depth : Math.sin(angle) * s.reach) / 2 + 0.019;
  const [wx, wz] = worldPoint(p, x, z);
  return {
    id: "opening",
    position: [wx, y + s.height * (drawer ? 0.55 : 0.17), wz],
    rotationYDeg: p.yaw - (drawer ? 0 : side * fraction * 90),
    widthM: drawer ? s.width * 0.94 : s.reach,
    depthM: depth,
    heightM: s.height * (drawer ? 0.28 : 0.68),
  };
}

export function fitClearance(p: FitPose, s: FitSpec, y: number, depth: number): PlacementEnvelope {
  const [x, z] = worldPoint(p, 0, s.depth / 2 + s.reach + 0.019 + depth / 2);
  return { ...fitBody(p, s, y), position: [x, y, z], depthM: depth };
}

export interface FitObject {
  id: string;
  name: string;
  kind: "furnishing" | "equipment";
  parts: readonly PlacementEnvelope[];
}

export interface FitWall {
  id: string;
  name: string;
  kind: "wall";
  bounds: Box3;
  vertices: readonly Vector3[];
}

export type FitObstacle =
  | FitObject
  | FitWall
  | { id: string; name: string; kind: "edge"; a: Vec2; b: Vec2 }
  | { id: string; name: string; kind: "ceiling"; elevation: number };

export interface FitContact {
  obstacle: FitObstacle;
  point: Vec3;
  part?: PlacementEnvelope;
}

export interface FitCheck {
  bodyClear: boolean;
  openingClear: boolean;
  openingLimit: number;
  bodyContact: FitContact | null;
  openingContact: FitContact | null;
  clearanceContact: FitContact | null;
  gap: number;
  beyond: boolean;
}

function envelopeMatrix(box: PlacementEnvelope) {
  return new Matrix4().makeRotationY(box.rotationYDeg * rad).setPosition(new Vector3(...box.position));
}

function clipPolygon(polygon: Vector3[], box: Box3, axes: readonly ("x" | "y" | "z")[]): Vector3[] {
  for (const axis of axes)
    for (const sign of [-1, 1]) {
      const edge = sign < 0 ? box.min[axis] : box.max[axis];
      const output: Vector3[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i]!,
          b = polygon[(i + 1) % polygon.length]!;
        const inside = sign * (a[axis] - edge) <= 0;
        if (inside) output.push(a);
        if (inside !== sign * (b[axis] - edge) <= 0) {
          output.push(a.clone().lerp(b, (edge - a[axis]) / (b[axis] - a[axis])));
        }
      }
      polygon = output;
    }
  return polygon;
}

/** Clip the actual recorded primitive in its own frame, rather than taking its outer AABB. */
function objectContact(
  subject: PlacementEnvelope,
  obstacle: FitObject,
  part: PlacementEnvelope,
): FitContact | null {
  const y = Math.max(subject.position[1], part.position[1]);
  const high = Math.min(subject.position[1] + subject.heightM, part.position[1] + part.heightM);
  const deltaX = subject.position[0] - part.position[0],
    deltaZ = subject.position[2] - part.position[2];
  if (
    high - y <= 1e-5 ||
    Math.hypot(deltaX, deltaZ) >
      (Math.hypot(subject.widthM, subject.depthM) + Math.hypot(part.widthM, part.depthM)) / 2
  )
    return null;
  const matrix = envelopeMatrix(part);
  const relative = matrix.clone().invert().multiply(envelopeMatrix(subject));
  const w = subject.widthM / 2,
    d = subject.depthM / 2;
  const width = part.widthM / 2,
    depth = part.depthM / 2;
  const box = new Box3(new Vector3(-width, 0, -depth), new Vector3(width, part.heightM, depth));
  const outline = [
    [-w, -d],
    [w, -d],
    [w, d],
    [-w, d],
  ].map(([x, z]) => new Vector3(x, 0, z).applyMatrix4(relative).setY((y + high) / 2 - part.position[1]));
  const clipped = clipPolygon(outline, box, ["x", "z"]);
  const signedArea = clipped.reduce((sum, a, i) => {
    const b = clipped[(i + 1) % clipped.length]!;
    return sum + a.x * b.z - b.x * a.z;
  }, 0);
  if (Math.abs(signedArea) < 1e-8) return null;
  const point =
    clipped.find((p) => Math.abs(Math.abs(p.x) - width) < 1e-6 || Math.abs(Math.abs(p.z) - depth) < 1e-6) ??
    clipped[0]!;
  if (clipped.every((p) => Math.abs(p.x) < width - 1e-6 && Math.abs(p.z) < depth - 1e-6)) {
    point.y = y === part.position[1] ? 0 : part.heightM;
  }
  return { obstacle, point: point.applyMatrix4(matrix).toArray(), part };
}

/** Clip the actual wall triangle to the oriented volume before choosing its contact point. */
function wallContact(subject: PlacementEnvelope, walls: readonly FitWall[]): FitContact | null {
  if (!walls.length) return null;
  const matrix = envelopeMatrix(subject);
  const inverse = matrix.clone().invert();
  const inset = 0.001;
  const box = new Box3(
    new Vector3(-subject.widthM / 2 + inset, inset, -subject.depthM / 2 + inset),
    new Vector3(subject.widthM / 2 - inset, subject.heightM - inset, subject.depthM / 2 - inset),
  );
  if (box.isEmpty()) return null;
  const bounds = box.clone().applyMatrix4(matrix);
  const triangle = new Triangle();
  for (const wall of walls) {
    if (!bounds.intersectsBox(wall.bounds)) continue;
    for (let i = 0; i + 2 < wall.vertices.length; i += 3) {
      triangle.a.copy(wall.vertices[i]!).applyMatrix4(inverse);
      triangle.b.copy(wall.vertices[i + 1]!).applyMatrix4(inverse);
      triangle.c.copy(wall.vertices[i + 2]!).applyMatrix4(inverse);
      if (!box.intersectsTriangle(triangle)) continue;
      const intersection = clipPolygon([triangle.a, triangle.b, triangle.c], box, ["x", "y", "z"]);
      if (intersection.length) {
        const point = intersection
          .reduce((sum, p) => sum.add(p), new Vector3())
          .divideScalar(intersection.length)
          .applyMatrix4(matrix)
          .toArray();
        return { obstacle: wall, point };
      }
    }
  }
  return null;
}

function boundaryContact(box: PlacementEnvelope, room: Room): FitContact {
  const matrix = envelopeMatrix(box);
  const inverse = matrix.clone().invert();
  const width = box.widthM / 2,
    depth = box.depthM / 2;
  const envelope = new Box3(new Vector3(-width, 0, -depth), new Vector3(width, box.heightM, depth));
  let best: FitContact | null = null,
    distance = Infinity;
  [room.footprint.outer, ...(room.footprint.holes ?? [])].forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const first = new Vector3(a[0], box.position[1], a[1]).applyMatrix4(inverse);
      const last = new Vector3(b[0], box.position[1], b[1]).applyMatrix4(inverse);
      const delta = last.clone().sub(first);
      if (delta.lengthSq() < 1e-12) continue;
      const inside = clipPolygon([first, last], envelope, ["x", "z"]);
      const point = inside.length
        ? inside.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(inside.length)
        : first
            .clone()
            .addScaledVector(delta, Math.max(0, Math.min(1, -first.dot(delta) / delta.lengthSq())));
      const gap = Math.hypot(
        Math.max(0, Math.abs(point.x) - width),
        Math.max(0, Math.abs(point.z) - depth),
      );
      const score = gap * 100 + point.length();
      if (score >= distance) continue;
      distance = score;
      best = {
        obstacle: {
          id: `edge-${r}-${i}`,
          name: r ? "Floor opening edge" : "Room boundary",
          kind: "edge",
          a,
          b,
        },
        point: point
          .applyMatrix4(matrix)
          .setY(r ? room.floorElevation : box.position[1] + box.heightM / 2)
          .toArray(),
      };
    }
  });
  return best!;
}

export function assessFit(
  p: FitPose,
  s: FitSpec,
  room: Room,
  obstacles: readonly (PlacementEnvelope | FitObject)[],
  walls: readonly FitWall[] = [],
): FitCheck {
  const y = room.floorElevation;
  const contact = (box: PlacementEnvelope): FitContact | null => {
    const wall = wallContact(box, walls);
    if (wall) return wall;
    if (!insideRoom(box, room)) return boundaryContact(box, room);
    for (const item of obstacles) {
      const object: FitObject =
        "parts" in item ? item : { id: item.id, name: item.id, kind: "furnishing", parts: [item] };
      for (const part of object.parts) {
        const hit = objectContact(box, object, part);
        if (hit) return hit;
      }
    }
    return null;
  };
  const ceiling = room.ceilingHeight == null ? null : y + room.ceilingHeight;
  const bodyContact: FitContact | null =
    ceiling !== null && y + s.height > ceiling
      ? {
          obstacle: { id: "ceiling", kind: "ceiling", name: "Room ceiling", elevation: ceiling },
          point: [p.x, ceiling, p.z],
        }
      : contact(fitBody(p, s, y));
  const bodyClear = !bodyContact;
  const openingAt = (fraction: number) => contact(fitOpening(p, s, y, fraction));
  let openingContact = openingAt(0);
  let openingLimit = openingContact ? 0 : 1;
  if (!openingContact) {
    // A drawer's occupied front grows monotonically. Search hinge intervals in order, with a
    // tip-motion bound so an obstacle met and passed between two endpoints is still found.
    const locate = (
      lo: number,
      hi: number,
      end: FitContact | null,
    ): { safe: number; hit: FitContact } | null => {
      if ((hi - lo) * (s.opening === "Drawer" ? s.reach : (s.reach * Math.PI) / 2) <= 0.001) {
        return end ? { safe: lo, hit: end } : null;
      }
      const mid = (lo + hi) / 2;
      const middle = openingAt(mid);
      if (s.opening === "Drawer") {
        if (middle) return locate(lo, mid, middle);
        return end ? locate(mid, hi, end) : null;
      }
      const expanded = fitOpening(p, s, y, mid);
      const tipTravel = ((s.reach + 0.02) * (hi - lo) * Math.PI) / 4;
      expanded.widthM += tipTravel * 2;
      expanded.depthM += tipTravel * 2;
      if (!middle && !end && !contact(expanded)) return null;
      return locate(lo, mid, middle) ?? locate(mid, hi, end);
    };
    const first = locate(0, 1, openingAt(1));
    if (first) ({ safe: openingLimit, hit: openingContact } = first);
  }
  const openingClear = !openingContact;
  const clearance = (depth: number) => contact(fitClearance(p, s, y, depth));
  let gap = 0,
    hi = 5,
    clearanceContact: FitContact | null = null;
  let beyond = false;
  if (bodyClear && openingClear) {
    clearanceContact = clearance(hi);
    beyond = !clearanceContact;
    if (beyond) gap = hi;
    else
      for (let i = 0; i < 13; i++) {
        const mid = (gap + hi) / 2;
        const hit = clearance(mid);
        if (hit) {
          hi = mid;
          clearanceContact = hit;
        } else gap = mid;
      }
  }
  return {
    bodyClear,
    openingClear,
    openingLimit,
    bodyContact,
    openingContact,
    clearanceContact,
    gap,
    beyond,
  };
}
