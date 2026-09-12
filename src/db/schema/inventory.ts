/**
 * M5 — parts, kits, suppliers, storage, lots, the append-only stock ledger, the `part_stock` view
 * and in-app alerts.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.8.
 *
 * The kit rule that makes double counting impossible: stock is tracked only where the goods
 * physically sit, so `available(part) = SUM(stock_transaction.qty_milli WHERE part_id = part)` —
 * full stop. There is no `+ kits × ratio` term anywhere; opening a box is an explicit, audited
 * "kit explode" that writes one consumption of the kit plus one addition per component.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { actor, auditQuad, createdPair, oneOf, positive } from "./columns";
import { asset } from "./assets";
import { completion, maintenanceOccurrence } from "./maintenance";
import { location } from "./model";

export const PART_TRACKING_MODES = ["discrete", "measured", "estimated"] as const;
export type PartTrackingMode = (typeof PART_TRACKING_MODES)[number];

export const PART_STOCK_MODES = ["stocked", "not_stocked"] as const;
export type PartStockMode = (typeof PART_STOCK_MODES)[number];

export const PART_UNITS = ["pcs", "l", "ml", "m", "kg", "g"] as const;
export type PartUnit = (typeof PART_UNITS)[number];

/**
 * A SKU-level part. Code invariant for `tracking_mode = 'discrete'`: every `qty_milli` written for
 * it is a multiple of 1000 (a CHECK on `unit` would be too strong).
 */
export const part = sqliteTable(
  "part",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    spec: text("spec"),
    dimensions: text("dimensions"),
    manufacturer: text("manufacturer"),
    productCode: text("product_code"),
    ean: text("ean"),
    trackingMode: text("tracking_mode").$type<PartTrackingMode>().notNull(),
    unit: text("unit").$type<PartUnit>().notNull(),
    isKit: integer("is_kit", { mode: "boolean" }).notNull().default(false),
    stockMode: text("stock_mode").$type<PartStockMode>().notNull().default("stocked"),
    reorderThresholdMilli: integer("reorder_threshold_milli"),
    reorderTargetMilli: integer("reorder_target_milli"),
    leadTimeDays: integer("lead_time_days"),
    defaultStoragePlaceId: text("default_storage_place_id").references(
      (): AnySQLiteColumn => storagePlace.id,
      { onDelete: "set null" },
    ),
    /** Enable for parts with expiry / opened-state tracking. */
    tracksLots: integer("tracks_lots", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    archivedAtMs: integer("archived_at_ms"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_part_tracking_mode", oneOf("tracking_mode", PART_TRACKING_MODES)),
    check("ck_part_unit", oneOf("unit", PART_UNITS)),
    check("ck_part_stock_mode", oneOf("stock_mode", PART_STOCK_MODES)),
    // Non-kit parts are always stocked; a `not_stocked` kit is a pure bill-of-materials definition.
    check("ck_part_kit_stock_mode", sql`is_kit = 1 OR stock_mode = 'stocked'`),
    check(
      "ck_part_reorder_non_negative",
      sql`(reorder_threshold_milli IS NULL OR reorder_threshold_milli >= 0) AND (reorder_target_milli IS NULL OR reorder_target_milli >= 0)`,
    ),
    check("ck_part_lead_time", sql`lead_time_days IS NULL OR lead_time_days >= 0`),
    uniqueIndex("ux_part_product_code")
      .on(t.manufacturer, t.productCode)
      .where(sql`product_code IS NOT NULL`),
    index("ix_part_name").on(t.name),
  ],
);

/**
 * Bill-of-materials metadata only. Used for "you have 1 unopened kit containing the 2 filters you
 * need — explode it?" and for compatibility inference. Never for availability arithmetic.
 */
export const kitComponent = sqliteTable(
  "kit_component",
  {
    kitPartId: text("kit_part_id")
      .notNull()
      .references(() => part.id, { onDelete: "cascade" }),
    componentPartId: text("component_part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    qtyMilli: integer("qty_milli").notNull(),
  },
  (t) => [
    primaryKey({ name: "pk_kit_component", columns: [t.kitPartId, t.componentPartId] }),
    check("ck_kit_component_qty", positive("qty_milli")),
    check("ck_kit_component_distinct", sql`kit_part_id <> component_part_id`),
    index("ix_kit_component_component").on(t.componentPartId),
  ],
);

export const COMPATIBILITY_CONFIDENCES = ["confirmed", "likely", "unverified"] as const;
export type CompatibilityConfidence = (typeof COMPATIBILITY_CONFIDENCES)[number];

export const partCompatibility = sqliteTable(
  "part_compatibility",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "cascade" }),
    assetModelName: text("asset_model_name"),
    manufacturer: text("manufacturer"),
    confidence: text("confidence").$type<CompatibilityConfidence>().notNull(),
    note: text("note"),
  },
  (t) => [
    check("ck_part_compatibility_confidence", oneOf("confidence", COMPATIBILITY_CONFIDENCES)),
    check(
      "ck_part_compatibility_target",
      sql`asset_id IS NOT NULL OR asset_model_name IS NOT NULL`,
    ),
    uniqueIndex("ux_part_compatibility_asset")
      .on(t.partId, t.assetId)
      .where(sql`asset_id IS NOT NULL`),
  ],
);

