/**
 * M2 — physical equipment, its placement in the model, what it consumes, replacement history,
 * systems that span locations, and the robust HA link.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.5 and §7.2.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { auditQuad, isHexColor, oneOf, positive } from "./columns";
import { attachment } from "./attachments";
import { location, modelRevision } from "./model";
import { haDevice, haEntity } from "./ha";
import { part } from "./inventory";
import { completion, maintenanceOccurrence } from "./maintenance";

export const ASSET_CATEGORIES = [
  "appliance",
  "hvac",
  "plumbing",
  "electrical",
  "network",
  "safety",
  "structure",
  "outdoor",
  "vehicle",
  "software",
  "other",
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

export const ASSET_STATUSES = ["planned", "installed", "removed", "retired", "lost"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export const DATE_PRECISIONS = ["exact", "month", "year", "unknown"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

/**
 * A physical (or virtual/software) unit. Replacement creates a **new** row and links the two —
 * history stays attached to the unit that was actually serviced.
 *
 * Code invariants: `status IN ('removed','retired')` ⇒ `removed_on` set; `replaced_by_asset_id`
 * set ⇒ `status IN ('removed','retired')`; chains are acyclic and both sides are written in one
 * transaction.
 */
export const asset = sqliteTable(
  "asset",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    category: text("category").$type<AssetCategory>().notNull(),
    manufacturer: text("manufacturer"),
    modelName: text("model_name"),
    serialNumber: text("serial_number"),
    productCode: text("product_code"),
    /** Nullable: software assets, or spares sitting in storage. */
    locationId: text("location_id").references(() => location.id, { onDelete: "restrict" }),
    /** Sub-components, e.g. the compressor inside a heat pump. */
    parentAssetId: text("parent_asset_id").references((): AnySQLiteColumn => asset.id, {
      onDelete: "restrict",
    }),
    /** HA software "devices" (an integration) are virtual. */
    isVirtual: integer("is_virtual", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<AssetStatus>().notNull(),
    /** LocalDate `YYYY-MM-DD`. */
    installedOn: text("installed_on"),
    installedOnPrecision: text("installed_on_precision").$type<DatePrecision>(),
    removedOn: text("removed_on"),
    replacesAssetId: text("replaces_asset_id").references((): AnySQLiteColumn => asset.id, {
      onDelete: "restrict",
    }),
    replacedByAssetId: text("replaced_by_asset_id").references((): AnySQLiteColumn => asset.id, {
      onDelete: "restrict",
    }),
    purchasePriceCents: integer("purchase_price_cents"),
    currency: text("currency").default("EUR"),
    warrantyUntil: text("warranty_until"),
    expectedLifeYears: integer("expected_life_years"),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_asset_category", oneOf("category", ASSET_CATEGORIES)),
    check("ck_asset_status", oneOf("status", ASSET_STATUSES)),
    check("ck_asset_installed_precision", oneOf("installed_on_precision", DATE_PRECISIONS)),
    check("ck_asset_not_self_parent", sql`parent_asset_id IS NULL OR parent_asset_id <> id`),
    check(
      "ck_asset_price_non_negative",
      sql`purchase_price_cents IS NULL OR purchase_price_cents >= 0`,
    ),
    index("ix_asset_location").on(t.locationId),
    index("ix_asset_status").on(t.status),
    index("ix_asset_category").on(t.category),
    index("ix_asset_parent").on(t.parentAssetId),
    index("ix_asset_replaced_by").on(t.replacedByAssetId),
  ],
);

export const PLACEMENT_KINDS = ["body", "access_panel", "label", "shutoff"] as const;
export type PlacementKind = (typeof PLACEMENT_KINDS)[number];

/**
 * How the unit is attached. `free` is for something suspended or buried that is neither on the
 * floor nor fixed to a surface; the default is `floor` because that is what an unqualified
 * position means.
 */
export const MOUNT_KINDS = ["floor", "wall", "ceiling", "free"] as const;
export type MountKind = (typeof MOUNT_KINDS)[number];

/**
 * Where the asset sits in the model. Revision-scoped and reconciliation-sensitive, hence its own
 * table; one asset may have a body placement plus, say, a shutoff marker.
 *
 * **Hard rule (enforced in the API layer, not here):** placement writes are accepted only from an
 * explicit "set placement" call carrying `viewMode: 'normal'`. Exploded/cutaway transforms live in
 * client memory and the URL — never in this table.
 */
