import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { attachment } from "./attachments";
/** Derived, bounded, local-only PDF index. Version/hash invalidate stale extraction. */
export const documentText = sqliteTable("document_text", {
  attachmentId: text("attachment_id").primaryKey().references(() => attachment.id, { onDelete: "cascade" }),
  sha256: text("sha256").notNull(),
  extractorVersion: text("extractor_version").notNull(),
  status: text("status").$type<"ready" | "scan" | "encrypted" | "failed" | "truncated">().notNull(),
  pagesJson: text("pages_json").notNull().default("[]"),
  error: text("error"),
  updatedAtMs: integer("updated_at_ms").notNull(),
});
