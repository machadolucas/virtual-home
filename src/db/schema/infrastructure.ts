/**
 * M6 — infrastructure routes (pipes, ducts, cables), their endpoints, free-form annotations in the
 * model, and projects.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.9.
 *
 * Routes are usually inferred rather than measured, so honesty is built into the schema:
 * `is_estimated` (default 1) plus `certainty` and `lifecycle` say how much a route can be trusted
 * and whether it actually exists yet.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { auditQuad, oneOf } from "./columns";
import { asset, system } from "./assets";
import { location, modelRevision } from "./model";

export const INFRA_MEDIA = [
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
export type InfraMedium = (typeof INFRA_MEDIA)[number];

/** How well the route's path is known. */
export const INFRA_CERTAINTIES = ["measured", "observed", "inferred", "unknown"] as const;
export type InfraCertainty = (typeof INFRA_CERTAINTIES)[number];

/** Whether the route exists yet — a planned Cat6a run is not a Cat6a run. */
export const INFRA_LIFECYCLES = ["planned", "installed", "removed"] as const;
export type InfraLifecycle = (typeof INFRA_LIFECYCLES)[number];

export const infraRoute = sqliteTable(
  "infra_route",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    systemId: text("system_id").references(() => system.id, { onDelete: "set null" }),
    medium: text("medium").$type<InfraMedium>().notNull(),
    /** "DN20", "Cat6a". */
    nominalSize: text("nominal_size"),
    fromEndpointId: text("from_endpoint_id").references(
      (): AnySQLiteColumn => infraEndpoint.id,
      { onDelete: "set null" },
    ),
    toEndpointId: text("to_endpoint_id").references((): AnySQLiteColumn => infraEndpoint.id, {
      onDelete: "set null",
    }),
    modelRevisionId: text("model_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    /** Routes are usually inferred; default to saying so. */
    isEstimated: integer("is_estimated", { mode: "boolean" }).notNull().default(true),
    certainty: text("certainty").$type<InfraCertainty>().notNull().default("inferred"),
    lifecycle: text("lifecycle").$type<InfraLifecycle>().notNull().default("installed"),
    /** LocalDates `YYYY-MM-DD`. A planned run has neither; a removed one has both. */
    installedOn: text("installed_on"),
    removedOn: text("removed_on"),
    /** Metres into the structure; negative means behind the visible face. */
    depthM: real("depth_m"),
    /** The package's own `surfaceId` the route is dimensioned from. */
    offsetSurfaceId: text("offset_surface_id"),
    /** Metres out of `offset_surface_id`. */
    offsetM: real("offset_m"),
    /** The renovation that installed or removed the run. */
    projectId: text("project_id").references((): AnySQLiteColumn => project.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    ...auditQuad(),
  },
  (t) => [
    check("ck_infra_route_medium", oneOf("medium", INFRA_MEDIA)),
    check("ck_infra_route_certainty", oneOf("certainty", INFRA_CERTAINTIES)),
    check("ck_infra_route_lifecycle", oneOf("lifecycle", INFRA_LIFECYCLES)),
    /**
     * `removed_on >= installed_on` is deliberately **not** a CHECK constraint. Adding one to this
     * table would force SQLite's twelve-step table rebuild, and rebuilding a parent table whose
     * children cascade (`infra_route_point`) deletes those children: the implicit `DELETE FROM`
     * fires the cascade, and `PRAGMA foreign_keys` cannot be turned off from inside the migrator's
     * transaction. The rule is enforced in the API layer instead (`400 removed_before_installed`).
     */
    index("ix_infra_route_system").on(t.systemId),
    index("ix_infra_route_project").on(t.projectId),
    index("ix_infra_route_medium").on(t.medium),
    index("ix_infra_route_lifecycle").on(t.lifecycle),
  ],
);

export const INFRA_POINT_KINDS = [
  "vertex",
  "junction",
  "valve",
  "outlet",
  "penetration",
] as const;
export type InfraPointKind = (typeof INFRA_POINT_KINDS)[number];

/** The polyline of a route, in model-frame metres. */
export const infraRoutePoint = sqliteTable(
  "infra_route_point",
  {
    id: text("id").primaryKey(),
    routeId: text("route_id")
      .notNull()
      .references(() => infraRoute.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    posX: real("pos_x").notNull(),
    posY: real("pos_y").notNull(),
    posZ: real("pos_z").notNull(),
    modelNodeId: text("model_node_id"),
    /**
     * Per-segment location: the floor and room of the span that *starts* at this point, which is
     * what makes a riser between floors representable and what decides the span's explode group.
     * The last point of a polyline carries the previous span's values.
     */
    floorId: text("floor_id"),
    roomId: text("room_id"),
    pointKind: text("point_kind").$type<InfraPointKind>().notNull().default("vertex"),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "set null" }),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    check("ck_infra_route_point_kind", oneOf("point_kind", INFRA_POINT_KINDS)),
    check("ck_infra_route_point_seq", sql`seq >= 0`),
    uniqueIndex("ux_infra_route_point_seq").on(t.routeId, t.seq),
    index("ix_infra_route_point_asset").on(t.assetId),
    index("ix_infra_route_point_room").on(t.roomId),
  ],
);

