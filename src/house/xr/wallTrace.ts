import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  Ray,
  Vector3,
} from "three";
import type { AlignmentWall, RoomEvidence } from "./roomAlignment";

const MIN_SPAN = 0.75;
const MAX_WALLS = 20;
const MAX_SAMPLES = 192;

function strokeGeometry(capacity: number) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(capacity * 3, 3).setUsage(DynamicDrawUsage));
  geometry.setDrawRange(0, 0);
  return geometry;
}

/** Intersect a tracked laser with the headset's local floor. Grazing rays magnify ordinary hand jitter. */
export function floorAim(ray: Ray, y: number, out: Vector3): Vector3 | null {
  if (ray.direction.y > -0.13) return null;
  const t = (y - ray.origin.y) / ray.direction.y;
  return t >= 0.18 && t <= 8 ? ray.at(t, out) : null;
}

export function fitWallTrace(points: readonly Vector3[]): AlignmentWall | null {
  if (points.length < 6) return null;
  const mean = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
  let xx = 0,
    zz = 0,
    xz = 0;
  for (const p of points) {
    xx += (p.x - mean.x) ** 2;
    zz += (p.z - mean.z) ** 2;
    xz += (p.x - mean.x) * (p.z - mean.z);
  }
  const angle = Math.atan2(2 * xz, xx - zz) / 2;
  const dx = Math.cos(angle),
    dz = Math.sin(angle);
  const stations: number[] = [],
    errors: number[] = [];
  for (const p of points) {
    const x = p.x - mean.x,
      z = p.z - mean.z;
    stations.push(dx * x + dz * z);
    errors.push(Math.hypot(dx * z - dz * x, p.y - mean.y));
  }
  stations.sort((a, b) => a - b);
  errors.sort((a, b) => a - b);
  const trim = Math.floor(points.length * 0.04);
  const lo = stations[trim]!,
    hi = stations[points.length - 1 - trim]!;
  if (hi - lo < MIN_SPAN || errors[Math.floor(points.length * 0.9)]! > 0.035 || errors.at(-1)! > 0.08)
    return null;
  return {
    a: [mean.x + lo * dx, mean.z + lo * dz],
    b: [mean.x + hi * dx, mean.z + hi * dz],
    low: mean.y,
    high: mean.y,
    baseOnly: true,
  };
}

function sameWall(a: AlignmentWall, b: AlignmentWall): boolean {
  const dx = a.b[0] - a.a[0],
    dz = a.b[1] - a.a[1];
  const length = Math.hypot(dx, dz);
  return [b.a, b.b].every((p) => Math.abs(dx * (p[1] - a.a[1]) - dz * (p[0] - a.a[0])) / length < 0.07);
}

/** Local-floor evidence lives only in the current tracked space. A stroke never supplies a measured floor perimeter. */
export class WallTrace {
  readonly group = new Group();
  readonly walls: AlignmentWall[] = [];
  source: XRInputSource | null = null;
  message = "";
  private points: Vector3[] = [];
  private readonly committed = new LineSegments(
    strokeGeometry(MAX_WALLS * 2),
    new LineBasicMaterial({ color: 0x60e3bd }),
  );
  private readonly active = new Line(
    strokeGeometry(MAX_SAMPLES),
    new LineBasicMaterial({ color: 0xffd386 }),
  );

  constructor() {
    this.active.frustumCulled = this.committed.frustumCulled = false;
    this.group.name = "vh-wall-base-traces";
    this.group.add(this.committed, this.active);
  }
  begin(source: XRInputSource) {
    if (this.source || this.walls.length >= MAX_WALLS) return false;
    this.source = source;
    this.active.material.color.setHex(0xffd386);
    this.message = "";
    return true;
  }
  sample(point: Vector3 | null) {
    if (!this.source || !point || !Number.isFinite(point.lengthSq()) || this.points.length >= MAX_SAMPLES)
      return;
    const last = this.points.at(-1);
    if (last && last.distanceToSquared(point) < 0.03 ** 2) return;
    if (this.points.length && point.distanceToSquared(this.points[0]!) >= 0.95 ** 2)
      this.active.material.color.setHex(0x60e3bd);
    this.points.push(point.clone());
    const buffer = this.active.geometry.getAttribute("position");
    buffer.setXYZ(this.points.length - 1, point.x, point.y, point.z);
    buffer.needsUpdate = true;
    this.active.geometry.setDrawRange(0, this.points.length);
  }
  finish(source: XRInputSource) {
    if (this.source !== source) return false;
    const wall = fitWallTrace(this.points);
    this.cancel();
    if (!wall) this.message = "Try a longer, straight stroke along one wall base.";
    else if (this.walls.some((existing) => sameWall(existing, wall)))
      this.message = "That wall is already marked. Trace a different wall.";
    else {
      this.walls.push(wall);
      this.drawWalls();
      this.message = "";
      return true;
    }
    return false;
  }
  undo() {
    this.cancel();
    this.walls.pop();
    this.drawWalls();
    this.message = "";
  }
  cancel() {
    if (!this.source) return;
    this.source = null;
    this.points = [];
    this.active.geometry.setDrawRange(0, 0);
  }
  evidence(y: number, native: RoomEvidence): RoomEvidence {
    // Reuse the measured floor height, even when the scanner returns only a partial floor polygon.
    // Do not count the same physical wall twice or use the floor outline to verify a hand trace.
    return {
      walls: [
        ...native.walls.filter((w) => !this.walls.some((traced) => sameWall(w, traced))),
        ...this.walls,
      ],
      landmarks: native.landmarks,
      floor: { y, outline: [], source: "bounds" },
    };
  }
  private drawWalls() {
    const buffer = this.committed.geometry.getAttribute("position");
    this.walls.forEach(({ a, b, low }, i) => {
      buffer.setXYZ(i * 2, a[0], low, a[1]);
      buffer.setXYZ(i * 2 + 1, b[0], low, b[1]);
    });
    buffer.needsUpdate = true;
    this.committed.geometry.setDrawRange(0, this.walls.length * 2);
  }
  dispose() {
    this.group.removeFromParent();
    for (const line of [this.active, this.committed]) {
      line.geometry.dispose();
      line.material.dispose();
    }
  }
}
