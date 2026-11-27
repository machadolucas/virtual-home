import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AlignmentAttempt } from "../../house/alignmentAttemptTypes";
import { user } from "./auth";
import { modelRevision } from "./model";

export const alignmentAttempt = sqliteTable("alignment_attempt", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  id: text("id").notNull(),
  modelRevisionId: text("model_revision_id").notNull().references(() => modelRevision.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  startedAtMs: integer("started_at_ms").notNull(),
  receivedAtMs: integer("received_at_ms").notNull(),
  elapsedMs: integer("elapsed_ms").notNull(),
  mode: text("mode").$type<AlignmentAttempt["mode"]>().notNull(),
  status: text("status").$type<AlignmentAttempt["status"]>().notNull(),
  roomId: text("room_id"),
  evidence: text("evidence_json", { mode: "json" }).$type<Pick<AlignmentAttempt, "features" | "events" | "snapshots">>().notNull(),
}, t => [
  primaryKey({ columns: [t.userId, t.id] }),
  index("ix_alignment_attempt_user_time").on(t.userId, t.startedAtMs, t.id),
  index("ix_alignment_attempt_expiry").on(t.startedAtMs),
  check("ck_alignment_attempt_revision", sql`revision >= 1`),
]);
