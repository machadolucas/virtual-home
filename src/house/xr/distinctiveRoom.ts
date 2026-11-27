import type { Vector3 } from "three";
import { ringSignedArea } from "../model/geometry2d";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { checkAnchoredCorner, roomPoseDrift, type AlignmentCandidate, type AlignmentModel, type RoomEvidence } from "./roomAlignment";
import { floorOutlinePoses } from "./roomOutline";

/** The floor alone sets position and heading. Two tracked wall faces supply a separate 3D check. */
export function checkedFloorOutline(model: AlignmentModel, evidence: RoomEvidence, viewer: Vector3, corners = model.corners) {
  if (evidence.floor?.source !== "plane" || !evidence.floor.semanticFloor || model.room.footprint.holes?.length ||
      evidence.walls.filter(wall => !wall.baseOnly).length < 2) return null;
  const poses = floorOutlinePoses(model.room, evidence, viewer, MAX_CALIBRATION_ERROR_M);
  if (poses.length !== 1) return null;
  if (corners === model.corners) return checkAnchoredCorner(model, evidence, viewer, poses[0]!);
  for (const corner of corners) {
    const checked = checkAnchoredCorner(model, evidence, viewer, poses[0]!, corner.id);
    if (checked) return checked;
  }
  return null;
}

/** A complete asymmetric floor can locate the room while wall capture is still sparse. */
export function confirmsRecessedFloor(
  model: AlignmentModel, evidence: RoomEvidence, viewer: Vector3, candidate: AlignmentCandidate,
): boolean {
  if (evidence.floor?.source !== "plane" || !evidence.floor.semanticFloor || model.room.footprint.holes?.length) return false;
  const corners = model.corners;
  const winding = Math.sign(ringSignedArea(model.room.footprint.outer));
  const recesses = corners.filter(({ point: [x, , z] }, i) => {
    const [ax, , az] = corners[(i + corners.length - 1) % corners.length]!.point;
    const [bx, , bz] = corners[(i + 1) % corners.length]!.point;
    const cross = (x - ax) * (bz - z) - (z - az) * (bx - x);
    // A substantial inward corner distinguishes the room from a clipped rectangular patch.
    return Math.min(Math.hypot(x - ax, z - az), Math.hypot(bx - x, bz - z)) >= 0.35 &&
      cross * winding < -0.25 * Math.hypot(bx - ax, bz - az);
  });
  if (!recesses.length) return false;
  const checked = checkedFloorOutline(model, evidence, viewer, recesses);
  if (!checked) return false;
  const drift = roomPoseDrift(model.room, checked.fit.matrix, candidate.fit.matrix);
  return drift + Math.max(checked.errorM, candidate.errorM) <= MAX_CALIBRATION_ERROR_M;
}
