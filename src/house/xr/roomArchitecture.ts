import { Matrix4, Vector3 } from "three";
import { pointInFootprint, ringBBox, signedClearance } from "../model/geometry2d";
import type { Vec2, Vec3 } from "../model/types";
import { MAX_CALIBRATION_ERROR_M, MIN_CALIBRATION_BASELINE_M, type CalibrationFeature } from "./mixedCalibration";
import type { AlignmentCandidate, AlignmentLandmark, AlignmentModel, AlignmentWall, RoomEvidence } from "./roomAlignment";
import { outlinesAgree } from "./floorBoundary";

const limit = MAX_CALIBRATION_ERROR_M + 1e-8;
const maxModelOpenings = 32;
const maxLocalOpenings = 40;
const closeAxis = Math.cos(3 * Math.PI / 180);

export function openingCalibrationFeature(model: AlignmentModel, index: number): CalibrationFeature {
  const mark = model.landmarks[index]!;
  return {
    id: model.room.id + ":opening:" + (mark.elementId ?? index), roomId: model.room.id,
    openingKind: mark.kind,
    label: (mark.kind === "door" ? "Door" : "Window") + " " + (index + 1) + " centre",
    point: mark.rawCenter ?? mark.center,
  };
}

function dimensionsAgree(a: AlignmentLandmark, b: AlignmentLandmark) {
  return a.kind === b.kind && a.width >= 0.3 && a.height >= 0.3 &&
    Math.abs(a.width - b.width) <= 0.22 && Math.abs(a.height - b.height) <= 0.22;
}

function measured(mark: AlignmentLandmark): mark is AlignmentLandmark & { rawCenter: Vec3; axis: Vec2 } {
  return !!mark.rawCenter?.every(Number.isFinite) && !!mark.axis && Math.abs(Math.hypot(...mark.axis) - 1) < 0.015;
}

function axisAgrees(a: Vec2, b: Vec2, matrix: Matrix4) {
  const c = matrix.elements[0]!, s = matrix.elements[8]!;
  return Math.abs((c * a[0] + s * a[1]) * b[0] + (-s * a[0] + c * a[1]) * b[1]) >= closeAxis;
}

function nearRoomBoundary(x: number, z: number, walls: AlignmentWall[]) {
  return walls.some(({ a, b }) => {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) <= 0.32;
  });
}

function checkedCandidate(
  matrix: Matrix4, check: CalibrationFeature, errorM: number, landmarkCount: number,
): AlignmentCandidate {
  return {
    fit: { matrix, yaw: Math.atan2(matrix.elements[8]!, matrix.elements[0]!), modelOrigin: check.point,
      anchorPosition: new Vector3(...check.point).applyMatrix4(matrix).toArray() },
    check, errorM, landmarkCount, landmarkConflict: false, evidenceKind: "architecture",
  };
}

/** A registered raw opening point measures all three coordinates independently of a fitted wall pair.
 * For an opening-based fit, a different, well-separated opening must supply that check. */
export function checkOpeningGeometry(
  model: AlignmentModel, evidence: RoomEvidence, matrix: Matrix4,
  training?: { modeled: AlignmentLandmark; observed: AlignmentLandmark }, awayFrom?: Vec2,
): AlignmentCandidate | null {
  if (!model.landmarks.length || model.landmarks.length > maxModelOpenings || !evidence.landmarks.length) return null;
  const local = new Vector3(), inverse = matrix.clone().invert();
  for (const face of evidence.walls) {
    if (!face.semanticWall || face.baseOnly) continue;
    // A substantial labeled wall cutting through this proposed room contradicts the pose.
    const x = (face.a[0] + face.b[0]) / 2, z = (face.a[1] + face.b[1]) / 2;
    local.set(x, (face.low + face.high) / 2, z).applyMatrix4(inverse);
    const floor = model.room.floorElevation;
    if (local.y > floor + 0.3 && local.y < floor + (model.room.ceilingHeight ?? 2.7) &&
        signedClearance(local.x, local.z, model.room.footprint) > limit &&
        Math.hypot(face.a[0] - face.b[0], face.a[1] - face.b[1]) >= 0.8) return null;
  }
  const used = new Set<AlignmentLandmark>();
  if (training) used.add(training.modeled);
  let count = training ? 1 : 0, errorM = 0, check: CalibrationFeature | null = null;
  let longest = -1;
  for (const seen of evidence.landmarks) {
    if (seen === training?.observed || !measured(seen)) continue;
    local.fromArray(seen.rawCenter).applyMatrix4(inverse);
    if (!nearRoomBoundary(local.x, local.z, model.walls)) continue;
    if (local.y < model.room.floorElevation - 0.1 ||
        local.y > model.room.floorElevation + (model.room.ceilingHeight ?? 2.7) + 0.1) continue;
    let nearest = -1, best = Infinity;
    for (const [i, mark] of model.landmarks.entries()) {
      if (!measured(mark) || used.has(mark) || !dimensionsAgree(mark, seen) || !axisAgrees(mark.axis, seen.axis, matrix)) continue;
      const gap = Math.hypot(local.x - mark.rawCenter[0], local.y - mark.rawCenter[1], local.z - mark.rawCenter[2]);
      if (gap < best) { best = gap; nearest = i; }
    }
    // All observed openings of the room must agree; a single fortunate match cannot mask a contradiction.
    if (nearest < 0 || best > limit) return null;
    const matched = model.landmarks[nearest]!;
    used.add(matched);
    count++;
    errorM = Math.max(errorM, best);
    const separation = training ? Math.hypot(seen.rawCenter[0] - training.observed.rawCenter![0],
      seen.rawCenter[2] - training.observed.rawCenter![2])
      : awayFrom ? Math.hypot(seen.rawCenter[0] - awayFrom[0], seen.rawCenter[2] - awayFrom[1]) : Infinity;
    if (separation >= MIN_CALIBRATION_BASELINE_M && separation > longest) {
      longest = separation;
      check = openingCalibrationFeature(model, nearest);
    }
  }
  if (!check) return null;
  const candidate = checkedCandidate(matrix, check, errorM, count);
  const matched = [...used];
  candidate.separatedOpenings = matched.some((a, i) => matched.slice(i + 1).some(b =>
    Math.hypot(a.rawCenter![0] - b.rawCenter![0], a.rawCenter![2] - b.rawCenter![2]) >= MIN_CALIBRATION_BASELINE_M));
  return candidate;
}

