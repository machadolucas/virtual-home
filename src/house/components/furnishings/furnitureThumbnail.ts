import * as THREE from "three";
import { FURNISHING_CATALOG } from "@/house/model/furnishingCatalog";
import type { FurnishingKind } from "@/house/model/types";
import { furnishingGeometry } from "@/house/scene/furnishingGeometry";

export interface ThumbnailTriangle {
  /** SVG points in a 100 × 72 view box. */
  points: string;
  /** Painter-order depth, farthest triangles first. */
  depth: number;
  /** Diffuse-light strength used to distinguish the procedural model's faces. */
  light: number;
}

const CAMERA = new THREE.Vector3(1.8, 1.45, -2.1);
const TARGET = new THREE.Vector3(0, 0.45, 0);
const LIGHT = new THREE.Vector3(-0.35, 0.8, -0.48).normalize();
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 72;
const PADDING = 5;

interface ProjectedVertex {
  x: number;
  y: number;
  depth: number;
  world: THREE.Vector3;
}

/**
 * Project the scene's shared, immutable procedural geometry into an SVG-sized isometric view.
 * The geometry is read only: callers must never dispose or transform the cached instance.
 */
export function projectFurnishingThumbnail(kind: FurnishingKind): ThumbnailTriangle[] {
  const geometry = furnishingGeometry(kind);
  const dimensions = FURNISHING_CATALOG.find((item) => item.kind === kind)!.size;
  const size = new THREE.Vector3(dimensions[0], dimensions[2], dimensions[1]);
  const positions = geometry.getAttribute("position");
  if (!positions || positions.count === 0) return [];

  const forward = TARGET.clone().sub(CAMERA).normalize();
  const right = forward.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
  const up = right.clone().cross(forward).normalize();
  const projected: ProjectedVertex[] = [];
  for (let index = 0; index < positions.count; index += 1) {
    const world = new THREE.Vector3().fromBufferAttribute(positions, index).multiply(size);
    const relative = world.clone().sub(TARGET);
    projected.push({
      x: relative.dot(right),
      y: relative.dot(up),
      depth: relative.dot(forward),
      world,
    });
  }

  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const scale = Math.min(
    (VIEW_WIDTH - PADDING * 2) / Math.max(maxX - minX, Number.EPSILON),
    (VIEW_HEIGHT - PADDING * 2) / Math.max(maxY - minY, Number.EPSILON),
  );
  const offsetX = (VIEW_WIDTH - (maxX - minX) * scale) / 2 - minX * scale;
  const offsetY = (VIEW_HEIGHT - (maxY - minY) * scale) / 2 + maxY * scale;

  const triangles: ThumbnailTriangle[] = [];
  const indices = geometry.index;
  const cornerCount = indices?.count ?? positions.count;
  for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
    const ia = indices?.getX(corner) ?? corner;
    const ib = indices?.getX(corner + 1) ?? corner + 1;
    const ic = indices?.getX(corner + 2) ?? corner + 2;
    const a = projected[ia];
    const b = projected[ib];
    const c = projected[ic];
    if (!a || !b || !c) continue;

    const edgeA = b.world.clone().sub(a.world);
    const edgeB = c.world.clone().sub(a.world);
    const normal = edgeA.cross(edgeB).normalize();
    const center = a.world.clone().add(b.world).add(c.world).multiplyScalar(1 / 3);
    if (normal.dot(CAMERA.clone().sub(center)) <= 0) continue;

    triangles.push({
      points: [a, b, c]
        .map((point) => `${round(point.x * scale + offsetX)},${round(offsetY - point.y * scale)}`)
        .join(" "),
      depth: (a.depth + b.depth + c.depth) / 3,
      light: Math.max(0.34, Math.min(1, 0.52 + normal.dot(LIGHT) * 0.48)),
    });
  }

  return triangles.sort((a, b) => b.depth - a.depth);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
