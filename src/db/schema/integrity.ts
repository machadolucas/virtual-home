import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";
/** Reversible quarantine, outside the live attachment directory. */
export const integrityQuarantine = sqliteTable("integrity_quarantine", {
  id: text("id").primaryKey(),
  originalPath: text("original_path").notNull(),
  quarantinedAtMs: integer("quarantined_at_ms").notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  restoredAtMs: integer("restored_at_ms"),
});