/** Two separated measured openings carry elevation as well as position. Only the first center
 * and its horizontal axis set the pose. The other center, measured independently, checks it. */
export function architectureFromOpenings(model: AlignmentModel, evidence: RoomEvidence, eye: Vector3): AlignmentCandidate[] {
  if (evidence.floor?.source === "bounds" || model.landmarks.length < 2 || evidence.landmarks.length < 2 ||
      model.landmarks.length > maxModelOpenings) return [];
  const bounds = ringBBox(model.room.footprint.outer);
  const reach = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) + 0.35;
  const seen = evidence.landmarks.filter(measured).filter(({ rawCenter: [x, y, z] }) =>
    Math.hypot(x - eye.x, z - eye.z) <= reach && y >= -0.60 && y <= (model.room.ceilingHeight ?? 2.7) + 0.6);
  if (seen.length > maxLocalOpenings) return [];
  const modeled = model.landmarks.filter(measured);
  if (seen.length < 2 || modeled.length < 2) return [];
  const candidates: AlignmentCandidate[] = [];
  const nearbyEvidence = { ...evidence, landmarks: seen };
  const local = new Vector3();
  for (const observation of seen) for (const mark of modeled) {
    if (!dimensionsAgree(mark, observation)) continue;
    const vertical = observation.rawCenter[1] - mark.rawCenter[1];
    const floorY = model.room.floorElevation + vertical;
    if (Math.abs(floorY) > 0.60 || eye.y - floorY < 0.45 || eye.y - floorY > (model.room.ceilingHeight ?? 2.7) + 0.2 ||
        (evidence.floor && Math.abs(floorY - evidence.floor.y) > limit)) continue;
    const heading = Math.atan2(mark.axis[1], mark.axis[0]) - Math.atan2(observation.axis[1], observation.axis[0]);
    for (const yaw of [heading, heading + Math.PI]) {
      const matrix = new Matrix4().makeRotationY(yaw);
      const offset = new Vector3(...observation.rawCenter).sub(local.fromArray(mark.rawCenter).applyMatrix4(matrix));
      matrix.setPosition(offset);
      local.copy(eye).applyMatrix4(matrix.clone().invert());
      if (!pointInFootprint(local.x, local.z, model.room.footprint)) continue;
      const candidate = checkOpeningGeometry(model, nearbyEvidence, matrix, { modeled: mark, observed: observation });
      if (!candidate) continue;
      const duplicate = candidates.findIndex(old => model.corners.every(({ point }) =>
        local.fromArray(point).applyMatrix4(matrix).distanceTo(new Vector3(...point).applyMatrix4(old.fit.matrix)) <= limit));
      if (duplicate < 0) candidates.push(candidate);
      else {
        const prior = candidates[duplicate]!;
        // Tiny readout differences must not flip the saved check between two equivalent openings.
        if (candidate.errorM < prior.errorM - 0.005 ||
            (Math.abs(candidate.errorM - prior.errorM) <= 0.005 && candidate.check.id < prior.check.id)) {
          candidates[duplicate] = candidate;
        }
      }
      if (candidates.length > 24) return [];
    }
  }
  return candidates;
}

/** Where both measured walls reach the known ceiling, their tops independently set elevation.
 * The full labeled floor perimeter and a real, withheld floor vertex can then check all three axes. */
export function checkVisibleFloorCorner(
  model: AlignmentModel, floor: NonNullable<RoomEvidence["floor"]>, perimeter: AlignmentWall[],
  check: CalibrationFeature, matrix: Matrix4, first: AlignmentWall, second: AlignmentWall,
): AlignmentCandidate | null {
  const height = model.room.ceilingHeight;
  if (!height || floor.source !== "plane" || !floor.semanticFloor || model.room.footprint.holes?.length ||
      Math.abs(first.high - second.high) > limit) return null;
  const floorY = (first.high + second.high) / 2 - height;
  if (Math.abs(floorY - floor.y) > limit) return null;
  const expected = new Vector3(...check.point).applyMatrix4(matrix);
  // Elevation comes from the top faces, before comparison with the measured floor.
  expected.y = floorY;
  const errorM = floor.outline.reduce((best, [x, z]) =>
    Math.min(best, Math.hypot(expected.x - x, expected.y - floor.y, expected.z - z)), Infinity);
  if (errorM > limit || !outlinesAgree(perimeter.map(wall => wall.a), floor.outline, limit)) return null;
  const pose = matrix.clone();
  pose.elements[13] = floorY - model.room.floorElevation;
  return checkedCandidate(pose, check, errorM, 0);
}
