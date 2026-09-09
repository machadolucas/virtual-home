/**
 * Inferred manifest types plus the id aliases used throughout the viewer.
 *
 * The design note asked for *branded* ids. They are plain string aliases here: manifest data
 * arrives from zod as plain strings, and every id also travels through the URL, the DOM
 * (`data-*`), the store and the database, so a nominal brand would only add casts at every
 * boundary without catching a real class of bug (ids are never arithmetic and never mixed with
 * user text). The aliases still document intent at every signature. Deviation recorded in
 * `docs/model-contract.md`.
 */
import type { z } from "zod";
import type {
  AssetKindSchema,
  AssetSchema,
  BuildingSchema,
  CertaintySchema,
  CoordinateSystemSchema,
  ElementKindSchema,
  ElementSchema,
  FloorSchema,
  IssueSchema,
  IssueSeveritySchema,
  ManifestSchema,
  NodeRefSchema,
  RoomKindSchema,
  RoomSchema,
  SourceSchema,
  SurfaceKindSchema,
  SurfaceSchema,
} from "./schema";

export type Manifest = z.infer<typeof ManifestSchema>;
export type Building = z.infer<typeof BuildingSchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Element = z.infer<typeof ElementSchema>;
export type Surface = z.infer<typeof SurfaceSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Issue = z.infer<typeof IssueSchema>;
export type NodeRef = z.infer<typeof NodeRefSchema>;
export type CoordinateSystem = z.infer<typeof CoordinateSystemSchema>;

export type Certainty = z.infer<typeof CertaintySchema>;
export type RoomKind = z.infer<typeof RoomKindSchema>;
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;
export type ElementKind = z.infer<typeof ElementKindSchema>;
export type AssetKind = z.infer<typeof AssetKindSchema>;
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export type SurfaceId = string;
export type RoomId = string;
export type FloorId = string;
export type BuildingId = string;
export type ElementId = string;
export type AssetId = string;
export type PlacementId = string;
export type RouteId = string;

export type PlacementEntityRole =
  | "primary"
  | "status"
  | "control"
  | "power"
  | "battery_level"
  | "diagnostic"
  | "other";

/** Current HA identity and display metadata for one entity linked to placed equipment. */
export interface PlacementLinkedEntity {
  entityId: string;
  role: PlacementEntityRole;
  /** Whether this was linked directly or merely discovered through a whole-device link. */
  source?: "entity" | "device";
  name: string | null;
  deviceClass: string | null;
  unit: string | null;
}

/** Plain-tuple axis-aligned box. Kept three-free so framing stays unit-testable in Node. */
export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

/** Presentation grouping: a floor id, plus the two pseudo-groups the package needs. */
export type ExplodeGroup = string;
export const SITE_GROUP = "site";
export const ROOF_GROUP = "roof";

/** What the user has selected. Only ids ever enter the store. */
export type Selection =
  | { kind: "room"; id: RoomId }
  | { kind: "surface"; id: SurfaceId }
  | { kind: "element"; id: ElementId }
  | { kind: "floor"; id: FloorId }
  | { kind: "building"; id: BuildingId }
  | { kind: "equipment"; id: PlacementId }
  | { kind: "route"; id: RouteId }
  | { kind: "routePoint"; id: string }
  | { kind: "annotation"; id: string };

export type LayerId =
  | "structure"
  | "scanReferences"
  | "yard"
  | "outdoor"
  | "equipment"
  | "routes"
  | "annotations";

export const ALL_LAYERS: readonly LayerId[] = [
  "structure",
  "scanReferences",
  "yard",
  "outdoor",
  "equipment",
  "routes",
  "annotations",
];

export const DEFAULT_LAYERS: Record<LayerId, boolean> = {
  structure: false,
  scanReferences: false,
  yard: true,
  outdoor: true,
  equipment: true,
  // On, because it now controls something: while nothing read this flag the lines were drawn
  // anyway, so `false` described the screen incorrectly in the one direction that matters.
  routes: true,
  annotations: true,
};

