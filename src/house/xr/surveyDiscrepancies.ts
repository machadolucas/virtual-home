import { MathUtils, Matrix4, Scene, Vector3, type Object3D } from "three";
import { pointInFootprint } from "../model/geometry2d";
import type { Furnishing, Room, Vec3 } from "../model/types";
import type { RoomSurveyComparison, RoomSurveyGeometry } from "../roomSurveyTypes";
import type { SceneIndex } from "../scene/SceneIndex";
import { explodeTargets, offsetsFor, type ExplodeState } from "../scene/explode";

const MAX_OFFSET = 0.5;
const MIN_OFFSET = 0.05;
const MIN_FACE = 0.24;
const MESH_SAMPLE = 4000;
type Target = RoomSurveyComparison["target"];
type FaceKind = "wall" | "floor" | "ceiling";
interface Face {
  points: Vector3[];
  normal: Vector3;
  source: number;
  label?: string;
}
export interface ModelFace extends Face {
  id: string;
  kind: FaceKind;
  label: string;
}
export interface SurveyDiscrepancy {
  comparison: RoomSurveyComparison;
  position: Vec3;
}
interface Candidate extends SurveyDiscrepancy {
  score: number;
}
type Range = [number, number];
type OutlineBounds = [Range, Range];

function extent(values: number[]): Range {
  let min = Infinity, max = -Infinity;
  for (const n of values) { min = Math.min(min, n); max = Math.max(max, n); }
  return [min, max];
}
const size = ([a, b]: Range) => b - a;
const middle = ([a, b]: Range) => (a + b) / 2;
const overlap = (a: Range, b: Range): Range => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];
const centre = (outline: Vec3[]) => outline.reduce((v, p) => v.add(new Vector3(...p)), new Vector3())
  .divideScalar(outline.length).toArray();

function normalFor(points: Vector3[]): Vector3 | null {
  const origin = points[0];
  if (!origin) return null;
  let edge = new Vector3(), longest = 0;
  for (const point of points) {
    const length = origin.distanceToSquared(point);
    if (length > longest) { longest = length; edge = point.clone().sub(origin); }
  }
  let normal = new Vector3(), area = 0;
  for (const point of points) {
    const cross = edge.clone().cross(point.clone().sub(origin));
    if (cross.lengthSq() > area) { normal = cross; area = cross.lengthSq(); }
  }
  if (area < 0.0001) return null;
  normal.normalize();
  const major = [normal.x, normal.y, normal.z].sort((a, b) => Math.abs(b) - Math.abs(a))[0]!;
  return normal.multiplyScalar(Math.sign(major));
}

function axes(normal: Vector3): [Vector3, Vector3] {
  const up = Math.abs(normal.y) < 0.75 ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);
  const u = up.cross(normal).normalize();
  return [u, normal.clone().cross(u).normalize()];
}

function bounds(points: Vector3[], u: Vector3, v: Vector3): OutlineBounds {
  return [extent(points.map((p) => p.dot(u))), extent(points.map((p) => p.dot(v)))];
}

function rectangle([a, b]: OutlineBounds, u: Vector3, v: Vector3, origin: Vector3): Vec3[] {
  const make = (x: number, y: number) => origin.clone().addScaledVector(u, x).addScaledVector(v, y).toArray();
  return [make(a[0], b[0]), make(a[1], b[0]), make(a[1], b[1]), make(a[0], b[1])];
}

/** Authored primitive coordinates, excluding the floor presentation offset. */
export function modelSurveyFaces(index: SceneIndex, roomId: string, explode: ExplodeState): ModelFace[] {
  const roots = new Set<Object3D>([...index.assets.values()].map(({ root }) => root));
  const presentation = new Map<Object3D, number>();
  if (explode.enabled) {
    const offsets = offsetsFor(index, explode);
    for (const [group, nodes] of explodeTargets(index))
      for (const node of nodes) presentation.set(node, offsets.get(group) ?? 0);
  }
  const result: ModelFace[] = [];
  const counts = new Map<FaceKind, number>();
  for (const id of index.manifest.roomSurfaces.get(roomId) ?? []) {
    const mesh = index.surfaceMesh.get(id);
    const surface = index.manifest.surfaces.get(id);
    const kind = surface?.kind;
    if ((kind !== "wall" && kind !== "floor" && kind !== "ceiling") || !mesh) continue;
    const positions = mesh.geometry.getAttribute("position");
    if (!positions) continue;
    const pose = new Matrix4();
    for (let node: Object3D | null = mesh; node && !(node instanceof Scene); node = node.parent) {
      if (node.matrixAutoUpdate) node.updateMatrix();
      const step = node.matrix.clone();
      step.elements[13]! -= presentation.get(node) ?? 0;
      pose.premultiply(step);
      if (roots.has(node)) break;
    }
    const points: Vector3[] = [];
    const stride = Math.max(1, Math.ceil(positions.count / 800));
    for (let i = 0; i < positions.count; i += stride) points.push(new Vector3().fromBufferAttribute(positions, i).applyMatrix4(pose));
    const normal = normalFor(points);
    if (!normal || (kind === "wall" ? Math.abs(normal.y) > 0.1 : Math.abs(normal.y) < 0.99)) continue;
    if (size(extent(points.map((p) => p.dot(normal)))) > 0.04) continue;
    const number = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, number);
    result.push({ id, kind, label: kind === "wall" ? `Wall ${number}` : kind === "floor" ? "Floor" : "Ceiling",
      normal, points, source: -1 });
  }
  return result;
}