export const INFRA_ENDPOINT_KINDS = [
  "source",
  "terminal",
  "junction",
  "meter",
  "shutoff",
  "panel",
  "patch_port",
] as const;
export type InfraEndpointKind = (typeof INFRA_ENDPOINT_KINDS)[number];

export const infraEndpoint = sqliteTable(
  "infra_endpoint",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<InfraEndpointKind>().notNull(),
    locationId: text("location_id").references(() => location.id, { onDelete: "set null" }),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "set null" }),
    modelRevisionId: text("model_revision_id").references(() => modelRevision.id, {
      onDelete: "restrict",
    }),
    modelNodeId: text("model_node_id"),
    posX: real("pos_x"),
    posY: real("pos_y"),
    posZ: real("pos_z"),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_infra_endpoint_kind", oneOf("kind", INFRA_ENDPOINT_KINDS)),
    index("ix_infra_endpoint_location").on(t.locationId),
    index("ix_infra_endpoint_asset").on(t.assetId),
  ],
);

export const ANNOTATION_TARGET_KINDS = ["location", "asset", "route", "node"] as const;
export type AnnotationTargetKind = (typeof ANNOTATION_TARGET_KINDS)[number];

export const ANNOTATION_KINDS = [
  "note",
  "measurement",
  "warning",
  "todo",
  "photo_point",
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** A pin in the model: a note, a measurement, a warning, a to-do, a photo viewpoint. */
export const annotation = sqliteTable(
  "annotation",
  {
    id: text("id").primaryKey(),
    /** Polymorphic by design; existence is validated in the service layer. */
    targetKind: text("target_kind").$type<AnnotationTargetKind>().notNull(),
    targetId: text("target_id"),
    modelRevisionId: text("model_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    modelNodeId: text("model_node_id"),
    posX: real("pos_x"),
    posY: real("pos_y"),
    posZ: real("pos_z"),
    kind: text("kind").$type<AnnotationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    measurementValue: real("measurement_value"),
    measurementUnit: text("measurement_unit"),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    ...auditQuad(),
  },
  (t) => [
    check("ck_annotation_target_kind", oneOf("target_kind", ANNOTATION_TARGET_KINDS)),
    check("ck_annotation_kind", oneOf("kind", ANNOTATION_KINDS)),
    check(
      "ck_annotation_measurement",
      sql`kind <> 'measurement' OR measurement_value IS NOT NULL`,
    ),
    index("ix_annotation_target").on(t.targetKind, t.targetId),
    index("ix_annotation_node").on(t.modelRevisionId, t.modelNodeId),
  ],
);

export const PROJECT_KINDS = [
  "renovation",
  "repair",
  "installation",
  "inspection",
  "improvement",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_STATUSES = [
  "idea",
  "planned",
  "in_progress",
  "done",
  "abandoned",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<ProjectKind>().notNull(),
    status: text("status").$type<ProjectStatus>().notNull().default("idea"),
    /** LocalDates. */
    startedOn: text("started_on"),
    endedOn: text("ended_on"),
    budgetCents: integer("budget_cents"),
    actualCostCents: integer("actual_cost_cents"),
    currency: text("currency").default("EUR"),
    summary: text("summary"),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_project_kind", oneOf("kind", PROJECT_KINDS)),
    check("ck_project_status", oneOf("status", PROJECT_STATUSES)),
    check(
      "ck_project_costs",
      sql`(budget_cents IS NULL OR budget_cents >= 0) AND (actual_cost_cents IS NULL OR actual_cost_cents >= 0)`,
    ),
    check("ck_project_dates", sql`ended_on IS NULL OR started_on IS NOT NULL`),
    index("ix_project_status").on(t.status),
  ],
);

export const PROJECT_LINK_ENTITY_KINDS = [
  "asset",
  "location",
  "system",
  "occurrence",
  "completion",
  "service_document",
  "part",
  "infra_route",
] as const;
export type ProjectLinkEntityKind = (typeof PROJECT_LINK_ENTITY_KINDS)[number];

/**
 * Polymorphic link. SQLite cannot declare a polymorphic FK, so the service layer validates
 * existence on insert and a nightly integrity job reports dangling links into `app_alert`.
 * Accepted trade-off versus eight nullable columns.
 */
export const projectLink = sqliteTable(
  "project_link",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").$type<ProjectLinkEntityKind>().notNull(),
    entityId: text("entity_id").notNull(),
    role: text("role"),
  },
  (t) => [
    check("ck_project_link_entity_kind", oneOf("entity_kind", PROJECT_LINK_ENTITY_KINDS)),
    uniqueIndex("ux_project_link").on(t.projectId, t.entityKind, t.entityId),
    index("ix_project_link_entity").on(t.entityKind, t.entityId),
  ],
);
