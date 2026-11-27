import { Vector3 } from "three";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { matchRoomAlignment, viableRoomAlignments, type AlignmentCandidate, type AlignmentModel, type AlignmentWall, type RoomEvidence } from "./roomAlignment";

const span = (w: AlignmentWall) => Math.hypot(w.b[0]-w.a[0],w.b[1]-w.a[1]);

/** User input identifies faces. Only poses already verified by independent geometry are eligible. */
function fitsFace(candidate: AlignmentCandidate, face: AlignmentWall, stroke: AlignmentWall) {
  const a = new Vector3(face.a[0],face.low,face.a[1]).applyMatrix4(candidate.fit.matrix);
  const b = new Vector3(face.b[0],face.low,face.b[1]).applyMatrix4(candidate.fit.matrix);
  const axis = b.clone().sub(a), lengthSq = axis.lengthSq();
  return [stroke.a,stroke.b].every(([x,z]) => {
    const p = new Vector3(x,stroke.low,z).sub(a);
    const t = Math.max(0,Math.min(1,p.dot(axis)/lengthSq));
    return p.addScaledVector(axis,-t).length() <= MAX_CALIBRATION_ERROR_M;
  });
}

/** A newly delivered headset scan can finish a session already partway through tracing. */
export function scanFitsMarkedWalls(candidate: AlignmentCandidate, model: AlignmentModel, strokes: readonly AlignmentWall[]) {
  return strokes.every(stroke => model.walls.some(face => fitsFace(candidate, face, stroke)));
}

export class PairedTraces {
  readonly pairs: {trace: number; wall: number}[] = [];
  current = 0;
  message = "";
  candidate: AlignmentCandidate | null = null;
  constructor(readonly model: AlignmentModel, readonly strokes: readonly AlignmentWall[]) {}

  private available() { return this.strokes.map((_,i) => i).filter(i => !this.pairs.some(p => p.trace === i)); }
  get hasAlternative() { return this.strokes.length - this.pairs.length > 1; }
  nextStroke() {
    const list = this.available();
    this.current = list[(list.indexOf(this.current)+1) % list.length]!;
    this.message = "";
  }
  back() {
    this.candidate = null;
    this.current = this.pairs.pop()?.trace ?? this.current;
    this.message = "";
  }
  availableWall(index: number) {
    const wall = this.model.walls[index], stroke = this.strokes[this.current];
    return !!stroke && !!wall && span(wall) + MAX_CALIBRATION_ERROR_M * 2 >= span(stroke) &&
      !this.pairs.some(pair => pair.wall === index);
  }
  select(wall: number, viewer: Vector3, evidence: RoomEvidence, candidates: AlignmentCandidate[]) {
    if (!this.availableWall(wall)) return;
    this.pairs.push({ trace: this.current, wall });
    let verified = candidates;
    // The wearer explicitly chooses these four lines. A misplaced fifth stroke can stay in the draft.
    if (this.pairs.length === 4) verified = matchRoomAlignment(this.model,
      { ...evidence, walls: this.pairs.map(p => this.strokes[p.trace]!) },viewer);
    const matches = viableRoomAlignments(verified).filter(pose => this.pairs.every(p =>
      fitsFace(pose,this.model.walls[p.wall]!,this.strokes[p.trace]!)));
    if (matches.length === 1) {
      this.candidate = matches[0]!;
      return;
    }
    if (this.pairs.length === 4) {
      this.pairs.pop();
      this.message = matches.length ? "Two positions still fit. Choose a different marked line."
        : "These four lines did not pass the 5 cm check. Try two walls that meet and two on the other sides, or check the floor height.";
      return;
    }
    this.current = this.available()[0]!;
    this.message = "";
  }
}
