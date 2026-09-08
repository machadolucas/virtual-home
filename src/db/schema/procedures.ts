/**
 * M3 — procedures: versioned, immutable-once-published instructions with steps, checklists, tools,
 * materials and references.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.6.
 *
 * Immutability is a service-layer invariant (asserted and tested), not a constraint: once a
 * `procedure_version` is `published`, it and all its children are read-only and any edit forks a
 * new draft.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { actor, auditQuad, oneOf, positive } from "./columns";
import { asset } from "./assets";
import { attachment } from "./attachments";
import { part } from "./inventory";

export const procedure = sqliteTable(
  "procedure",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary"),
    defaultEffortMinutes: integer("default_effort_minutes"),
    /** The published version currently in force; NULL until first publish. */
    currentVersionId: text("current_version_id").references(
      (): AnySQLiteColumn => procedureVersion.id,
      { onDelete: "set null" },
    ),
    archivedAtMs: integer("archived_at_ms"),
    ...auditQuad(),
  },
  (t) => [
    check(
      "ck_procedure_effort",
      sql`default_effort_minutes IS NULL OR default_effort_minutes > 0`,
    ),
    uniqueIndex("ux_procedure_slug").on(t.slug),
  ],
);

export const PROCEDURE_VERSION_STATUSES = ["draft", "published", "superseded"] as const;
export type ProcedureVersionStatus = (typeof PROCEDURE_VERSION_STATUSES)[number];

export const procedureVersion = sqliteTable(
  "procedure_version",
  {
    id: text("id").primaryKey(),
    procedureId: text("procedure_id")
      .notNull()
      .references(() => procedure.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<ProcedureVersionStatus>().notNull().default("draft"),
    publishedAtMs: integer("published_at_ms"),
    publishedBy: actor("published_by"),
    changeNote: text("change_note"),
    safetyNotes: text("safety_notes"),
    prerequisites: text("prerequisites"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_procedure_version_status", oneOf("status", PROCEDURE_VERSION_STATUSES)),
    check("ck_procedure_version_number", positive("version")),
    uniqueIndex("ux_procedure_version").on(t.procedureId, t.version),
    // At most one draft per procedure at a time.
    uniqueIndex("ux_procedure_version_draft").on(t.procedureId).where(sql`status = 'draft'`),
  ],
);

export const procedureStep = sqliteTable(
  "procedure_step",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md"),
    expectedMinutes: integer("expected_minutes"),
    isOptional: integer("is_optional", { mode: "boolean" }).notNull().default(false),
    warning: text("warning"),
  },
  (t) => [
    check("ck_procedure_step_seq", sql`seq >= 0`),
    uniqueIndex("ux_procedure_step_seq").on(t.versionId, t.seq),
  ],
);

export const CHECKLIST_VALUE_KINDS = ["number", "text", "photo"] as const;
export type ChecklistValueKind = (typeof CHECKLIST_VALUE_KINDS)[number];

export const procedureChecklistItem = sqliteTable(
  "procedure_checklist_item",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    /** NULL = a version-level checklist item rather than a step-level one. */
    stepId: text("step_id").references(() => procedureStep.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    text: text("text").notNull(),
    requiresValue: text("requires_value").$type<ChecklistValueKind>(),
    unit: text("unit"),
  },
  (t) => [
    check("ck_procedure_checklist_value", oneOf("requires_value", CHECKLIST_VALUE_KINDS)),
    check("ck_procedure_checklist_seq", sql`seq >= 0`),
    uniqueIndex("ux_procedure_checklist_seq").on(t.versionId, t.stepId, t.seq),
  ],
);

export const procedureTool = sqliteTable(
  "procedure_tool",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    notes: text("notes"),
  },
  (t) => [index("ix_procedure_tool_version").on(t.versionId)],
);

export const procedureMaterial = sqliteTable(
  "procedure_material",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    partId: text("part_id")
      .notNull()
      .references(() => part.id, { onDelete: "restrict" }),
    qtyMilli: integer("qty_milli").notNull(),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    notes: text("notes"),
  },
  (t) => [
    check("ck_procedure_material_qty", positive("qty_milli")),
    uniqueIndex("ux_procedure_material").on(t.versionId, t.partId),
    index("ix_procedure_material_part").on(t.partId),
  ],
);

export const PROCEDURE_REFERENCE_KINDS = [
  "manual",
  "page",
  "url",
  "video",
  "datasheet",
] as const;
export type ProcedureReferenceKind = (typeof PROCEDURE_REFERENCE_KINDS)[number];

export const procedureReference = sqliteTable(
  "procedure_reference",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ProcedureReferenceKind>().notNull(),
    label: text("label").notNull(),
    url: text("url"),
    manualName: text("manual_name"),
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    attachmentId: text("attachment_id").references(() => attachment.id, { onDelete: "set null" }),
  },
  (t) => [
    check("ck_procedure_reference_kind", oneOf("kind", PROCEDURE_REFERENCE_KINDS)),
    check(
      "ck_procedure_reference_pages",
      sql`page_to IS NULL OR (page_from IS NOT NULL AND page_to >= page_from)`,
    ),
    index("ix_procedure_reference_version").on(t.versionId),
  ],
);

/** "On the 2019 model the filter clip is reversed." */
export const procedureEquipmentNote = sqliteTable(
  "procedure_equipment_note",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .notNull()
      .references(() => procedureVersion.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => asset.id, { onDelete: "set null" }),
    assetModelName: text("asset_model_name"),
    note: text("note").notNull(),
  },
  (t) => [
    check(
      "ck_procedure_equipment_note_target",
      sql`asset_id IS NOT NULL OR asset_model_name IS NOT NULL`,
    ),
    index("ix_procedure_equipment_note_version").on(t.versionId),
  ],
);
