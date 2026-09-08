/**
 * M9 — attachments (files on disk, metadata here) and export runs.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §1.10, merged with
 * `docs/design-notes/auth-security-operations.md` §9.2 (the upload pipeline's fields:
 * sniffed `mime`, `sha256` dedupe, `has_web_copy` derivative flag).
 *
 * Files live under `$VH_DATA_DIR/attachments` (mode 700) and are served only through authenticated
 * route handlers — never from `public/`. Blobs are never stored in SQLite.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { auditQuad, oneOf } from "./columns";
import { user } from "./auth";

export const ATTACHMENT_KINDS = ["photo", "pdf", "manual", "video", "other"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const attachment = sqliteTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<AttachmentKind>().notNull(),
    /** Sniffed, never client-declared. */
    mime: text("mime").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** Free dedupe: re-uploading the same manual reuses the blob. */
    sha256: text("sha256").notNull(),
    /** Relative to the configured attachments dir. */
    storagePath: text("storage_path").notNull(),
    originalFilename: text("original_filename").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** A web-friendly derivative exists (HEIC/large photos get one). */
    hasWebCopy: integer("has_web_copy", { mode: "boolean" }).notNull().default(false),
    takenAtMs: integer("taken_at_ms"),
    caption: text("caption"),
    ...auditQuad(),
  },
  (t) => [
    check("ck_attachment_kind", oneOf("kind", ATTACHMENT_KINDS)),
    check("ck_attachment_byte_size", sql`byte_size >= 0`),
    uniqueIndex("ux_attachment_sha256").on(t.sha256),
    index("ix_attachment_created").on(t.createdAtMs),
  ],
);

export const ATTACHMENT_LINK_ENTITY_KINDS = [
  "asset",
  "location",
  "occurrence",
  "completion",
  "procedure_version",
  "procedure_step",
  "part",
  "part_lot",
  "annotation",
  "service_document",
  "project",
  "infra_route",
] as const;
export type AttachmentLinkEntityKind = (typeof ATTACHMENT_LINK_ENTITY_KINDS)[number];

/** Polymorphic link; existence is validated in the service layer (SQLite cannot declare it). */
export const attachmentLink = sqliteTable(
  "attachment_link",
  {
    id: text("id").primaryKey(),
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachment.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").$type<AttachmentLinkEntityKind>().notNull(),
    entityId: text("entity_id").notNull(),
    /** `'before'`, `'after'`, `'nameplate'`, `'receipt'`. */
    role: text("role"),
    seq: integer("seq").notNull().default(0),
  },
  (t) => [
    check("ck_attachment_link_entity_kind", oneOf("entity_kind", ATTACHMENT_LINK_ENTITY_KINDS)),
    uniqueIndex("ux_attachment_link").on(t.attachmentId, t.entityKind, t.entityId, t.role),
    index("ix_attachment_link_entity").on(t.entityKind, t.entityId, t.seq),
  ],
);

export const EXPORT_FORMATS = ["json", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ["running", "done", "failed"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const exportRun = sqliteTable(
  "export_run",
  {
    id: text("id").primaryKey(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    format: text("format").$type<ExportFormat>().notNull(),
    datasetsJson: text("datasets_json").notNull(),
    startedAtMs: integer("started_at_ms").notNull(),
    finishedAtMs: integer("finished_at_ms"),
    status: text("status").$type<ExportStatus>().notNull().default("running"),
    outputPath: text("output_path"),
    rowCountsJson: text("row_counts_json"),
    error: text("error"),
  },
  (t) => [
    check("ck_export_run_format", oneOf("format", EXPORT_FORMATS)),
    check("ck_export_run_status", oneOf("status", EXPORT_STATUSES)),
    index("ix_export_run_started").on(t.startedAtMs),
  ],
);
