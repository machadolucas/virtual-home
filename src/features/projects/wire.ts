/**
 * The wire contract for the infrastructure endpoints — one definition, used by the route handlers
 * to validate and by `src/house/store/dataApi.ts` to build requests, so the two cannot drift.
 *
 * Two shapes on purpose:
 *
 *  - **write** shapes are persistence-shaped (`medium`, `installedOn`, `points[].floorId`) because
 *    the database is what a write has to satisfy;
 *  - **DTO** shapes are the workspace's own `Route` / annotation types plus the columns the client
 *    type has no field for, so the 3D view can render a response without translation and the
 *    inspector can still show and edit the extra facts.
 *
 * The enum literals are duplicated from `@/db/schema/infrastructure` rather than imported, because
 * this module is loaded in the browser and importing the schema would pull drizzle into the client
 * bundle. The duplication is checked at compile time below, so drift is a type error.
 */
import { z } from "zod";
import type {
  AnnotationKind,
  AnnotationTargetKind,
  InfraCertainty,
  InfraEndpointKind,
  InfraLifecycle,
  InfraMedium,
  InfraPointKind,
  ProjectKind,
  ProjectLinkEntityKind,
  ProjectStatus,
} from "@/db/schema/infrastructure";
import type { Route, RouteSystem } from "@/house/model/types";

// ---------------------------------------------------------------------------
// enums (mirrored from the schema, checked against it at compile time)
// ---------------------------------------------------------------------------

export const MEDIA = [
  "cold_water",
  "hot_water",
  "waste",
  "supply_air",
  "extract_air",
  "electricity",
  "ethernet",
  "fiber",
  "coax",
  "gas",
  "heating_water",
  "drain",
] as const;

export const CERTAINTIES = ["measured", "observed", "inferred", "unknown"] as const;
export const LIFECYCLES = ["planned", "installed", "removed"] as const;
export const POINT_KINDS = ["vertex", "junction", "valve", "outlet", "penetration"] as const;
export const ENDPOINT_KINDS = [
  "source",
  "terminal",
  "junction",
  "meter",
  "shutoff",
  "panel",
  "patch_port",
] as const;
export const ANNOTATION_TARGETS = ["location", "asset", "route", "node"] as const;
export const ANNOTATION_KINDS = [
  "note",
  "measurement",
  "warning",
  "todo",
  "photo_point",
] as const;
export const ROUTE_SYSTEMS = [
  "ventilation",
  "water",
  "electrical",
  "network",
  "heating",
  "drainage",
  "other",
] as const;
export const PROJECT_KINDS = [
  "renovation",
  "repair",
  "installation",
  "inspection",
  "improvement",
] as const;
export const PROJECT_STATUSES = ["idea", "planned", "in_progress", "done", "abandoned"] as const;
export const PROJECT_LINK_KINDS = [
  "asset",
  "location",
  "system",
  "occurrence",
  "completion",
  "service_document",
  "part",
  "infra_route",
] as const;

/**
 * Compile-time proof that the arrays above list *every* value the schema allows. `Exclude<...>`
 * collapses to `never` only when nothing is missing, so adding a medium to the schema and
 * forgetting it here fails `tsc` instead of failing a request at runtime.
 */
type Complete<Schema extends string, Mirror extends string> = [Exclude<Schema, Mirror>] extends [
  never,
]
  ? true
  : { missing: Exclude<Schema, Mirror> };
const _complete: {
  media: Complete<InfraMedium, (typeof MEDIA)[number]>;
  certainty: Complete<InfraCertainty, (typeof CERTAINTIES)[number]>;
  lifecycle: Complete<InfraLifecycle, (typeof LIFECYCLES)[number]>;
  pointKind: Complete<InfraPointKind, (typeof POINT_KINDS)[number]>;
  endpointKind: Complete<InfraEndpointKind, (typeof ENDPOINT_KINDS)[number]>;
  annotationTarget: Complete<AnnotationTargetKind, (typeof ANNOTATION_TARGETS)[number]>;
  annotationKind: Complete<AnnotationKind, (typeof ANNOTATION_KINDS)[number]>;
  system: Complete<RouteSystem, (typeof ROUTE_SYSTEMS)[number]>;
  projectKind: Complete<ProjectKind, (typeof PROJECT_KINDS)[number]>;
  projectStatus: Complete<ProjectStatus, (typeof PROJECT_STATUSES)[number]>;
  projectLink: Complete<ProjectLinkEntityKind, (typeof PROJECT_LINK_KINDS)[number]>;
} = {
  media: true,
  certainty: true,
  lifecycle: true,
  pointKind: true,
  endpointKind: true,
  annotationTarget: true,
  annotationKind: true,
  system: true,
  projectKind: true,
  projectStatus: true,
  projectLink: true,
};
void _complete;

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/** A semantic id from the model package (`r-g-kitchen`, `s-w-l-ab--r-l-a`). */
export const ManifestIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
/** A database primary key (UUIDv7) or any id a client legitimately chose. */
export const RowIdSchema = z.string().min(1).max(64);
export const LocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Finite = z.number().finite();
export const PositionSchema = z.tuple([Finite, Finite, Finite]);

/**
 * The presentation state the coordinates were read in. A free-form string rather than a literal so
 * a wrong value is a deliberate `422 presentation_view_mode` instead of a generic schema error
 * (`docs/model-contract.md` §3.2).
 */
export const ViewModeSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

