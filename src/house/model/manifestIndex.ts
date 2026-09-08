/**
 * `ManifestIndex` — the id → record maps every other module reads. Built once per manifest.
 *
 * Everything is keyed by manifest ids. Node names are only ever used as `(assetId, nodeName)`
 * pairs, because floor node names demonstrably recur across assets (`f-upper` lives in
 * `house-upper`, `house-roof`, `house-structure` and `scan-reference-upper`).
 */
import { poleOfInaccessibility } from "./geometry2d";
import type {
  Asset,
  AssetId,
  Building,
  BuildingId,
  Element,
  ElementId,
  Floor,
  FloorId,
  Issue,
  Manifest,
  Room,
  RoomId,
  Surface,
  SurfaceId,
  SurfaceKind,
  Vec3,
} from "./types";

/** Room-facing surface kinds. `role` is deliberately **not** used — see `docs/model-contract.md`. */
export const ROOM_SURFACE_KINDS: ReadonlySet<SurfaceKind> = new Set(["floor", "wall", "ceiling"]);

export const nodeKey = (assetId: AssetId, nodeName: string): string => `${assetId}/${nodeName}`;

export interface RoomAnchor {
  /** Pole of inaccessibility of the footprint (never outside a concave ring). */
  point: Vec3;
  clearance: number;
}

export interface ManifestIndex {
  manifest: Manifest;
  modelId: string;

  buildings: Map<BuildingId, Building>;
  floors: Map<FloorId, Floor>;
  rooms: Map<RoomId, Room>;
  assets: Map<AssetId, Asset>;
  elements: Map<ElementId, Element>;
  surfaces: Map<SurfaceId, Surface>;
  issues: Map<string, Issue>;

  floorOrder: FloorId[];
  roomsByFloor: Map<FloorId, Room[]>;
  floorsByBuilding: Map<BuildingId, Floor[]>;
  assetsByBuilding: Map<BuildingId, Asset[]>;
  assetsByFloor: Map<FloorId, Asset[]>;
  defaultAssetIds: AssetId[];

  /** Room-facing surfaces only (`kind ∈ {floor, wall, ceiling}`), in manifest order. */
  roomSurfaces: Map<RoomId, SurfaceId[]>;
  roomSurfacesByKind: Map<string, SurfaceId[]>;
  surfacesByElement: Map<ElementId, SurfaceId[]>;
  surfacesByAsset: Map<AssetId, SurfaceId[]>;
  /** `assetId/nodeName` → surfaceId. */
  surfaceByNode: Map<string, SurfaceId>;
  /** `assetId/nodeName` → elementId (the element's own group node). */
  elementByNode: Map<string, ElementId>;
  /** floorId of a surface, resolved via room → floor, else element → floor. */
  floorOfSurface: Map<SurfaceId, FloorId | null>;
  ceilingSurfaceIds: SurfaceId[];
  issuesByAffected: Map<string, Issue[]>;

  roomAnchors: Map<RoomId, RoomAnchor>;
}

