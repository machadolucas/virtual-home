import {
  BufferGeometry, Float32BufferAttribute, Group, LineDashedMaterial, LineSegments, Matrix4, Vector3,
} from "three";
import { pointInFootprint, ringSignedArea } from "../model/geometry2d";
import type { Room } from "../model/types";
import type { PanelPage, PanelRow } from "./panelLayout";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { viableRoomAlignments, type AlignmentCandidate, type AlignmentModel, type AlignmentWall, type RoomEvidence } from "./roomAlignment";
import { floorOutlinePoses } from "./roomOutline";

/** One identified wall midpoint supplies position. A tracked wall face or the wearer's
 * square-on direction supplies heading. This estimate never enters the calibration state. */
export function wallPreviewPose(
  room: Room, wall: AlignmentWall, point: Vector3, eye: Vector3, seen: AlignmentWall[], floorY = point.y,
): Matrix4 | null {
  if (![...point.toArray(), ...eye.toArray()].every(Number.isFinite)) return null;
  const toward = new Vector3(eye.x - point.x, 0, eye.z - point.z);
  const distance = toward.length();
  if (distance < 0.45 || distance > 8) return null;
  toward.divideScalar(distance);
  let observed = toward;
  let closest = 0.22;
  for (const face of seen) {
    const dx = face.b[0] - face.a[0], dz = face.b[1] - face.a[1];
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 0.25 || face.high - face.low < 0.43 || point.y < face.low - 0.05 || point.y > face.high + 0.05) continue;
    const x = point.x - face.a[0], z = point.z - face.a[1];
    const station = Math.max(0, Math.min(1, (x * dx + z * dz) / lengthSq));
    const gap = Math.hypot(x - station * dx, z - station * dz);
    if (gap >= closest) continue;
    const normal = new Vector3(-dz, 0, dx).normalize(), dot = normal.dot(toward);
    if (Math.abs(dot) < 0.35) continue;
    closest = gap;
    observed = normal.multiplyScalar(Math.sign(dot));
  }
  const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1];
  const side = Math.sign(ringSignedArea(room.footprint.outer));
  if (!side || Math.hypot(dx, dz) < 0.75) return null;
  const yaw = Math.atan2(side * dx, -side * dz) - Math.atan2(observed.z, observed.x);
  const pose = new Matrix4().makeRotationY(yaw);
  const mid = new Vector3((wall.a[0] + wall.b[0]) / 2, room.floorElevation, (wall.a[1] + wall.b[1]) / 2);
  pose.setPosition(new Vector3(point.x, floorY, point.z).sub(mid.applyMatrix4(pose)));
  const local = eye.clone().applyMatrix4(pose.clone().invert());
  return pointInFootprint(local.x, local.z, room.footprint) ? pose : null;
}

export class RoomPreview {
  readonly group = new Group();
  private readonly outline: LineSegments<BufferGeometry, LineDashedMaterial>;
  private readonly inverse = new Matrix4();
  private readonly local = new Vector3();
  private source: "floor" | "aim" | null = null;
  private dismissed = false;
  private identifiedPoint: Vector3 | null = null;
  useBase = false;
  placing: "wall" | "aim" | null = null;
  private wall = -1;
  message = "";

  constructor(readonly model: AlignmentModel, private readonly preferBase = false) {
    const points: number[] = [];
    const y = model.room.floorElevation + 0.02;
    for (const ring of [model.room.footprint.outer, ...(model.room.footprint.holes ?? [])]) {
      ring.forEach(([x, z], i) => {
        const [nextX, nextZ] = ring[(i + 1) % ring.length]!;
        points.push(x, y, z, nextX, y, nextZ);
        points.push(x, y, z, x, y + 0.14, z);
      });
    }
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
    this.outline = new LineSegments(geometry, new LineDashedMaterial({
      color: 0xffbf60, dashSize: 0.17, gapSize: 0.09, toneMapped: false, depthWrite: false,
    }));
    this.outline.computeLineDistances();
    this.group.name = "vh-estimated-room-outline";
    this.group.matrixAutoUpdate = false;
    this.group.visible = false;
    this.group.add(this.outline);
  }

