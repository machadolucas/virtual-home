import { Vector3 } from "three";
import type { Room, Vec3 } from "../model/types";
import type { AlignmentCandidate, AlignmentModel } from "./roomAlignment";

export interface FacingTarget {
  label: string;
  point: Vec3;
  planEdge?: number;
}

export function facingTargets(
  model: AlignmentModel,
  rooms: readonly Room[],
  names: Record<string, string>,
): FacingTarget[] {
  const targets: FacingTarget[] = [];
  for (const kind of ["door", "window"] as const) {
    const openings = model.landmarks.filter((landmark) => landmark.kind === kind);
    if (openings.length === 1) targets.push({ label: "the " + kind, point: openings[0]!.center });
  }
  // A neighbouring room gives an identifiable bearing even when the model contains no openings.
  const center = (r: Room): Vec3 => {
    const ring = r.footprint.outer;
    return [
      ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
      r.floorElevation,
      ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
    ];
  };
  const here = center(model.room);
  const nearby = rooms
    .filter(
      (r) => r.id !== model.room.id && r.floorId === model.room.floorId && r.footprint.outer.length >= 3,
    )
    .map((r) => ({ label: names[r.id] || r.name, point: center(r) }))
    .map((target) => ({
      target,
      distance: Math.hypot(target.point[0] - here[0], target.point[2] - here[2]),
    }))
    .filter(({ distance }) => distance >= 1.5 && distance <= 12)
    .sort((a, b) => a.distance - b.distance);
  const edge = model.walls.reduce<AlignmentModel["walls"][number] | null>(
    (longest, wall) =>
      !longest ||
      Math.hypot(wall.a[0] - wall.b[0], wall.a[1] - wall.b[1]) >
        Math.hypot(longest.a[0] - longest.b[0], longest.a[1] - longest.b[1])
        ? wall
        : longest,
    null,
  );
  const planEdge =
    edge && model.corners.findIndex(({ point }) => point[0] === edge.a[0] && point[2] === edge.a[1]);
  const plan: FacingTarget[] =
    edge && planEdge != null && planEdge >= 0
      ? [
          {
            label: "the highlighted wall",
            planEdge,
            point: [(edge.a[0] + edge.b[0]) / 2, model.room.floorElevation, (edge.a[1] + edge.b[1]) / 2],
          },
        ]
      : [];
  return [...targets, ...nearby.slice(0, 2).map(({ target }) => target), ...plan];
}

/** The head bearing chooses between previously verified metric poses. It never fits a pose. */
export function chooseFacing(
  candidates: readonly AlignmentCandidate[],
  target: FacingTarget,
  eye: Vector3,
  gaze: Vector3,
) {
  const length = Math.hypot(gaze.x, gaze.z);
  if (length < 0.35) return null;
  const scores = candidates
    .filter((c) => !c.landmarkConflict)
    .map((candidate) => {
      const p = new Vector3(...target.point).applyMatrix4(candidate.fit.matrix).sub(eye);
      const d = Math.hypot(p.x, p.z);
      const cosine = (p.x * gaze.x + p.z * gaze.z) / (length * d);
      return { candidate, angle: d < 0.35 ? Infinity : Math.acos(Math.max(-1, Math.min(1, cosine))) };
    })
    .sort((a, b) => a.angle - b.angle);
  const best = scores[0];
  return best && best.angle <= Math.PI / 6 && (scores[1]?.angle ?? Infinity) - best.angle >= Math.PI / 9
    ? best.candidate
    : null;
}
