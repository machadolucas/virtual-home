/**
 * M1 — the immutable 3D model package as imported revisions, the spatial `location` tree, the
 * HA area/floor mapping, and the revision-to-revision reconciliation records.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.4 and §8.
 *
 * Two rules from CLAUDE.md shape this module:
 *  - the model package is immutable input; runtime rows reference `model_id` + semantic node ids
 *    (`node_id`, `room_id`, `surface_id`) + metre coordinates, never geometry;
 *  - exploded/cutaway view transforms are presentation state and have no table.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { actor, auditQuad, isHexColor, oneOf } from "./columns";

export const MODEL_REVISION_STATUSES = ["imported", "current", "superseded"] as const;
export type ModelRevisionStatus = (typeof MODEL_REVISION_STATUSES)[number];

/** One import of the supplied house-model package. Content-hashed, so re-import is a no-op. */
export const modelRevision = sqliteTable(
  "model_revision",
  {
    id: text("id").primaryKey(),
    /** `'example-house-1'` — stable across revisions. */
    modelId: text("model_id").notNull(),
    /** From the package manifest. */
    schemaVersion: text("schema_version").notNull(),
    generatedAtMs: integer("generated_at_ms").notNull(),
    /** sha256 of the canonicalised geometry + id manifest. */
    contentHash: text("content_hash").notNull(),
    /** `{"units":"m","up":"y","forward":"-z","origin":"model-frame"}` — exported with every dataset. */
    coordinateSystemJson: text("coordinate_system_json").notNull(),
    nodeCount: integer("node_count").notNull(),
    importedAtMs: integer("imported_at_ms").notNull(),
    importedBy: actor("imported_by"),
    status: text("status").$type<ModelRevisionStatus>().notNull(),
  },
  (t) => [
    check("ck_model_revision_status", oneOf("status", MODEL_REVISION_STATUSES)),
    check("ck_model_revision_node_count", sql`${t.nodeCount} >= 0`),
    uniqueIndex("ux_model_revision_hash").on(t.modelId, t.contentHash),
    uniqueIndex("ux_model_revision_current").on(t.modelId).where(sql`status = 'current'`),
  ],
);

export const MODEL_NODE_KINDS = [
  "building",
  "floor",
  "room",
  "zone",
  "surface",
  "element",
] as const;
export type ModelNodeKind = (typeof MODEL_NODE_KINDS)[number];

/** The node tree of one revision, keyed by the package's semantic ids. */
export const modelNode = sqliteTable(
  "model_node",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "cascade" }),
    /** Semantic id from the package: `r-g-kitchen`, `f-ground`, `b-house`. */
    nodeId: text("node_id").notNull(),
    kind: text("kind").$type<ModelNodeKind>().notNull(),
    /** Semantic id of the parent within the same revision. */
    parentNodeId: text("parent_node_id"),
    name: text("name").notNull(),
    centroidX: real("centroid_x"),
    centroidY: real("centroid_y"),
    centroidZ: real("centroid_z"),
    bboxMinX: real("bbox_min_x"),
    bboxMinY: real("bbox_min_y"),
    bboxMinZ: real("bbox_min_z"),
    bboxMaxX: real("bbox_max_x"),
    bboxMaxY: real("bbox_max_y"),
    bboxMaxZ: real("bbox_max_z"),
    areaM2: real("area_m2"),
  },
  (t) => [
    check("ck_model_node_kind", oneOf("kind", MODEL_NODE_KINDS)),
    uniqueIndex("ux_model_node_revision_node").on(t.revisionId, t.nodeId),
    index("ix_model_node_kind").on(t.revisionId, t.kind),
    index("ix_model_node_parent").on(t.revisionId, t.parentNodeId),
  ],
);

