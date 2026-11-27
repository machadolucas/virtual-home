import { Vector3 } from "three";
import type { AlignmentAttemptSnapshot } from "../alignmentAttemptTypes";
import { diagnoseRoomAttempt } from "./alignmentDiagnosis";
import { filterPairedTraces, scanFitsMarkedWalls } from "./pairedTraces";
import { matchRoomAlignment, newAlignmentSearchDiagnostics, type AlignmentModel, type RoomEvidence } from "./roomAlignment";

/** Re-run one retained observation in its original tracking space. Older snapshots may lack
 * selection and floor provenance; explicit overrides can reconstruct them from recorded events. */
export function replayAlignmentSnapshot(
  model: AlignmentModel | null, snapshot: AlignmentAttemptSnapshot,
  options: { selectedRoom?: boolean; measuredFloorY?: number } = {},
) {
  const viewer = new Vector3(...snapshot.viewer);
  const native: RoomEvidence = { walls: snapshot.walls, floor: snapshot.floor, landmarks: snapshot.landmarks };
  let search = newAlignmentSearchDiagnostics();
  const strokes = snapshot.traces;
  if (!model) return diagnoseRoomAttempt(null, native, viewer, [], { strokes });
  const selectedRoom = options.selectedRoom ?? snapshot.selectedRoom ?? false;
  const pairs = snapshot.wallPairs ?? [];
  let candidates = matchRoomAlignment(model, native, viewer, { selectedRoom, diagnostics: search })
    .filter(candidate => scanFitsMarkedWalls(candidate, model, strokes));
  if (strokes.length && (!candidates.length || pairs.length === 4)) {
    const y = options.measuredFloorY ?? snapshot.traceFloor?.y ?? strokes[0]!.low;
    const marked = pairs.length === 4 ? pairs.flatMap(p => strokes[p.trace] ? [strokes[p.trace]!] : []) : strokes;
    const traced: RoomEvidence = { walls: marked, landmarks: native.landmarks, floor: { source: "bounds", outline: [], y,
      semanticFloor: native.floor?.semanticFloor && Math.abs(native.floor.y - y) <= 0.001,
      confirmedHeight: options.measuredFloorY !== undefined || snapshot.traceFloor?.measured === true } };
    search = newAlignmentSearchDiagnostics();
    candidates = matchRoomAlignment(model, traced, viewer, { diagnostics: search });
  }
  if (pairs.length) {
    const matching = filterPairedTraces(model, strokes, pairs, candidates);
    if (candidates.length && !matching.length) {
      const report = diagnoseRoomAttempt(model, native, viewer, [], { strokes, search });
      // An independent check for another assignment cannot establish an error for the named walls.
      return { ...report, reason: "marked-plan-correspondence-conflict", stage: "fit" as const, bestCheckM: null };
    }
    candidates = matching;
  }
  return diagnoseRoomAttempt(model, native, viewer, candidates, { search, strokes });
}
