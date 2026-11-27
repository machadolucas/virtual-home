import type { Matrix4, Vector3 } from "three";
import type { AlignmentAttemptSnapshot } from "../alignmentAttemptTypes";
import type { AlignmentEvidence } from "./roomAlignmentEvidence";
import type { AlignmentModel, AlignmentCandidate, AlignmentWall, AlignmentSearchDiagnostics } from "./roomAlignment";
import { diagnoseRoomAttempt } from "./alignmentDiagnosis";

const mm = (n: number) => Math.round(n * 1000) / 1000;
const pair = (p: readonly number[]): [number,number] => [mm(p[0]!), mm(p[1]!)];
const triple = (p: readonly number[]): [number,number,number] => [mm(p[0]!), mm(p[1]!), mm(p[2]!)];
const wall = (w: AlignmentWall) => ({a:pair(w.a),b:pair(w.b),low:mm(w.low),high:mm(w.high),
  semanticWall:w.semanticWall,baseOnly:w.baseOnly});

export function alignmentSnapshot(model: AlignmentModel | null, evidence: AlignmentEvidence, viewer: Vector3,
  candidates: readonly AlignmentCandidate[], strokes: readonly AlignmentWall[], search?: AlignmentSearchDiagnostics,
  verifiedPose?: Matrix4, verifiedErrorM?: number | null): Omit<AlignmentAttemptSnapshot, "atMs" | "roomId" | "space"> {
  const floor = evidence.floor;
  return {
    viewer:triple(viewer.toArray()), detections:evidence.detections,
    floor:floor ? {y:mm(floor.y),source:floor.source,semanticFloor:floor.semanticFloor,confirmedHeight:floor.confirmedHeight,
      outline:floor.outline.filter((_,i) => i % Math.ceil(floor.outline.length / 128) === 0).map(pair)} : null,
    walls:evidence.walls.slice(0,72).map(wall), traces:strokes.slice(0,20).map(wall),
    landmarks:evidence.landmarks.slice(0,24).map(m => ({kind:m.kind, center:triple(m.center), rawCenter:m.rawCenter && triple(m.rawCenter),
      axis:m.axis && pair(m.axis), width:mm(m.width), height:mm(m.height)})),
    diagnosis:diagnoseRoomAttempt(model,evidence,viewer,candidates,{strokes,search,verifiedPose,verifiedErrorM}),
  };
}