/** A placed piece of equipment. Coordinates are always **physical** metres, never exploded. */
export interface Placement {
  id: PlacementId;
  modelId: string;
  equipmentId: string;
  name: string;
  position: Vec3;
  rotationYDeg: number;
  /** Physical beam direction; null/absent uses the fixture default. */
  lightAim?: { yawDeg: number; pitchDeg: number } | null;
  mount: PlacementMount;
  floorId: FloorId;
  roomId: RoomId | null;
  surfaceId: SurfaceId | null;
  locationNote: string;
  photoId: string | null;
  entityId: string | null;
  /** Every direct entity link. Optional while old/local placement caches age out. */
  linkedEntities?: PlacementLinkedEntity[];
  /** Chosen silhouette, or `null` to let the view infer one. See `scene/symbols.ts`. */
  symbol: string | null;
  /** The equipment's category, read-only — only used to infer a symbol when none was chosen. */
  category: string | null;
}

/**
 * How a placement is attached. All four kinds the database and the endpoint already accepted —
 * the workspace used to know only `floor` and `wall`, which is why an eave spot or anything on a
 * ceiling could not be expressed here even though the row could hold it.
 *
 * `height` means metres above the resolved room's own floor for `floor`/`wall`/`free`, and metres
 * *below* the surface for `ceiling` (the drop of a pendant, or the recess of a downlight).
 */
export type PlacementMount =
  | { kind: "floor"; height: number }
  | { kind: "wall"; surfaceId: SurfaceId; height: number; offset: number }
  | { kind: "ceiling"; surfaceId: SurfaceId; height: number; offset: number }
  | { kind: "free"; height: number; surfaceId?: SurfaceId };

export type RouteSystem =
  | "ventilation"
  | "water"
  | "electrical"
  | "network"
  | "heating"
  | "drainage"
  | "other";

export type RouteKind =
  | "duct"
  | "pipe"
  | "cable"
  | "valve"
  | "outlet"
  | "switch"
  | "junction"
  | "access-point"
  | "other";

export type RouteCertainty = "measured" | "observed" | "inferred" | "unknown";
export type RouteLifecycle = "planned" | "installed" | "removed";

export interface RouteEndpoint {
  kind: "equipment" | "surface" | "free";
  placementId?: PlacementId;
  surfaceId?: SurfaceId;
  uv?: Vec2;
}

export interface Route {
  id: RouteId;
  modelId: string;
  name: string;
  system: RouteSystem;
  kind: RouteKind;
  /** Physical site coordinates, metres. Presentation transforms are never stored. */
  points: Vec3[];
  /** One entry per span: `points.length - 1` entries. */
  segments: Array<{ floorId: FloorId | null; roomId: RoomId | null }>;
  certainty: RouteCertainty;
  lifecycle: RouteLifecycle;
  widthM?: number;
  diameterM?: number;
  depthM?: number;
  offsetFrom?: { surfaceId: SurfaceId; kind: "wall" | "floor" | "ceiling"; offsetM: number };
  endpoints: RouteEndpoint[];
  installedAt?: string;
  removedAt?: string;
  renovationId?: string;
  photoIds: string[];
  note?: string;
}

export type ViewMode = "overview" | "floor" | "plan" | "section";
export type Projection = "perspective" | "ortho";
/** Sims-style shell presentation, kept separate from camera and floor focus. */
export type WallMode = "cut" | "contextual" | "up" | "closed";

export interface VerticalCut {
  axis: "x" | "z";
  v: number;
  sign: 1 | -1;
}

export interface LoadPhaseCounts {
  loaded: number;
  total: number;
}

export type LoadPhase =
  | "idle"
  | "validating"
  | "loading"
  | "interactive"
  | "enriching"
  | "ready"
  | "degraded"
  | "failed";