export const RoutePointWriteSchema = z.object({
  /** Physical site metres. Rounded to millimetres on write. */
  position: PositionSchema,
  pointKind: z.enum(POINT_KINDS).default("vertex"),
  /** The floor/room of the span that starts at this point. */
  floorId: ManifestIdSchema.nullish(),
  roomId: ManifestIdSchema.nullish(),
  modelNodeId: ManifestIdSchema.nullish(),
  /** Equipment this point sits on (a valve, an outlet). */
  assetId: RowIdSchema.nullish(),
});

export const RouteWriteSchema = z.object({
  /** Absent = a new route. */
  id: RowIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  /**
   * The workspace's presentation category. When `medium` is absent the server derives it, keeping
   * the row's existing medium if it still belongs to this system (see `infraMedium.ts`).
   */
  system: z.enum(ROUTE_SYSTEMS).optional(),
  medium: z.enum(MEDIA).optional(),
  /** FK to a functional `system` row, which is a different thing from the category above. */
  systemId: RowIdSchema.nullish(),
  nominalSize: z.string().trim().max(60).nullish(),
  diameterM: Finite.positive().nullish(),
  widthM: Finite.positive().nullish(),
  certainty: z.enum(CERTAINTIES),
  lifecycle: z.enum(LIFECYCLES),
  isEstimated: z.boolean().optional(),
  installedOn: LocalDateSchema.nullish(),
  removedOn: LocalDateSchema.nullish(),
  /** Metres into the structure; negative = behind the visible face. */
  depthM: Finite.nullish(),
  offsetSurfaceId: ManifestIdSchema.nullish(),
  offsetM: Finite.nullish(),
  projectId: RowIdSchema.nullish(),
  notes: z.string().trim().max(4000).nullish(),
  points: z.array(RoutePointWriteSchema).min(2).max(500),
  fromEndpointId: RowIdSchema.nullish(),
  toEndpointId: RowIdSchema.nullish(),
  /** `attachment` ids, linked as `attachment_link(entity_kind: 'infra_route')` in this order. */
  photoAttachmentIds: z.array(RowIdSchema).max(50).optional(),
});

export const RoutePutSchema = z.object({
  fingerprint: z.string().min(8),
  viewMode: ViewModeSchema,
  route: RouteWriteSchema,
});

export type RouteWrite = z.infer<typeof RouteWriteSchema>;
export type RoutePointWrite = z.infer<typeof RoutePointWriteSchema>;

/**
 * A route as the API answers it: everything the 3D view needs (`Route`) plus the persisted facts
 * the client type has no field for.
 */
export interface RouteDto extends Route {
  medium: InfraMedium;
  nominalSize: string | null;
  systemId: string | null;
  isEstimated: boolean;
  projectId: string | null;
  fromEndpointId: string | null;
  toEndpointId: string | null;
  needsReconciliation: boolean;
  pointKinds: Array<(typeof POINT_KINDS)[number]>;
  modelRevisionId: string;
}

/**
 * What the tables genuinely cannot hold, reported on every route response so the UI states it
 * instead of pretending. `kind` is derived from `medium`; the workspace's per-endpoint descriptors
 * (a surface plus uv, a placement reference) collapse to the two `infra_endpoint` links.
 */
export const ROUTE_PARTIAL_FIELDS = ["kind", "endpoints", "segments.roomId"] as const;

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

export const EndpointWriteSchema = z.object({
  id: RowIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(ENDPOINT_KINDS),
  locationId: RowIdSchema.nullish(),
  assetId: RowIdSchema.nullish(),
  modelNodeId: ManifestIdSchema.nullish(),
  /** `null` = a location-only endpoint (a panel "in the utility room", not at a point). */
  position: PositionSchema.nullish(),
  notes: z.string().trim().max(4000).nullish(),
});

export const EndpointPutSchema = z.object({
  fingerprint: z.string().min(8),
  viewMode: ViewModeSchema,
  endpoint: EndpointWriteSchema,
});

export type EndpointWrite = z.infer<typeof EndpointWriteSchema>;

export interface EndpointDto {
  id: string;
  name: string;
  kind: (typeof ENDPOINT_KINDS)[number];
  locationId: string | null;
  assetId: string | null;
  modelNodeId: string | null;
  position: [number, number, number] | null;
  notes: string | null;
  needsReconciliation: boolean;
}

// ---------------------------------------------------------------------------
// annotations
// ---------------------------------------------------------------------------

export const AnnotationWriteSchema = z.object({
  id: RowIdSchema.optional(),
  targetKind: z.enum(ANNOTATION_TARGETS),
  targetId: RowIdSchema.nullish(),
  modelNodeId: ManifestIdSchema.nullish(),
  position: PositionSchema.nullish(),
  kind: z.enum(ANNOTATION_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(4000).nullish(),
  measurementValue: Finite.nullish(),
  measurementUnit: z.string().trim().max(20).nullish(),
});

export const AnnotationPutSchema = z.object({
  fingerprint: z.string().min(8),
  viewMode: ViewModeSchema,
  annotation: AnnotationWriteSchema,
});

export type AnnotationWrite = z.infer<typeof AnnotationWriteSchema>;

export interface AnnotationDto {
  id: string;
  targetKind: (typeof ANNOTATION_TARGETS)[number];
  targetId: string | null;
  modelNodeId: string | null;
  position: [number, number, number] | null;
  kind: (typeof ANNOTATION_KINDS)[number];
  title: string;
  body: string | null;
  measurementValue: number | null;
  measurementUnit: string | null;
  needsReconciliation: boolean;
  photoIds: string[];
}
