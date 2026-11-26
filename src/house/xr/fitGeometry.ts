import { pointInFootprint } from "../model/geometry2d";
import type { FitPose, FitSpec } from "../model/fitProposal";
import type { Room, Vec2 } from "../model/types";
import { placementEnvelopeCollision, type PlacementEnvelope } from "../scene/furnishingPlacement";

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
  const depth = drawer ? Math.max(0.01, s.reach * fraction) : 0.036;
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

export interface FitCheck {
  bodyClear: boolean;
  openingClear: boolean;
  gap: number;
  beyond: boolean;
}
export function assessFit(
  p: FitPose,
  s: FitSpec,
  room: Room,
  obstacles: readonly PlacementEnvelope[],
  wallHit?: (box: PlacementEnvelope) => boolean,
): FitCheck {
  const y = room.floorElevation;
  const blocked = (box: PlacementEnvelope) =>
    !insideRoom(box, room) || obstacles.some((o) => placementEnvelopeCollision(box, o)) || !!wallHit?.(box);
  const bodyClear =
    (room.ceilingHeight == null || s.height <= room.ceilingHeight) && !blocked(fitBody(p, s, y));
  // Sample the hinged leaf every 2 degrees; pad its thickness by the maximum intervening tip travel.
  let openingClear = true;
  for (let i = 0; i <= 45; i += s.opening === "Drawer" ? 45 : 1) {
    const leaf = fitOpening(p, s, y, i / 45);
    if (s.opening !== "Drawer") leaf.depthM += s.reach * Math.sin(rad * 2);
    if (blocked(leaf)) {
      openingClear = false;
      break;
    }
  }
  // A growing full-width clearance volume measures space beyond the open front. This monotonic
  // test catches thin obstacles between endpoints and avoids a scene ray through the middle only.
  const start = s.depth / 2 + s.reach + 0.019;
  const free = (depth: number) => {
    const [x, z] = worldPoint(p, 0, start + depth / 2);
    return !blocked({ ...fitBody(p, s, y), position: [x, y, z], depthM: depth });
  };
  let lo = 0,
    hi = 5;
  const beyond = bodyClear && openingClear && free(hi);
  if (beyond) lo = hi;
  else if (bodyClear && openingClear)
    for (let i = 0; i < 11; i++) {
      const mid = (lo + hi) / 2;
      if (free(mid)) lo = mid;
      else hi = mid;
    }
  return { bodyClear, openingClear, gap: lo, beyond };
}