function meshFaces(points: Vec3[], indices: number[], source: number, budget: number): Face[] {
  const bins = new Map<string, { points: Vector3[]; area: number; normal: Vector3 }>();
  const step = Math.max(1, Math.ceil(indices.length / 3 / budget));
  for (let i = 0; i < indices.length; i += step * 3) {
    const a = points[indices[i]!], b = points[indices[i + 1]!], c = points[indices[i + 2]!];
    if (!a || !b || !c) continue;
    const vertices = [new Vector3(...a), new Vector3(...b), new Vector3(...c)];
    const normal = normalFor(vertices);
    if (!normal || (Math.abs(normal.y) > 0.12 && Math.abs(normal.y) < 0.985)) continue;
    const key = [...normal.toArray().map((value) => Math.round(value * 15)), Math.round(normal.dot(vertices[0]!) * 25)].join("/");
    const area = vertices[1]!.clone().sub(vertices[0]!).cross(vertices[2]!.clone().sub(vertices[0]!)).length() / 2;
    const bin = bins.get(key);
    if (bin) {
      bin.area += area;
      bin.points.push(...vertices);
    } else if (bins.size < 640) {
      bins.set(key, { area, points: vertices, normal });
    }
  }
  return [...bins.values()].filter((bin) => bin.area >= 0.18)
    .sort((a, b) => b.area - a.area).slice(0, 35)
    .map(({ points, normal }) => ({ points, normal, source }));
}

function scannedFaces(geometry: RoomSurveyGeometry): Face[] {
  const faces: Face[] = [];
  // A headset may supply many meshes. Divide the triangle budget among them.
  const meshes = geometry.surfaces.filter((s) => s.source === "mesh").length;
  geometry.surfaces.forEach((surface, source) => {
    if (surface.source === "plane") {
      const stride = Math.max(1, Math.ceil(surface.points.length / 800));
      const points = surface.points.filter((_, i) => i % stride === 0).map((p) => new Vector3(...p));
      const normal = normalFor(points);
      if (normal) faces.push({ points, normal, source, label: surface.label });
    } else if (surface.source === "mesh" && surface.indices) {
      faces.push(...meshFaces(surface.points, surface.indices, source, Math.max(200, Math.floor(MESH_SAMPLE / meshes))));
    }
  });
  return faces;
}

function proposal(target: Target, label: string, face: Face, scanOutline: Vec3[], modelOutline: Vec3[],
  offsetM: number, scanUncertaintyM: number, score: number): Candidate | null {
  if (offsetM > MAX_OFFSET) return null;
  return { score, position: centre(scanOutline),
    comparison: { target, label, sourceSurface: face.source, scanOutline, modelOutline, offsetM, scanUncertaintyM } };
}

const structureLabel = /^(wall|floor|ceiling|unknown|global mesh|global_mesh)$/i;

