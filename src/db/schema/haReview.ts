import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

/** Local import preferences survive registry cache refreshes, removal and reappearance. */
export const haReview = sqliteTable("ha_review", {
  kind: text("kind").$type<"device" | "entity">().notNull(),
  registryId: text("registry_id").notNull(),
  ignored: integer("ignored", { mode: "boolean" }).notNull().default(true),
  updatedAtMs: integer("updated_at_ms").notNull(),
  updatedBy: text("updated_by").notNull().references(() => user.id, { onDelete: "restrict" }),
}, t => [primaryKey({ columns: [t.kind, t.registryId] })]);