export const partSupplier = sqliteTable(
  "part_supplier",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "cascade" }),
    supplierName: text("supplier_name").notNull(),
    supplierSku: text("supplier_sku"),
    url: text("url"),
    lastPriceCents: integer("last_price_cents"),
    currency: text("currency").default("EUR"),
    packQtyMilli: integer("pack_qty_milli"),
    leadTimeDays: integer("lead_time_days"),
    isPreferred: integer("is_preferred", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
  },
  (t) => [
    check(
      "ck_part_supplier_price",
      sql`last_price_cents IS NULL OR last_price_cents >= 0`,
    ),
    check("ck_part_supplier_pack", sql`pack_qty_milli IS NULL OR pack_qty_milli > 0`),
    uniqueIndex("ux_part_supplier_preferred").on(t.partId).where(sql`is_preferred = 1`),
    index("ix_part_supplier_part").on(t.partId),
  ],
);

/** "Garage shelf B, bin 3" — nestable, and optionally pinned to a model node. */
export const storagePlace = sqliteTable(
  "storage_place",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    locationId: text("location_id")
      .notNull()
      .references(() => location.id, { onDelete: "restrict" }),
    modelNodeId: text("model_node_id"),
    parentPlaceId: text("parent_place_id").references((): AnySQLiteColumn => storagePlace.id, {
      onDelete: "restrict",
    }),
    needsReconciliation: integer("needs_reconciliation", { mode: "boolean" })
      .notNull()
      .default(false),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    uniqueIndex("ux_storage_place_name").on(t.locationId, t.name),
    index("ix_storage_place_parent").on(t.parentPlaceId),
  ],
);

/**
 * Optional per-part lot, for expiry and opened-state tracking. For
 * `part.tracking_mode = 'estimated'` the authoritative number is `estimate_pct` on the open lot;
 * the ledger still records the implied delta (`reason = 'estimate_update'`) so it stays the single
 * source of the number.
 */
export const partLot = sqliteTable(
  "part_lot",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    storagePlaceId: text("storage_place_id").references(() => storagePlace.id, {
      onDelete: "set null",
    }),
    /** LocalDates. */
    purchasedOn: text("purchased_on"),
    expiresOn: text("expires_on"),
    openedOn: text("opened_on"),
    initialQtyMilli: integer("initial_qty_milli"),
    isOpen: integer("is_open", { mode: "boolean" }).notNull().default(false),
    /** The "estimated remaining for liquids" dial. */
    estimatePct: integer("estimate_pct"),
    notes: text("notes"),
    ...auditQuad(),
  },
  (t) => [
    check(
      "ck_part_lot_estimate_pct",
      sql`estimate_pct IS NULL OR (estimate_pct BETWEEN 0 AND 100)`,
    ),
    check(
      "ck_part_lot_initial_qty",
      sql`initial_qty_milli IS NULL OR initial_qty_milli >= 0`,
    ),
    uniqueIndex("ux_part_lot_label").on(t.partId, t.label),
    index("ix_part_lot_expiry").on(t.partId, t.expiresOn),
  ],
);

export const STOCK_TRANSACTION_KINDS = [
  "purchase",
  "consumption",
  "adjustment",
  "correction",
  "kit_explode_in",
  "kit_explode_out",
  "estimate_update",
  "initial_count",
  "disposal",
] as const;
export type StockTransactionKind = (typeof STOCK_TRANSACTION_KINDS)[number];

export const STOCK_TRANSACTION_REASONS = [
  "purchase",
  "maintenance_consumption",
  "stock_take",
  "reconcile_missing_stock",
  "reconcile_surplus",
  "completion_voided",
  "kit_explode",
  "kit_explode_undo",
  "expired",
  "damaged",
  "estimate_update",
  "manual_correction",
  "initial_seed",
] as const;
export type StockTransactionReason = (typeof STOCK_TRANSACTION_REASONS)[number];

/**
 * The append-only stock ledger. **Never updated, never deleted.** Quantities are signed integer
 * thousandths; negative balances are allowed, because that is how a noted discrepancy is
 * represented honestly.
 */
