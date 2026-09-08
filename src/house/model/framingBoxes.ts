/**
 * Camera framing boxes, computed from the **manifest** rather than from geometry bounds, so
 * framing is deterministic, unit-testable and unaffected by which assets happen to be loaded.
 *
 * Returns plain `{min, max}` tuples: this module stays three-free. `scene/framing.ts` converts to
 * `THREE.Box3`.
 */
import type { Box, BuildingId, FloorId, Placement, Room, Route, Vec3 } from "./types";
import type { ManifestIndex } from "./manifestIndex";

/** Wall-thickness allowance, metres. */
export const FRAME_PAD = 0.35;

export const emptyBox = (): Box => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export const isEmptyBox = (b: Box): boolean =>
  !(b.min[0] <= b.max[0] && b.min[1] <= b.max[1] && b.min[2] <= b.max[2]);

export function boxUnion(a: Box, b: Box): Box {
  if (isEmptyBox(a)) return cloneBox(b);
  if (isEmptyBox(b)) return cloneBox(a);
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export const cloneBox = (b: Box): Box => ({ min: [...b.min], max: [...b.max] });

export function expandBox(b: Box, by: number): Box {
  if (isEmptyBox(b)) return cloneBox(b);
  return {
    min: [b.min[0] - by, b.min[1] - by, b.min[2] - by],
    max: [b.max[0] + by, b.max[1] + by, b.max[2] + by],
  };
}

export function boxCenter(b: Box): Vec3 {
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function boxFromCenterAndSize(center: Vec3, size: Vec3): Box {
  return {
    min: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    max: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
  };
}

/**
 * Room box from the footprint ring and the room's **own** floor elevation.
 * `room.floorElevation`, never `floor.elevation`: the living room sits at -0.30 while its floor
 * datum is 0.00, and framing/snapping must honour that.
 */
export function roomBox(room: Room, pad = FRAME_PAD): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of room.footprint.outer) {
    const x = p[0];
    const z = p[1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const y0 = room.floorElevation;
  const y1 = y0 + (room.ceilingHeight ?? 2.5);
  return { min: [x0 - pad, y0 - 0.05, z0 - pad], max: [x1 + pad, y1 + 0.05, z1 + pad] };
}

export function floorBox(index: ManifestIndex, floorId: FloorId): Box {
  let b = emptyBox();
  for (const r of index.roomsByFloor.get(floorId) ?? []) b = boxUnion(b, roomBox(r));
  if (!isEmptyBox(b)) return b;
  // Floors with no rooms fall back to the union of the assets the manifest assigns to them.
  const floor = index.floors.get(floorId);
  for (const aid of floor?.assetIds ?? []) {
    const bounds = index.assets.get(aid)?.bounds;
    if (bounds?.min && bounds.max) b = boxUnion(b, { min: bounds.min, max: bounds.max });
  }
  return b;
}

export function buildingBox(index: ManifestIndex, buildingId: BuildingId): Box {
  let b = emptyBox();
  for (const a of index.assetsByBuilding.get(buildingId) ?? []) {
    if (a.kind === "scan-reference") continue;
    if (a.bounds?.min && a.bounds.max) b = boxUnion(b, { min: a.bounds.min, max: a.bounds.max });
  }
  return b;
}

export function propertyBox(index: ManifestIndex): Box {
  return { min: [...index.manifest.bounds.min], max: [...index.manifest.bounds.max] };
}

/** Enough context around a marker to read the room it is in. */
export function equipmentBox(p: Pick<Placement, "position">, size = 1.6): Box {
  return boxFromCenterAndSize(p.position, [size, size, size]);
}

export function routeBox(r: Pick<Route, "points">): Box {
  let b = emptyBox();
  for (const p of r.points) b = boxUnion(b, { min: [...p], max: [...p] });
  return expandBox(b, 0.5);
}

export function surfaceBox(index: ManifestIndex, surfaceId: string): Box {
  const s = index.surfaces.get(surfaceId);
  if (!s) return emptyBox();
  if (s.roomId) {
    const r = index.rooms.get(s.roomId);
    if (r) return roomBox(r);
  }
  const first = s.nodeRefs[0];
  if (first) {
    const bounds = index.assets.get(first.assetId)?.bounds;
    if (bounds?.min && bounds.max) return { min: bounds.min, max: bounds.max };
  }
  return emptyBox();
}

/** Plan-view fit box: the floor's rooms expanded for wall thickness. */
export function planBox(index: ManifestIndex, floorId: FloorId): Box {
  return expandBox(floorBox(index, floorId), 0.4);
}

/** Cut range for the cutaway slider, derived from the manifest bounds. */
export function cutRange(index: ManifestIndex): { min: number; max: number } {
  const b = index.manifest.bounds;
  return { min: Math.floor((b.min[1] - 0.5) * 10) / 10, max: Math.ceil((b.max[1] + 0.3) * 10) / 10 };
}