export function buildManifestIndex(manifest: Manifest): ManifestIndex {
  const buildings = new Map(manifest.buildings.map((b) => [b.id, b]));
  const floors = new Map(manifest.floors.map((f) => [f.id, f]));
  const rooms = new Map(manifest.rooms.map((r) => [r.id, r]));
  const assets = new Map(manifest.assets.map((a) => [a.id, a]));
  const elements = new Map(manifest.elements.map((e) => [e.id, e]));
  const surfaces = new Map(manifest.surfaces.map((s) => [s.id, s]));
  const issues = new Map(manifest.issues.map((i) => [i.id, i]));

  const roomsByFloor = new Map<FloorId, Room[]>();
  for (const r of manifest.rooms) push(roomsByFloor, r.floorId, r);

  const floorsByBuilding = new Map<BuildingId, Floor[]>();
  for (const f of manifest.floors) push(floorsByBuilding, f.buildingId, f);

  const assetsByBuilding = new Map<BuildingId, Asset[]>();
  const assetsByFloor = new Map<FloorId, Asset[]>();
  for (const a of manifest.assets) {
    if (a.buildingId) push(assetsByBuilding, a.buildingId, a);
    if (a.floorId) push(assetsByFloor, a.floorId, a);
  }

  const roomSurfaces = new Map<RoomId, SurfaceId[]>();
  const surfacesByElement = new Map<ElementId, SurfaceId[]>();
  const surfacesByAsset = new Map<AssetId, SurfaceId[]>();
  const surfaceByNode = new Map<string, SurfaceId>();
  const ceilingSurfaceIds: SurfaceId[] = [];

  for (const s of manifest.surfaces) {
    if (s.roomId && ROOM_SURFACE_KINDS.has(s.kind)) push(roomSurfaces, s.roomId, s.id);
    if (s.elementId) push(surfacesByElement, s.elementId, s.id);
    for (const nr of s.nodeRefs) {
      surfaceByNode.set(nodeKey(nr.assetId, nr.nodeName), s.id);
      push(surfacesByAsset, nr.assetId, s.id);
    }
    if (s.kind === "ceiling") ceilingSurfaceIds.push(s.id);
  }

  const elementByNode = new Map<string, ElementId>();
  for (const e of manifest.elements) {
    const own = e.nodeRefs[0];
    if (own) elementByNode.set(nodeKey(own.assetId, own.nodeName), e.id);
  }

  const floorOfSurface = new Map<SurfaceId, FloorId | null>();
  for (const s of manifest.surfaces) {
    let fid: FloorId | null = null;
    if (s.roomId) fid = rooms.get(s.roomId)?.floorId ?? null;
    if (!fid && s.elementId) fid = elements.get(s.elementId)?.floorId ?? null;
    floorOfSurface.set(s.id, fid);
  }

  // Per-kind room surface lists, cached under `${roomId}|${kind}`.
  const roomSurfacesByKind = new Map<string, SurfaceId[]>();
  for (const s of manifest.surfaces) {
    if (!s.roomId || !ROOM_SURFACE_KINDS.has(s.kind)) continue;
    push(roomSurfacesByKind, `${s.roomId}|${s.kind}`, s.id);
  }

  const issuesByAffected = new Map<string, Issue[]>();
  for (const i of manifest.issues) for (const id of i.affects) push(issuesByAffected, id, i);

  const roomAnchors = new Map<RoomId, RoomAnchor>();
  for (const r of manifest.rooms) {
    const { point, clearance } = poleOfInaccessibility(r.footprint);
    const lift = Math.min((r.ceilingHeight ?? 2.5) * 0.6, 1.6);
    roomAnchors.set(r.id, { point: [point[0], r.floorElevation + lift, point[1]], clearance });
  }

  const floorOrder = [...manifest.floors]
    .sort((a, b) => a.elevation - b.elevation)
    .map((f) => f.id);

  return {
    manifest,
    modelId: manifest.modelId,
    buildings,
    floors,
    rooms,
    assets,
    elements,
    surfaces,
    issues,
    floorOrder,
    roomsByFloor,
    floorsByBuilding,
    assetsByBuilding,
    assetsByFloor,
    defaultAssetIds: manifest.assets.filter((a) => a.loadByDefault).map((a) => a.id),
    roomSurfaces,
    roomSurfacesByKind,
    surfacesByElement,
    surfacesByAsset,
    surfaceByNode,
    elementByNode,
    floorOfSurface,
    ceilingSurfaceIds,
    issuesByAffected,
    roomAnchors,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Room-facing surfaces of a room, optionally narrowed to one kind. */
export function roomSurfaceIds(
  index: ManifestIndex,
  roomId: RoomId,
  kind?: SurfaceKind,
): SurfaceId[] {
  if (kind) return index.roomSurfacesByKind.get(`${roomId}|${kind}`) ?? [];
  return index.roomSurfaces.get(roomId) ?? [];
}

/** The room whose footprint contains (x, z) on a given floor, holes respected. */
export function roomAt(
  index: ManifestIndex,
  floorId: FloorId,
  x: number,
  z: number,
): RoomId | null {
  for (const r of index.roomsByFloor.get(floorId) ?? []) {
    if (pointInside(r, x, z)) return r.id;
  }
  return null;
}

function pointInside(room: Room, x: number, z: number): boolean {
  // Imported lazily-inlined to keep this module's dependency list at one geometry helper.
  const { outer, holes } = room.footprint;
  return pointInFootprintLocal(x, z, outer, holes);
}

// Local copy of the even-odd test so `manifestIndex` does not re-export geometry internals.
function pointInFootprintLocal(
  x: number,
  z: number,
  outer: ReadonlyArray<[number, number]>,
  holes: ReadonlyArray<ReadonlyArray<[number, number]>>,
): boolean {
  if (!inRing(x, z, outer)) return false;
  for (const h of holes) if (inRing(x, z, h)) return false;
  return true;
}

function inRing(x: number, z: number, ring: ReadonlyArray<[number, number]>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i] as [number, number];
    const b = ring[j] as [number, number];
    if (a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