export const stockTransaction = sqliteTable(
  "stock_transaction",
  {
    id: text("id").primaryKey(),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    lotId: text("lot_id").references(() => partLot.id, { onDelete: "restrict" }),
    storagePlaceId: text("storage_place_id").references(() => storagePlace.id, {
      onDelete: "set null",
    }),
    /** Signed thousandths; never zero. */
    qtyMilli: integer("qty_milli").notNull(),
    kind: text("kind").$type<StockTransactionKind>().notNull(),
    reason: text("reason").$type<StockTransactionReason>().notNull(),
    occurrenceId: text("occurrence_id").references(() => maintenanceOccurrence.id, {
      onDelete: "set null",
    }),
    completionId: text("completion_id").references(() => completion.id, { onDelete: "set null" }),
    /** Ties the rows of one atomic multi-row operation (e.g. a kit explode) together. */
    transactionGroupId: text("transaction_group_id"),
    reversesTransactionId: text("reverses_transaction_id").references(
      (): AnySQLiteColumn => stockTransaction.id,
      { onDelete: "restrict" },
    ),
    unitPriceCents: integer("unit_price_cents"),
    /** When it physically happened (may be backdated). */
    occurredAtMs: integer("occurred_at_ms").notNull(),
    occurredLocalDate: text("occurred_local_date").notNull(),
    notes: text("notes"),
    ...createdPair(),
  },
  (t) => [
    check("ck_stock_transaction_kind", oneOf("kind", STOCK_TRANSACTION_KINDS)),
    check("ck_stock_transaction_reason", oneOf("reason", STOCK_TRANSACTION_REASONS)),
    check("ck_stock_transaction_qty_nonzero", sql`qty_milli <> 0`),
    check("ck_stock_transaction_consumption_sign", sql`kind <> 'consumption' OR qty_milli < 0`),
    check(
      "ck_stock_transaction_inbound_sign",
      sql`kind NOT IN ('purchase', 'initial_count', 'kit_explode_in') OR qty_milli > 0`,
    ),
    check(
      "ck_stock_transaction_price",
      sql`unit_price_cents IS NULL OR unit_price_cents >= 0`,
    ),
    // A transaction can be reversed once.
    uniqueIndex("ux_stock_transaction_reverses")
      .on(t.reversesTransactionId)
      .where(sql`reverses_transaction_id IS NOT NULL`),
    index("ix_stock_transaction_part").on(t.partId, t.occurredAtMs),
    index("ix_stock_transaction_completion").on(t.completionId),
    index("ix_stock_transaction_group").on(t.transactionGroupId),
    index("ix_stock_transaction_lot").on(t.lotId),
  ],
);

/**
 * On-hand stock as a SQL view — no cache table, no drift. Data volume is small (hundreds to low
 * thousands of rows) and the `(part_id, occurred_at_ms)` index makes the SUM microseconds.
 *
 * `effective_milli` excludes rows dated in the future (a purchase recorded ahead of delivery).
 */
export const partStock = sqliteView("part_stock", {
  partId: text("part_id").notNull(),
  onHandMilli: integer("on_hand_milli").notNull(),
  effectiveMilli: integer("effective_milli").notNull(),
  lastMovementMs: integer("last_movement_ms"),
}).as(
  sql`SELECT p.id AS part_id,
       COALESCE(SUM(t.qty_milli), 0) AS on_hand_milli,
       COALESCE(SUM(CASE WHEN t.occurred_at_ms <= unixepoch() * 1000 THEN t.qty_milli END), 0) AS effective_milli,
       MAX(t.occurred_at_ms) AS last_movement_ms
FROM part p LEFT JOIN stock_transaction t ON t.part_id = p.id
GROUP BY p.id`,
);

export const APP_ALERT_KINDS = [
  "low_stock",
  "negative_stock",
  "expiring_part",
  "ha_link_missing",
  "ha_entity_renamed",
  "stale_sensor",
  "model_reconciliation",
  "notify_device_missing",
  "worker_outage",
  "integrity",
] as const;
export type AppAlertKind = (typeof APP_ALERT_KINDS)[number];

export const APP_ALERT_SEVERITIES = ["info", "warning", "error"] as const;
export type AppAlertSeverity = (typeof APP_ALERT_SEVERITIES)[number];

/**
 * In-app warnings. Not push unless `household_setting.inventory_push_enabled` (or a per-kind
 * override) says so. Re-raising an unresolved alert bumps `last_seen_at_ms`/`seen_count` rather
 * than creating noise — that is what the partial unique index on `dedupe_key` buys.
 */
export const appAlert = sqliteTable(
  "app_alert",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<AppAlertKind>().notNull(),
    severity: text("severity").$type<AppAlertSeverity>().notNull(),
    entityTable: text("entity_table"),
    entityId: text("entity_id"),
    title: text("title").notNull(),
    body: text("body"),
    dedupeKey: text("dedupe_key").notNull(),
    firstSeenAtMs: integer("first_seen_at_ms").notNull(),
    lastSeenAtMs: integer("last_seen_at_ms").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    acknowledgedAtMs: integer("acknowledged_at_ms"),
    acknowledgedBy: actor("acknowledged_by"),
    resolvedAtMs: integer("resolved_at_ms"),
  },
  (t) => [
    check("ck_app_alert_kind", oneOf("kind", APP_ALERT_KINDS)),
    check("ck_app_alert_severity", oneOf("severity", APP_ALERT_SEVERITIES)),
    check("ck_app_alert_seen_count", sql`seen_count >= 1`),
    uniqueIndex("ux_app_alert_dedupe").on(t.dedupeKey).where(sql`resolved_at_ms IS NULL`),
    index("ix_app_alert_kind").on(t.kind, t.resolvedAtMs),
    index("ix_app_alert_last_seen").on(t.lastSeenAtMs),
  ],
);