export const assetPlacement = sqliteTable(
  "asset_placement",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    modelRevisionId: text("model_revision_id")
      .notNull()
      .references(() => modelRevision.id, { onDelete: "restrict" }),
    modelNodeId: text("model_node_id").notNull(),
    /** Metres in the model frame. */
    posX: real("pos_x"),
    posY: real("pos_y"),
    posZ: real("pos_z"),
    rotYawDeg: real("rot_yaw_deg"),
    /** Physical spotlight direction, independent of its mounting orientation. */
    lightAimYawDeg: real("light_aim_yaw_deg"),
    lightAimPitchDeg: real("light_aim_pitch_deg"),
    placementKind: text("placement_kind").$type<PlacementKind>().notNull().default("body"),
    /**
     * The mount, previously a coverage gap (`docs/model-contract.md` §3.1): a wall-mounted sensor
     * now keeps the record of *which* wall.
     */
    mountKind: text("mount_kind").$type<MountKind>().notNull().default("floor"),
    /** The package's own `surfaceId` for a wall/ceiling mount. Semantic id, never geometry. */
    mountSurfaceId: text("mount_surface_id"),
    /** Metres above the resolved room's own floor elevation. */
    mountHeightM: real("mount_height_m"),
    /** Metres out of the mounting surface (the standoff). */
    mountOffsetM: real("mount_offset_m"),
    /**
     * Which silhouette to draw in the 3D view (`src/house/scene/symbols.ts`): a ceiling lamp, a
     * lamp post, a ground spike, a vent grille…
     *
     * Appearance, not geometry — so it is not a presentation transform of the kind rule 7 forbids
     * persisting; it is a fact about the thing ("this is a lamp post"), chosen by the household and
     * therefore worth keeping. `null` means nobody chose, and the view infers one from the
     * category and the mount without ever writing it back.
     */
    symbol: text("symbol"),
    /** "behind the hatch, left of the manifold" — words a photo cannot replace. */
    locationNote: text("location_note"),
    /** The close-up that makes the location findable. */
    photoAttachmentId: text("photo_attachment_id").references(() => attachment.id, {
      onDelete: "set null",
    }),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    /** Lowercase `#rrggbb` marker tint. */
    colorOverride: text("color_override"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_asset_placement_kind", oneOf("placement_kind", PLACEMENT_KINDS)),
    check("ck_asset_placement_mount_kind", oneOf("mount_kind", MOUNT_KINDS)),
    check(
      "ck_asset_placement_color",
      sql`color_override IS NULL OR ${isHexColor("color_override")}`,
    ),
    uniqueIndex("ux_asset_placement_kind").on(t.assetId, t.placementKind),
    index("ix_asset_placement_node").on(t.modelRevisionId, t.modelNodeId),
    index("ix_asset_placement_surface").on(t.mountSurfaceId),
  ],
);

export const CONSUMABLE_ROLES = [
  "battery",
  "filter",
  "bag",
  "belt",
  "lamp",
  "fluid",
  "seal",
  "other",
] as const;
export type ConsumableRole = (typeof CONSUMABLE_ROLES)[number];

/** What an asset eats: pre-fills completion material lines and feeds reorder demand. */
export const assetConsumable = sqliteTable(
  "asset_consumable",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    role: text("role").$type<ConsumableRole>().notNull(),
    /** Integer thousandths: 2 pcs = 2000. */
    qtyMilli: integer("qty_milli").notNull(),
    notes: text("notes"),
  },
  (t) => [
    check("ck_asset_consumable_role", oneOf("role", CONSUMABLE_ROLES)),
    check("ck_asset_consumable_qty", positive("qty_milli")),
    uniqueIndex("ux_asset_consumable").on(t.assetId, t.partId, t.role),
    index("ix_asset_consumable_part").on(t.partId),
  ],
);

export const REPLACEMENT_REASONS = [
  "failure",
  "end_of_life",
  "upgrade",
  "damage",
  "recall",
  "other",
] as const;
export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

