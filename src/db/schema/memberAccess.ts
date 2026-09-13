import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

/** Household authority is separate from Better Auth's generic admin plugin. */
export const memberAccess = sqliteTable("member_access", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "restrict" }),
  role: text("role").$type<"owner" | "member">().notNull().default("member"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  updatedAtMs: integer("updated_at_ms").notNull(),
  updatedBy: text("updated_by").references(() => user.id, { onDelete: "restrict" }),
});
