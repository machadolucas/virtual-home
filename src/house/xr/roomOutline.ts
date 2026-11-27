import { Matrix4, Vector3 } from "three";
import { pointInFootprint, pointInRing, ringCentroid, ringSignedArea } from "../model/geometry2d";
import type { Room, Vec2 } from "../model/types";
import { floorEdges, outlinesAgree, type Edge } from "./floorBoundary";
export { floorEdges, outlinesAgree, type Edge } from "./floorBoundary";
import { roomPoseDrift, trackedFloorHeightAllowed, type RoomEvidence } from "./roomAlignment";

const span = ([a,b]: Edge) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const angle = ([a,b]: Edge) => Math.atan2(b[1] - a[1], b[0] - a[0]);

/** Unit-scale hypotheses from the complete measured floor polygon. Symmetry remains explicit. */
export function floorOutlinePoses(room: Room, evidence: RoomEvidence, eye: Vector3, toleranceM = 0.22): Matrix4[] {
  const floor = evidence.floor, model = room.footprint.outer;
  if (!floor || floor.source !== "plane" || !trackedFloorHeightAllowed(floor.y, floor.semanticFloor) ||
    !Number.isFinite(toleranceM) || toleranceM <= 0 || toleranceM > 0.25 ||
    model.length < 3 || model.length > 128 || floor.outline.length < 3 || floor.outline.length > 128 ||
    !pointInRing(eye.x, eye.z, floor.outline) || eye.y - floor.y < 0.45 ||
    eye.y - floor.y > (room.ceilingHeight ?? 2.7) + 0.2) return [];
  const area = Math.abs(ringSignedArea(model)), captured = Math.abs(ringSignedArea(floor.outline));
  if (Math.min(area,captured) < 0.65 || Math.abs(area - captured) > 0.15 * Math.max(area,captured)) return [];
  const longest = floorEdges(model).sort((a,b) => span(b) - span(a))[0];
  if (!longest || span(longest) < 0.75) return [];
  const axes = floorEdges(floor.outline).filter(edge => span(edge) >= 0.5).sort((a,b) => span(b) - span(a));
  const center = ringCentroid(model), observed = ringCentroid(floor.outline);
  const candidates: Matrix4[] = [], tried: number[] = [];
  const local = new Vector3();
  const radius = Math.max(...model.map(([x,z]) => Math.hypot(x-center[0],z-center[1])));
  const duplicateAngle = Math.min(.01, toleranceM / Math.max(1,radius) / 4);
  for (const edge of axes) {
    const heading = angle(longest) - angle(edge);
    for (const yaw of [heading, heading + Math.PI]) {
      if (tried.some(old => Math.abs(Math.atan2(Math.sin(yaw-old),Math.cos(yaw-old))) < duplicateAngle)) continue;
      // A very fragmented contour has no reliable measured wall bearing.
      if (tried.length >= 48) return [];
      tried.push(yaw);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const x = observed[0] - c*center[0] - s*center[1], z = observed[1] + s*center[0] - c*center[1];
      const ring: Vec2[] = model.map(([a,b]) => [c*a+s*b+x, -s*a+c*b+z]);
      if (!outlinesAgree(ring, floor.outline, toleranceM)) continue;
      const pose = new Matrix4().makeRotationY(yaw).setPosition(x, floor.y-room.floorElevation, z);
      local.copy(eye).applyMatrix4(pose.clone().invert());
      if (!pointInFootprint(local.x,local.z,room.footprint)) continue;
      if (!candidates.some(previous => roomPoseDrift(room,previous,pose) <= toleranceM/2)) candidates.push(pose);
    }
  }
  return candidates;
}