/** Remembered remap decisions, carried forward so the next import follows them automatically. */
export const modelNodeAlias = sqliteTable(
  "model_node_alias",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    fromRevisionId: text("from_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "cascade" }),
    toRevisionId: text("to_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "cascade" }),
    oldNodeId: text("old_node_id").notNull(),
    /** NULL = the node was intentionally removed. */
    newNodeId: text("new_node_id"),
    decidedBy: actor("decided_by"),
    decidedAtMs: integer("decided_at_ms").notNull(),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("ux_model_node_alias").on(
      t.modelId,
      t.fromRevisionId,
      t.toRevisionId,
      t.oldNodeId,
    ),
  ],
);

export const LOCATION_KINDS = ["property", "building", "floor", "room", "zone"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * The single spatial tree (property > building > floor > room, plus outdoor zones). One table so
 * every spatial record needs one `location_id` FK instead of a four-way polymorphic reference.
 *
 * Code invariants (walked on write, depth ≤ 8): allowed parent kinds are `building→property`,
 * `floor→building`, `room→floor`, `zone→property|building`; no cycles.
 */
export const location = sqliteTable(
  "location",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<LocationKind>().notNull(),
    parentId: text("parent_id").references((): AnySQLiteColumn => location.id, {
      onDelete: "restrict",
    }),
    name: text("name").notNull(),
    /** Stable app-side key, e.g. `ground-kitchen`. */
    slug: text("slug").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Only meaningful for `kind = 'floor'`. */
    floorLevel: integer("floor_level"),
    isOutdoor: integer("is_outdoor", { mode: "boolean" }).notNull().default(false),
    modelRevisionId: text("model_revision_id").references(() => modelRevision.id, {
      onDelete: "restrict",
    }),
    /** Semantic node id, e.g. `r-g-kitchen`. */
    modelNodeId: text("model_node_id"),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_location_kind", oneOf("kind", LOCATION_KINDS)),
    check("ck_location_root", sql`(kind = 'property') = (parent_id IS NULL)`),
    uniqueIndex("ux_location_slug").on(t.slug),
    uniqueIndex("ux_location_model_node")
      .on(t.modelRevisionId, t.modelNodeId)
      .where(sql`model_node_id IS NOT NULL`),
    index("ix_location_parent").on(t.parentId, t.sortOrder),
    index("ix_location_kind").on(t.kind),
  ],
);

export const LOCATION_MAPPING_HA_KINDS = ["area", "floor"] as const;
export type LocationMappingHaKind = (typeof LOCATION_MAPPING_HA_KINDS)[number];

export const LOCATION_MAPPING_SOURCES = ["suggested", "confirmed", "rejected"] as const;
export type LocationMappingSource = (typeof LOCATION_MAPPING_SOURCES)[number];

/** HA area/floor ↔ our location. Never auto-`confirmed`; a human decides. */
export const locationMapping = sqliteTable(
  "location_mapping",
  {
    id: text("id").primaryKey(),
    haKind: text("ha_kind").$type<LocationMappingHaKind>().notNull(),
    /** HA `area_id` / `floor_id`. */
    haId: text("ha_id").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
    source: text("source").$type<LocationMappingSource>().notNull(),
    /** 0..1, only for `source = 'suggested'`. */
    confidence: real("confidence"),
    /** `'name_exact'`, `'name_fuzzy:0.86'`, `'manual'`. */
    matchReason: text("match_reason"),
    decidedBy: actor("decided_by"),
    decidedAtMs: integer("decided_at_ms"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_location_mapping_ha_kind", oneOf("ha_kind", LOCATION_MAPPING_HA_KINDS)),
    check("ck_location_mapping_source", oneOf("source", LOCATION_MAPPING_SOURCES)),
    check(
      "ck_location_mapping_confidence",
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
    uniqueIndex("ux_location_mapping_ha").on(t.haKind, t.haId),
    uniqueIndex("ux_location_mapping_confirmed_area")
      .on(t.locationId)
      .where(sql`source = 'confirmed' AND ha_kind = 'area'`),
  ],
);

export const MODEL_RECONCILIATION_STATUSES = ["open", "applied", "abandoned"] as const;
export type ModelReconciliationStatus = (typeof MODEL_RECONCILIATION_STATUSES)[number];

/** A reconciliation plan produced by importing a new revision. A human accepts it item by item. */
export const modelReconciliation = sqliteTable(
  "model_reconciliation",
  {
    id: text("id").primaryKey(),
    fromRevisionId: text("from_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    toRevisionId: text("to_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    status: text("status").$type<ModelReconciliationStatus>().notNull(),
    /** Counts by outcome. */
    summaryJson: text("summary_json"),
    createdAtMs: integer("created_at_ms").notNull(),
    createdBy: actor("created_by"),
    appliedAtMs: integer("applied_at_ms"),
    appliedBy: actor("applied_by"),
  },
  (t) => [
    check("ck_model_reconciliation_status", oneOf("status", MODEL_RECONCILIATION_STATUSES)),
    uniqueIndex("ux_model_reconciliation_open").on(t.toRevisionId).where(sql`status = 'open'`),
  ],
);

export const RECONCILIATION_ENTITY_KINDS = [
  "location",
  "asset_placement",
  "infra_route",
  "infra_route_point",
  "infra_endpoint",
  "annotation",
  "storage_place",
  "surface_color_override",
] as const;
export type ReconciliationEntityKind = (typeof RECONCILIATION_ENTITY_KINDS)[number];

export const RECONCILIATION_ISSUES = [
  "node_missing",
  "kind_changed",
  "moved_beyond_tolerance",
  "parent_changed",
  "duplicate_node",
] as const;
export type ReconciliationIssue = (typeof RECONCILIATION_ISSUES)[number];

export const RECONCILIATION_PROPOSED_ACTIONS = ["remap", "keep", "archive", "none"] as const;
export type ReconciliationProposedAction = (typeof RECONCILIATION_PROPOSED_ACTIONS)[number];

export const RECONCILIATION_DECISIONS = ["remap", "keep", "archive"] as const;
export type ReconciliationDecision = (typeof RECONCILIATION_DECISIONS)[number];

/** One affected row per reconciliation, with candidates and the human's decision. */
export const modelReconciliationItem = sqliteTable(
  "model_reconciliation_item",
  {
    id: text("id").primaryKey(),
    reconciliationId: text("reconciliation_id")
      .notNull()
      .references(() => modelReconciliation.id, { onDelete: "cascade" }),
    /** Polymorphic by design; existence is validated in the service layer. */
    entityKind: text("entity_kind").$type<ReconciliationEntityKind>().notNull(),
    entityId: text("entity_id").notNull(),
    oldNodeId: text("old_node_id").notNull(),
    issue: text("issue").$type<ReconciliationIssue>().notNull(),
    /** `[{nodeId,name,kind,score,reason,centroidDistanceM}]` */
    candidatesJson: text("candidates_json"),
    proposedAction: text("proposed_action").$type<ReconciliationProposedAction>().notNull(),
    proposedNewNodeId: text("proposed_new_node_id"),
    decision: text("decision").$type<ReconciliationDecision>(),
    decidedNewNodeId: text("decided_new_node_id"),
    decidedBy: actor("decided_by"),
    decidedAtMs: integer("decided_at_ms"),
    note: text("note"),
  },
  (t) => [
    check("ck_reconciliation_item_entity_kind", oneOf("entity_kind", RECONCILIATION_ENTITY_KINDS)),
    check("ck_reconciliation_item_issue", oneOf("issue", RECONCILIATION_ISSUES)),
    check(
      "ck_reconciliation_item_proposed",
      oneOf("proposed_action", RECONCILIATION_PROPOSED_ACTIONS),
    ),
    check("ck_reconciliation_item_decision", oneOf("decision", RECONCILIATION_DECISIONS)),
    uniqueIndex("ux_reconciliation_item").on(
      t.reconciliationId,
      t.entityKind,
      t.entityId,
      t.oldNodeId,
    ),
  ],
);

/**
 * Surface colouring chosen in the 3D workspace. Keyed by `model_id` + the package's semantic
 * `surface_id` so a colour survives a revision import; `model_revision_id` records which revision
 * the choice was made against, which is what makes a stale surface id detectable.
 *
 * Colouring mutates only the surface's own material (CLAUDE.md rule 7) — there is no geometry here.
 */
export const surfaceColorOverride = sqliteTable(
  "surface_color_override",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    modelRevisionId: text("model_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    /** Semantic surface id from the package, e.g. `s-r-g-kitchen-wall-n`. */
    surfaceId: text("surface_id").notNull(),
    /** Semantic room node id the surface belongs to, when known — for grouping in the UI. */
    roomId: text("room_id"),
    /** Lowercase `#rrggbb`. */
    colorHex: text("color_hex").notNull(),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    ...auditQuad(),
  },
  (t) => [
    check("ck_surface_color_override_hex", isHexColor("color_hex")),
    uniqueIndex("ux_surface_color_override").on(t.modelId, t.surfaceId),
    index("ix_surface_color_override_revision").on(t.modelRevisionId, t.surfaceId),
    index("ix_surface_color_override_room").on(t.modelId, t.roomId),
  ],
);

/**
 * Household presentation preferences for semantic rooms and floors in the 3D workspace.
 *
 * These are deliberately separate from `model_node`: a package is immutable input, while a
 * household display name and the choice to suppress an unused area's label are runtime choices.
 * The semantic node id keeps a preference stable across compatible model revisions.
 */
export const modelLabelPreference = sqliteTable(
  "model_label_preference",
  {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull(),
    modelNodeId: text("model_node_id").notNull(),
    /** NULL follows a confirmed Home Assistant mapping, then the location/model name. */
    displayName: text("display_name"),
    /** NULL follows the semantic default (`attic`/`void` hidden, ordinary rooms shown). */
    visible: integer("visible", { mode: "boolean" }),
    ...auditQuad(),
  },
  (t) => [
    uniqueIndex("ux_model_label_preference").on(t.modelId, t.modelNodeId),
    index("ix_model_label_preference_model").on(t.modelId),
  ],
);
