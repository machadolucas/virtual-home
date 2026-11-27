import {
  BoxGeometry,
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
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
  private rays: (Ray | null)[] = [];
  private readonly savedRays: (Ray | null)[][] = [];
  private fitted: AlignmentWall | null = null;
  private span = 0;
  private readonly committed = new InstancedMesh(new BoxGeometry(1,1,1),
    new MeshBasicMaterial({ color: 0x60e3bd, toneMapped: false }), MAX_WALLS);
  private readonly strokePose = new Object3D();
  private readonly highlightLine = new Mesh(new BoxGeometry(1,1,1),
    new MeshBasicMaterial({ color: 0xffbe5d, toneMapped: false, depthTest: false }));
  private readonly active = new Line(
    strokeGeometry(MAX_SAMPLES),
    new LineBasicMaterial({ color: 0xffd386 }),
  );

  constructor() {
    this.active.frustumCulled = this.committed.frustumCulled = this.highlightLine.frustumCulled = false;
    this.highlightLine.renderOrder = 2;
    this.highlightLine.visible = false;
    this.committed.count = 0;
    this.group.name = "vh-wall-base-traces";
    this.group.add(this.committed, this.active, this.highlightLine);
  }
  begin(source: XRInputSource) {
    if (this.source || this.walls.length >= MAX_WALLS) return false;
    this.source = source;
    this.active.material.color.setHex(0xffd386);
    this.message = "";
    return true;
  }
  sample(point: Vector3 | null, ray?: Ray | null) {
    if (!this.source || !point || !Number.isFinite(point.lengthSq()) || this.points.length >= MAX_SAMPLES)
      return;
    const last = this.points.at(-1);
    if (last && last.distanceToSquared(point) < 0.03 ** 2) return;
    this.points.push(point.clone());
    this.rays.push(ray?.clone() ?? null);
    this.span = Math.max(this.span, point.distanceTo(this.points[0]!));
    const fitted = fitWallTrace(this.points);
    this.fitted = fitted;
    const ready = fitted && !this.walls.some(existing => sameWall(existing, fitted));
    this.active.material.color.setHex(ready ? 0x60e3bd : 0xffd386);
    const buffer = this.active.geometry.getAttribute("position");
    buffer.setXYZ(this.points.length - 1, point.x, point.y, point.z);
    buffer.needsUpdate = true;
    this.active.geometry.setDrawRange(0, this.points.length);
  }
  finish(source: XRInputSource) {
    if (this.source !== source) return false;
    const wall = this.fitted, span = this.span, rays = this.rays;
    this.cancel();
    if (!wall) this.message = span < MIN_SPAN
      ? "Line too short. Sweep about one metre along the wall and release when green."
      : "Line too uneven. Follow one straight wall base and release when green.";
    else if (this.walls.some((existing) => sameWall(existing, wall)))
      this.message = "That wall is already marked. Trace a different wall.";
    else {
      this.walls.push(wall);
      this.savedRays.push(rays);
      this.drawWalls();
      this.message = "";
      return true;
    }
    return false;
  }
  undo() {
    this.cancel();
    this.remove(this.walls.length - 1);
  }
  highlight(index: number | null) {
    const wall = index === null ? null : this.walls[index];
    this.highlightLine.visible = !!wall;
    if (!wall) return;
    this.placeStroke(this.highlightLine,wall,0.034);
  }
  remove(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.walls.length) return;
    this.cancel();
    this.walls.splice(index, 1);
    this.savedRays.splice(index, 1);
    this.highlight(null);
    this.drawWalls();
    this.message = "";
  }
  cancel() {
    if (!this.source) return;
    this.source = null;
    this.points = [];
    this.rays = [];
    this.fitted = null;
    this.span = 0;
    this.active.geometry.setDrawRange(0, 0);
  }
  /** Rebuild all saved lines against the newly measured plane, or retain the entire original set. */
  reprojectFloor(y: number): boolean {
    if (!Number.isFinite(y) || this.source || this.walls.length !== this.savedRays.length) return false;
    const adjusted: AlignmentWall[] = [];
    for (const rays of this.savedRays) {
      const points: Vector3[] = [];
      for (const ray of rays) {
        const hit = ray && floorAim(ray, y, new Vector3());
        if (!hit) return false;
        points.push(hit);
      }
      const wall = fitWallTrace(points);
      if (!wall || adjusted.some(previous => sameWall(previous, wall))) return false;
      adjusted.push(wall);
    }
    this.walls.splice(0, this.walls.length, ...adjusted);
    this.highlight(null);
    this.drawWalls();
    return true;
  }
  evidence(y: number, native: RoomEvidence, measuredFloor = false): RoomEvidence {
    // Reuse the measured floor height, even when the scanner returns only a partial floor polygon.
    // Do not count the same physical wall twice or use the floor outline to verify a hand trace.
    return {
      walls: [
        ...native.walls.filter((w) => !this.walls.some((traced) => sameWall(w, traced))),
        ...this.walls,
      ],
      landmarks: native.landmarks,
      floor: { y, outline: [], source: "bounds", confirmedHeight: measuredFloor,
        semanticFloor: native.floor?.semanticFloor === true && y === native.floor.y },
    };
  }
  private placeStroke(object: Object3D, {a,b,low}: AlignmentWall, width: number) {
    const dx = b[0]-a[0], dz = b[1]-a[1];
    object.position.set((a[0]+b[0])/2,low+width/2,(a[1]+b[1])/2);
    object.rotation.y = -Math.atan2(dz,dx);
    object.scale.set(Math.hypot(dx,dz),width,width);
    object.updateMatrix();
  }
  private drawWalls() {
    this.walls.forEach((wall, i) => {
      this.placeStroke(this.strokePose,wall,0.014);
      this.committed.setMatrixAt(i,this.strokePose.matrix);
    });
    this.committed.count = this.walls.length;
    this.committed.instanceMatrix.needsUpdate = true;
  }
  dispose() {
    this.group.removeFromParent();
    this.committed.dispose();
    for (const line of [this.active, this.committed, this.highlightLine]) {
      line.geometry.dispose();
      line.material.dispose();
    }
  }
}