/** Audit-grade record of a swap. A unit is replaced once. */
export const assetReplacement = sqliteTable(
  "asset_replacement",
  {
    id: text("id").primaryKey(),
    oldAssetId: text("old_asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "restrict" }),
    newAssetId: text("new_asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "restrict" }),
    occurrenceId: text("occurrence_id").references(() => maintenanceOccurrence.id, {
      onDelete: "set null",
    }),
    completionId: text("completion_id").references(() => completion.id, { onDelete: "set null" }),
    /** LocalDate. */
    replacedOn: text("replaced_on").notNull(),
    reason: text("reason").$type<ReplacementReason>().notNull(),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_asset_replacement_reason", oneOf("reason", REPLACEMENT_REASONS)),
    check("ck_asset_replacement_distinct", sql`old_asset_id <> new_asset_id`),
    uniqueIndex("ux_asset_replacement_pair").on(t.oldAssetId, t.newAssetId),
    uniqueIndex("ux_asset_replacement_old").on(t.oldAssetId),
    index("ix_asset_replacement_new").on(t.newAssetId),
  ],
);

export const SYSTEM_KINDS = [
  "ventilation",
  "water",
  "wastewater",
  "heating",
  "electrical",
  "networking",
  "security",
  "irrigation",
  "other",
] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];

export const SYSTEM_STATUSES = ["active", "decommissioned"] as const;
export type SystemStatus = (typeof SYSTEM_STATUSES)[number];

/** A functional system (ventilation, water, electrical, network …). Spans locations. */
export const system = sqliteTable(
  "system",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<SystemKind>().notNull(),
    description: text("description"),
    status: text("status").$type<SystemStatus>().notNull().default("active"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_system_kind", oneOf("kind", SYSTEM_KINDS)),
    check("ck_system_status", oneOf("status", SYSTEM_STATUSES)),
    index("ix_system_kind").on(t.kind),
  ],
);

export const systemAsset = sqliteTable(
  "system_asset",
  {
    systemId: text("system_id")
      .notNull()
      .references(() => system.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    role: text("role"),
  },
  (t) => [
    primaryKey({ name: "pk_system_asset", columns: [t.systemId, t.assetId] }),
    index("ix_system_asset_asset").on(t.assetId),
  ],
);

/** How a system spans locations, without hacking the location hierarchy. */
export const systemLocation = sqliteTable(
  "system_location",
  {
    systemId: text("system_id")
      .notNull()
      .references(() => system.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ name: "pk_system_location", columns: [t.systemId, t.locationId] }),
    index("ix_system_location_location").on(t.locationId),
  ],
);

export const HA_LINK_KINDS = ["device", "entity"] as const;
export type HaLinkKind = (typeof HA_LINK_KINDS)[number];

export const HA_LINK_ROLES = [
  "primary",
  "battery_level",
  "power",
  "status",
  "control",
  "diagnostic",
  "other",
] as const;
export type HaLinkRole = (typeof HA_LINK_ROLES)[number];

export const HA_LINK_STATES = ["active", "renamed", "missing", "replaced", "retired"] as const;
export type HaLinkState = (typeof HA_LINK_STATES)[number];

/**
 * Asset ↔ Home Assistant. The FK is always the registry id (device registry id / entity registry
 * entry id), never the renameable `entity_id`; the `*_snapshot` columns are informational only
 * (CLAUDE.md rule 8).
 */
export const assetHaLink = sqliteTable(
  "asset_ha_link",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => asset.id, { onDelete: "cascade" }),
    linkKind: text("link_kind").$type<HaLinkKind>().notNull(),
    haDeviceId: text("ha_device_id").references(() => haDevice.deviceId, {
      onDelete: "set null",
    }),
    haEntityRegistryId: text("ha_entity_registry_id").references(() => haEntity.registryId, {
      onDelete: "set null",
    }),
    role: text("role").$type<HaLinkRole>().notNull(),
    /** Last-known `entity_id`; renameable, so never an identity. */
    entityIdSnapshot: text("entity_id_snapshot"),
    uniqueIdSnapshot: text("unique_id_snapshot"),
    platformSnapshot: text("platform_snapshot"),
    linkState: text("link_state").$type<HaLinkState>().notNull().default("active"),
    linkStateChangedAtMs: integer("link_state_changed_at_ms"),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_asset_ha_link_kind", oneOf("link_kind", HA_LINK_KINDS)),
    check("ck_asset_ha_link_role", oneOf("role", HA_LINK_ROLES)),
    check("ck_asset_ha_link_state", oneOf("link_state", HA_LINK_STATES)),
    check(
      "ck_asset_ha_link_target",
      sql`(link_kind = 'device') = (ha_device_id IS NOT NULL AND ha_entity_registry_id IS NULL)`,
    ),
    uniqueIndex("ux_asset_ha_link_target").on(
      t.assetId,
      t.linkKind,
      t.haDeviceId,
      t.haEntityRegistryId,
    ),
    uniqueIndex("ux_asset_ha_link_role")
      .on(t.assetId, t.role)
      .where(sql`role IN ('primary', 'battery_level')`),
    index("ix_asset_ha_link_entity").on(t.haEntityRegistryId),
    index("ix_asset_ha_link_device").on(t.haDeviceId),
    index("ix_asset_ha_link_state").on(t.linkState),
  ],
);
