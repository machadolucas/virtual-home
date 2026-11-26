import { CircleGeometry, Group, Mesh, MeshBasicMaterial, RingGeometry, Vector3, type Quaternion } from "three";
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
  maxAngle = Math.PI / 6,
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
  return best && best.angle <= maxAngle && (scores[1]?.angle ?? Infinity) - best.angle >= Math.PI / 9
    ? best.candidate
    : null;
}

export const FACING_HOLD_ANGLE = Math.PI / 12;
const HOLD_MS = 1_100;
const MAX_FRAME_GAP_MS = 180;
const TURN_DOT = Math.cos(Math.PI / 15);
const STEADY_DOT = Math.cos(7 * Math.PI / 180);
const SAME_YAW_DOT = Math.cos(Math.PI / 60);

export function sameFacing(a: AlignmentCandidate, b: AlignmentCandidate, target: FacingTarget) {
  if (a === b) return true;
  return (
    Math.cos(a.fit.yaw - b.fit.yaw) >= SAME_YAW_DOT &&
    new Vector3(...target.point)
      .applyMatrix4(a.fit.matrix)
      .distanceToSquared(new Vector3(...target.point).applyMatrix4(b.fit.matrix)) <=
      0.07 ** 2
  );
}

/** A dwell starts only after an observed, post-prompt turn into the requested bearing. */
export class FacingHold {
  private baseline: Vector3 | null = null;
  private mustLookAway = false;
  private lastFrame = -Infinity;
  private start: {
    gaze: Vector3;
    eye: Vector3;
    candidate: AlignmentCandidate;
    scan: number;
    time: number;
  } | null = null;
  progress = 0;

  reset() {
    this.baseline = null;
    this.mustLookAway = false;
    this.lastFrame = -Infinity;
    this.cancelHold();
  }

  private cancelHold() {
    this.start = null;
    this.progress = 0;
  }

  update(
    target: FacingTarget,
    candidate: AlignmentCandidate | null,
    eye: Vector3,
    gaze: Vector3,
    scan: number,
    now: number,
    panelHit: boolean,
  ): AlignmentCandidate | null {
    if (now - this.lastFrame > MAX_FRAME_GAP_MS) this.reset();
    this.lastFrame = now;
    const horizontal = Math.hypot(gaze.x, gaze.z);
    if (!(horizontal >= 0.35)) {
      this.cancelHold();
      return null;
    }
    if (!this.baseline) {
      this.baseline = new Vector3(gaze.x / horizontal, 0, gaze.z / horizontal);
      this.mustLookAway = !!candidate;
      return null;
    }
    const turned = (this.baseline.x * gaze.x + this.baseline.z * gaze.z) / horizontal < TURN_DOT;
    if (!candidate && this.mustLookAway && turned) {
      this.mustLookAway = false;
      this.baseline.set(gaze.x / horizontal, 0, gaze.z / horizontal);
    }
    if (!candidate || this.mustLookAway || !turned || panelHit) {
      this.cancelHold();
      return null;
    }
    const start = this.start;
    if (start && !sameFacing(start.candidate, candidate, target)) {
      this.reset();
      return null;
    }
    if (!start || start.gaze.dot(gaze) < STEADY_DOT || start.eye.distanceToSquared(eye) > 0.18 ** 2) {
      this.start = { eye: eye.clone(), gaze: gaze.clone(), candidate, scan, time: now };
      this.progress = 0;
      return null;
    }
    const fresh = scan !== start.scan;
    this.progress = Math.min(fresh ? 1 : 0.95, (now - start.time) / HOLD_MS);
    return this.progress >= 1 ? start.candidate : null;
  }
}

/** A small tracking-space guide stays where the wearer first holds their bearing. */
export class FacingProgress {
  readonly group = new Group();
  private readonly segments = 48;
  private readonly background = new Mesh(
    new CircleGeometry(0.029, this.segments),
    new MeshBasicMaterial({
      color: 0x142633,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.89,
      toneMapped: false,
    }),
  );
  private readonly meter = new Mesh(
    new RingGeometry(0.018, 0.024, this.segments, 1, Math.PI / 2),
    new MeshBasicMaterial({
      color: 0x8be7ce,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
    }),
  );

  constructor() {
    this.group.name = "vh-facing-progress";
    this.group.visible = false;
    this.background.renderOrder = 1001;
    this.meter.renderOrder = 1002;
    this.group.add(this.background, this.meter);
  }

  show(fraction: number, eye: Vector3, orientation: Quaternion) {
    if (!this.group.visible) {
      this.group.position.set(0, -0.18, -0.83).applyQuaternion(orientation).add(eye);
      this.group.quaternion.copy(orientation);
      this.group.visible = true;
    }
    this.meter.geometry.setDrawRange(0, Math.floor(fraction * this.segments) * 6);
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
    for (const mesh of [this.background, this.meter]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}