function compareSurface(scan: Face, model: ModelFace): Candidate | null {
  if (scan.label && !structureLabel.test(scan.label)) return null;
  if (scan.label && /^(wall|floor|ceiling)$/i.test(scan.label) && scan.label.toLowerCase() !== model.kind) return null;
  if (Math.abs(scan.normal.dot(model.normal)) < 0.995) return null;
  const { normal } = model;
  const [u, v] = axes(normal);
  const scanBounds = bounds(scan.points, u, v), modelBounds = bounds(model.points, u, v);
  const shared: OutlineBounds = [overlap(scanBounds[0], modelBounds[0]), overlap(scanBounds[1], modelBounds[1])];
  if (shared.some((range, i) => size(range) < MIN_FACE || size(range) < 0.55 * Math.min(size(scanBounds[i]!), size(modelBounds[i]!)))) return null;
  if (!scan.label && shared.some((range, i) => size(range) < 0.58 * size(modelBounds[i]!))) return null;
  const scanned = extent(scan.points.map((p) => p.dot(normal)));
  const modeled = extent(model.points.map((p) => p.dot(normal)));
  const scanUncertaintyM = Math.max(0.02, (size(scanned) + size(modeled)) / 2);
  if (scanUncertaintyM > 0.075) return null;
  const offsetM = Math.abs(middle(scanned) - middle(modeled));
  return proposal({ kind: "surface", id: model.id }, model.label, scan,
    rectangle(shared, u, v, normal.clone().multiplyScalar(middle(scanned))),
    rectangle(shared, u, v, normal.clone().multiplyScalar(middle(modeled))),
    offsetM, scanUncertaintyM, offsetM);
}

const sensedFurniture: Record<string, Furnishing["kind"][]> = {
  couch: ["sofa", "sofa_l"], sofa: ["sofa", "sofa_l"], bed: ["bed_single", "bed_double"],
  table: ["dining_table", "bedside_table", "computer_desk"], desk: ["computer_desk"],
  chair: ["chair", "stool"], cabinet: ["cabinet", "shelves"],
};

function compareFurniture(scan: Face, item: Furnishing, room: Room): Candidate | null {
  const kind = scan.label?.toLowerCase();
  if (!kind || !sensedFurniture[kind]?.includes(item.kind) || Math.abs(scan.normal.y) < 0.985) return null;
  const angle = MathUtils.degToRad(item.rotationYDeg);
  const u = new Vector3(Math.cos(angle), 0, -Math.sin(angle)), v = new Vector3(Math.sin(angle), 0, Math.cos(angle));
  const scanned = bounds(scan.points, u, v);
  const [w, d] = scanned.map(size) as [number, number];
  const fit = Math.max(Math.abs(w - item.widthM), Math.abs(d - item.depthM));
  if (fit > 0.22 || w < MIN_FACE || d < MIN_FACE) return null;
  const scanY = extent(scan.points.map((p) => p.y));
  if (size(scanY) > 0.05 || Math.abs(middle(scanY) - (item.position[1] + item.heightM)) > 0.22) return null;
  const origin = new Vector3(0, middle(scanY), 0);
  const scanOutline = rectangle(scanned, u, v, origin);
  const point = centre(scanOutline);
  if (!pointInFootprint(point[0], point[2], room.footprint)) return null;
  const offsetM = Math.hypot(point[0] - item.position[0], point[2] - item.position[2]);
  const modelOutline = rectangle([[-item.widthM / 2, item.widthM / 2], [-item.depthM / 2, item.depthM / 2]], u, v,
    new Vector3(item.position[0], item.position[1] + item.heightM, item.position[2]));
  return proposal({ kind: "furnishing", id: item.id }, item.name, scan, scanOutline, modelOutline,
    offsetM, Math.max(0.035, fit / 2), offsetM + fit / 3);
}

export function suggestSurveyDiscrepancies(geometry: RoomSurveyGeometry, room: Room, faces: ModelFace[],
  furnishings: Furnishing[], registrationErrorM: number): SurveyDiscrepancy[] {
  const candidateFor = (scan: Face): Candidate[] => {
    const candidates = [...faces.map((face) => compareSurface(scan, face)),
      ...furnishings.map((item) => compareFurniture(scan, item, room))]
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort((a, b) => a.score - b.score);
    const [best, second] = candidates;
    return best && (!second || second.score - best.score > 0.06) ? [best] : [];
  };
  const candidates = scannedFaces(geometry).flatMap(candidateFor).sort((a, b) => a.score - b.score);
  const nearest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const { target } = candidate.comparison;
    const key = `${target.kind}:${target.id}`;
    if (!nearest.has(key)) nearest.set(key, candidate);
  }
  return [...nearest.values()].filter(({ comparison }) => comparison.offsetM >= MIN_OFFSET &&
    comparison.offsetM > registrationErrorM + comparison.scanUncertaintyM + 0.015).sort((a, b) =>
    (b.comparison.offsetM - b.comparison.scanUncertaintyM) - (a.comparison.offsetM - a.comparison.scanUncertaintyM))
    .slice(0, 5).map(({ comparison, position }) => ({ comparison, position }));
}