  actions(): PanelRow[] {
    if (this.group.visible) return [
      { label: "Reposition estimated outline", act: () => this.chooseWall() },
      { label: "Hide estimated outline", act: () => this.hide() },
    ];
    return [{ label: "Preview room outline", detail: "Start with one wall", act: () => this.chooseWall() }];
  }
  menu(): PanelPage {
    const corners = this.model.corners.map(corner => corner.point);
    const cancel = { label: "Back to alignment", act: () => { this.placing = null; } };
    const wall = this.model.walls[this.wall];
    if (this.placing === "aim" && wall) return {
      title: "Aim at the wall midpoint", corners,
      planEdge: corners.findIndex(([x, , z]) => x === wall.a[0] && z === wall.a[1]),
      lines: [this.message || (this.useBase ? "Aim at the middle where the exposed wall meets the floor."
        : "Face the wall squarely. Aim halfway along it at any visible height, even above a sofa.")],
      rows: [{ label: this.useBase ? "Aim at the wall face" : "Use the exposed wall base", act: () => {
        this.useBase = !this.useBase; this.message = "";
      } }, { label: "Choose another wall", act: () => this.chooseWall() }, cancel],
    };
    return {
      title: "Choose a wall to preview", corners,
      lines: ["Tap a wall you can face from here. One aim will place the estimated outline."],
      wallPicker: {
        walls: this.model.walls.flatMap(({ a, b }, index) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.75 ? []
          : [{ index, x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, picked: false, enabled: true }]),
        openings: this.model.landmarks.map(({ center: [x, , z], kind }) => ({ x, z, kind })),
        choose: index => { if (this.placing === "wall" && this.model.walls[index]) { this.wall = index; this.placing = "aim"; } },
      },
      rows: [cancel],
    };
  }
  private chooseWall() {
    this.identifiedPoint = null;
    this.useBase = this.preferBase;
    this.placing = "wall";
    this.wall = -1;
    this.message = "";
  }
  aim(point: Vector3 | null, eye: Vector3, seen: AlignmentWall[], floorY?: number) {
    const wall = this.model.walls[this.wall];
    if (this.placing !== "aim" || !wall) return false;
    const pose = point && wallPreviewPose(this.model.room, wall, point, eye, seen, floorY);
    if (!pose) {
      this.message = "Face the wall squarely and aim halfway along a clear section.";
      return false;
    }
    this.dismissed = false;
    this.placing = null;
    this.identifiedPoint = point!.clone();
    this.show(pose, "aim");
    return true;
  }
  /** Only disambiguate existing checked poses with the original measured point. */
  resolveWallHeading(candidates: AlignmentCandidate[]): AlignmentCandidate | null {
    const point = this.identifiedPoint, wall = this.model.walls[this.wall];
    if (!point || !wall || !this.group.visible || this.placing || candidates.length < 2) return null;
    const dx = wall.b[0] - wall.a[0], dz = wall.b[1] - wall.a[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.75) return null;
    const local = new Vector3(), inverse = new Matrix4();
    const matching = viableRoomAlignments(candidates).filter(candidate => {
      if (!(candidate.errorM >= 0 && candidate.errorM <= MAX_CALIBRATION_ERROR_M)) return false;
      local.copy(point).applyMatrix4(inverse.copy(candidate.fit.matrix).invert());
      const x = local.x - (wall.a[0] + wall.b[0]) / 2;
      const z = local.z - (wall.a[1] + wall.b[1]) / 2;
      const along = (x * dx + z * dz) / length;
      const normal = (z * dx - x * dz) / length;
      const heightError = this.useBase ? local.y - wall.low : Math.max(wall.low - local.y, local.y - wall.high, 0);
      return Math.abs(along) <= Math.min(length / 4, 0.75) &&
        Math.hypot(normal, heightError) <= MAX_CALIBRATION_ERROR_M;
    });
    return matching.length === 1 ? matching[0]! : null;
  }
  observe(evidence: RoomEvidence, eye: Vector3) {
    if (this.source === "aim" || this.dismissed || this.placing) return;
    const poses = floorOutlinePoses(this.model.room, evidence, eye);
    if (poses.length === 1) this.show(poses[0]!, "floor");
    else {
      this.source = null;
      this.group.visible = false;
    }
  }
  private show(matrix: Matrix4, source: "floor" | "aim") {
    this.source = source;
    this.group.matrix.copy(matrix);
    this.inverse.copy(matrix).invert();
    this.group.matrixWorldNeedsUpdate = true;
    this.group.visible = true;
  }
  track(eye: Vector3) {
    if (!this.source) return;
    this.local.copy(eye).applyMatrix4(this.inverse);
    const room = this.model.room;
    this.group.visible = pointInFootprint(this.local.x, this.local.z, room.footprint) &&
      this.local.y >= room.floorElevation + 0.35 && this.local.y <= room.floorElevation + (room.ceilingHeight ?? 2.7) + 0.2;
  }
  reset() {
    this.identifiedPoint = null;
    this.useBase = false;
    this.source = null;
    this.dismissed = false;
    this.group.visible = false;
    this.placing = null;
    this.wall = -1;
    this.message = "";
  }
  hide() { this.reset(); this.dismissed = true; }
  dispose() {
    this.group.removeFromParent();
    this.outline.geometry.dispose();
    this.outline.material.dispose();
  }
}
