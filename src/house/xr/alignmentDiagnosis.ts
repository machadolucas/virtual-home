import type { Matrix4, Vector3 } from "three";
import type { AlignmentDiagnosis } from "../alignmentAttemptTypes";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { uniqueRoomAlignment, viableRoomAlignments, type AlignmentCandidate, type AlignmentModel,
  type AlignmentSearchDiagnostics, type AlignmentWall, type RoomEvidence } from "./roomAlignment";
import { compareMeasuredOutline, likelyOutlinePoses } from "./perimeterDifference";

export type { AlignmentDiagnosis } from "../alignmentAttemptTypes";
interface DiagnoseOptions {
  strokes?: readonly AlignmentWall[];
  verifiedPose?: Matrix4 | null;
  verifiedErrorM?: number | null;
  search?: AlignmentSearchDiagnostics;
}

function directionCount(walls: readonly AlignmentWall[]) {
  const angles: number[] = [];
  for (const { a, b } of walls) {
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.25) continue;
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (angles.every(other => Math.abs(Math.cos(angle - other)) < Math.cos(Math.PI / 12))) angles.push(angle);
  }
  return angles.length;
}

/** Replay captured geometry or use existing search counters at a recording checkpoint. A line gap or
 * outline mismatch is distinct from a three-dimensional held-out check. A hypothesis never authorizes alignment. */
export function diagnoseRoomAttempt(
  model: AlignmentModel | null, evidence: RoomEvidence, viewer: Vector3,
  candidates: readonly AlignmentCandidate[] = [], options: DiagnoseOptions = {},
): AlignmentDiagnosis {
  const walls = evidence.walls.filter(w => !w.baseOnly);
  const strokes = options.strokes ?? evidence.walls.filter(w => w.baseOnly);
  const search = options.search;
  const viable = viableRoomAlignments(candidates);
  const unique = uniqueRoomAlignment([...candidates]);
  const checkedPose = options.verifiedPose ?? unique?.fit.matrix;
  const direction = directionCount(strokes.length ? strokes : walls);
  const report: AlignmentDiagnosis = {
    stage: "evidence", reason: "no-scan-geometry", candidateCount: viable.length,
    fittedPairs: search?.fittedPairs ?? 0, independentChecks: search?.independentChecks ?? 0,
    bestCheckM: search?.bestCheckM ?? null, bestTraceGapM: search?.bestTraceGapM ?? null,
    floorY: evidence.floor?.y ?? null, measuredWalls: walls.length, taggedWalls: walls.filter(w => w.semanticWall).length,
    openings: evidence.landmarks.length, traces: strokes.length, directionalFamilies: direction, outline: null,
  };
  if (options.verifiedPose) {
    const live = options.verifiedErrorM;
    report.bestCheckM = live !== null && live !== undefined && Number.isFinite(live) && live >= 0 ? live :
      viable.find(c => c.fit.matrix.equals(options.verifiedPose!))?.errorM ?? null;
  } else if (unique) report.bestCheckM = unique.errorM;
  else if (viable.length) report.bestCheckM = Math.min(...viable.map(c => c.errorM));
  if (![viewer.x, viewer.y, viewer.z].every(Number.isFinite)) {
    report.reason = "missing-viewer-pose";
    return report;
  }
  if (model && evidence.floor?.source === "plane") {
    if (checkedPose) {
      const diff = compareMeasuredOutline(model, evidence, checkedPose, strokes);
      if (diff) report.outline = { basis: "checked", plausiblePoses: 1, ...diff };
    } else {
      const poses = viable.length ? viable.map(c => c.fit.matrix) : likelyOutlinePoses(model, evidence);
      if (poses.length) {
        const diff = poses.length === 1 ? compareMeasuredOutline(model, evidence, poses[0]!, strokes) : null;
        report.outline = { basis: "hypothesis", plausiblePoses: poses.length,
          maxDeviationM: diff?.maxDeviationM ?? null, walls: diff?.walls ?? [] };
      }
    }
  }
  if (options.verifiedPose) {
    report.stage = "verified"; report.reason = "alignment-verified";
  } else if (unique) {
    report.stage = "check"; report.reason = "checked-pose-found";
  } else if (viable.length) {
    report.stage = "heading"; report.reason = "multiple-checked-headings";
  } else if (!evidence.floor && !walls.length && !report.openings && !strokes.length) {
    report.reason = "no-scan-geometry";
  } else if (!model) {
    report.reason = "room-not-identified";
  } else if (strokes.length > 0 && strokes.length < 4) {
    report.reason = "fewer-than-four-marked-walls";
  } else if (strokes.length && direction < 2) {
    report.stage = "fit"; report.reason = "marked-walls-parallel";
  } else if (report.bestTraceGapM !== null && report.bestTraceGapM > MAX_CALIBRATION_ERROR_M) {
    report.stage = "fit"; report.reason = "marked-wall-endpoints-disagree";
  } else if (search?.contradictedWall) {
    report.stage = "check"; report.reason = "observed-wall-crosses-fitted-room";
  } else if (report.bestCheckM !== null && report.bestCheckM > MAX_CALIBRATION_ERROR_M) {
    report.stage = "check"; report.reason = "independent-check-exceeds-tolerance";
  } else if (search?.contradictedOpening || candidates.some(c => c.landmarkConflict)) {
    report.stage = "check"; report.reason = "opening-correspondence-conflict";
  } else if (report.outline?.plausiblePoses && report.outline.basis === "hypothesis") {
    report.stage = "fit"; report.reason = report.outline.plausiblePoses > 1 ? "outline-heading-ambiguous" : "local-outline-discrepancy";
  } else if (report.fittedPairs > 0) {
    report.stage = "check"; report.reason = "no-independent-corroboration";
  } else if (!evidence.floor && report.openings < 2) {
    report.reason = "no-measured-floor-or-opening-pair";
  } else if (direction < 2 && report.openings < 2) {
    report.reason = "insufficient-wall-directions";
  } else {
    report.stage = "fit"; report.reason = "no-compatible-rigid-fit";
  }
  return report;
}
