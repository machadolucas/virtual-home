import * as THREE from "three";
import type { Room, Vec3 } from "@/house/model/types";
import type { RoomSurveyGeometry, RoomSurveyPose } from "../roomSurveyTypes";

type SurveySurface = RoomSurveyGeometry["surfaces"][number];

const REFERENCE = 0x5ccbd8;
const ORIGINAL = 0xffad55;
const PROPOSED = 0x77e4a5;

export interface SurveyObjectShape {
  geometry: THREE.BufferGeometry;
  scale: THREE.Vector3;
  tilt?: number;
}

function clear(group: THREE.Group): void {
  group.traverse((object) => {
    const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    mesh.geometry?.dispose();
    mesh.material?.dispose();
  });
  group.clear();
}

function line(points: Vec3[], color: number, loop = false) {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
  return loop ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material);
}

function pin(position: Vec3, color: number, radius = 0.025) {
  const object = new THREE.Mesh(new THREE.SphereGeometry(radius, 8, 6), new THREE.MeshBasicMaterial({ color }));
  object.position.fromArray(position);
  return object;
}

function planeTriangles(points: Vec3[]): number[] {
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i++) {
    const [ax, ay, az] = points[i]!;
    const [bx, by, bz] = points[(i + 1) % points.length]!;
    normal.x += (ay - by) * (az + bz);
    normal.y += (az - bz) * (ax + bx);
    normal.z += (ax - bx) * (ay + by);
  }
  const [x, y, z] = normal.toArray().map(Math.abs) as Vec3;
  const projected = points.map(([a, b, c]) =>
    x >= y && x >= z ? new THREE.Vector2(b, c) : y >= z ? new THREE.Vector2(a, c) : new THREE.Vector2(a, b));
  return THREE.ShapeUtils.triangulateShape(projected, []).flat();
}

function translucentSurface(surface: SurveySurface) {
  if (!surface.indices && surface.points.length > 4_096) return null;
  const indices = surface.indices ?? planeTriangles(surface.points);
  if (!indices.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(surface.points.flat(), 3));
  geometry.setIndex(indices);
  const material = new THREE.MeshBasicMaterial({
    color: REFERENCE, side: THREE.DoubleSide, transparent: true,
    opacity: surface.source === "mesh" ? 0.12 : 0.19, depthWrite: false,
  });
  return new THREE.Mesh(geometry, material);
}

export class SurveyDisplay {
  readonly group = new THREE.Group();
  private readonly reference = new THREE.Group();
  private readonly comparison = new THREE.Group();
  private readonly hit = pin([0, 0, 0], 0x89ecfa, 0.012);
  private readonly outline: THREE.LineLoop | THREE.Line;

  constructor(room: Room) {
    this.group.name = "vh-room-survey";
    this.group.visible = false;
    this.group.matrixAutoUpdate = false;
    this.hit.visible = false;
    this.outline = line(room.footprint.outer.map(([x, z]) => [x, room.floorElevation + 0.012, z]), REFERENCE, true);
    this.group.add(this.outline, this.reference, this.comparison, this.hit);
  }

  apply(matrix: THREE.Matrix4 | null) {
    this.group.visible = matrix !== null;
    if (!matrix) return;
    this.group.matrix.copy(matrix);
    this.group.matrixWorldNeedsUpdate = true;
  }

  showHit(position: Vec3 | null) {
    this.hit.visible = !!position;
    if (position) this.hit.position.fromArray(position);
  }

  showGeometry(geometry: RoomSurveyGeometry, bounds?: THREE.Box3) {
    clear(this.reference);
    if (bounds && !bounds.isEmpty()) this.reference.add(new THREE.Box3Helper(bounds, REFERENCE));
    const sampled: Vec3[] = [];
    for (const surface of geometry.surfaces) {
      if (surface.source === "manual" || surface.source === "hit-test") {
        sampled.push(...surface.points);
      } else {
        const mesh = translucentSurface(surface);
        if (mesh) this.reference.add(mesh);
        if (surface.source === "plane") this.reference.add(line(surface.points, REFERENCE, true));
      }
    }
    const measured = geometry.measurements.flatMap(({ a, b }) => [a, b]);
    if (measured.length) {
      const lines = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(measured.flat(), 3));
      this.reference.add(new THREE.LineSegments(lines, new THREE.LineBasicMaterial({ color: REFERENCE, depthWrite: false })));
      sampled.push(...measured);
    }
    if (sampled.length) {
      const positions = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(sampled.flat(), 3));
      this.reference.add(new THREE.Points(positions, new THREE.PointsMaterial({ color: REFERENCE, size: 0.035, sizeAttenuation: true })));
    }
  }

  compare(before: RoomSurveyPose | null, after?: RoomSurveyPose, shape?: SurveyObjectShape) {
    clear(this.comparison);
    if (!before) return;
    this.addPose(before, ORIGINAL, shape);
    if (after) {
      this.addPose(after, PROPOSED, shape);
      this.comparison.add(line([before.position, after.position], PROPOSED));
    }
  }

  private addPose(pose: RoomSurveyPose, color: number, shape?: SurveyObjectShape) {
    const angle = THREE.MathUtils.degToRad(pose.yawDeg);
    const direction = new THREE.Vector3(-Math.sin(angle), 0, -Math.cos(angle));
    const tip = new THREE.Vector3(...pose.position).addScaledVector(direction, 0.3).toArray();
    this.comparison.add(pin(pose.position, color), pin(tip, color, 0.017), line([pose.position, tip], color));
    const geometry = shape?.geometry.clone() ?? new THREE.BoxGeometry(0.18, 0.18, 0.18).translate(0, 0.09, 0);
    const material = new THREE.MeshBasicMaterial({ color, opacity: 0.3, transparent: true, depthWrite: false });
    const carrier = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    if (shape) mesh.scale.copy(shape.scale);
    mesh.rotation.x = shape?.tilt ?? 0;
    carrier.rotation.y = angle;
    carrier.position.fromArray(pose.position);
    carrier.add(mesh);
    this.comparison.add(carrier);
  }

  dispose() {
    this.group.removeFromParent();
    clear(this.group);
  }
}
