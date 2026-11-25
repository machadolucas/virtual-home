import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { attachment } from "./attachments";
import { auditQuad, createdPair, oneOf } from "./columns";
import { modelRevision } from "./model";
import type { ModelFixMode, ModelFixResolution, ModelFixStatus, ModelFixViewpoint } from "@/house/modelFixTypes";

export const modelFix = sqliteTable("model_fix", {
  id: text("id").primaryKey(),
  modelId: text("model_id").notNull(),
  mode: text("mode").$type<ModelFixMode>().notNull(),
  description: text("description").notNull(),
  status: text("status").$type<ModelFixStatus>().notNull(),
  resolvedAtMs: integer("resolved_at_ms"),
  resolution: text("resolution_json", { mode: "json" }).$type<ModelFixResolution>(),
  ...auditQuad(),
}, (t) => [
  check("ck_model_fix_mode", oneOf("mode", ["desktop", "vr", "mr"])),
  check("ck_model_fix_status", oneOf("status", ["pending", "resolved"])),
  check("ck_model_fix_resolution", sql`(status = 'pending' AND resolved_at_ms IS NULL AND resolution_json IS NULL)
    OR (status = 'resolved' AND resolved_at_ms IS NOT NULL AND resolution_json IS NOT NULL)`),
  index("ix_model_fix_order").on(t.createdAtMs, t.id),
  index("ix_model_fix_model_status_order").on(t.modelId, t.status, t.createdAtMs, t.id),
]);

export const modelFixScreenshot = sqliteTable("model_fix_screenshot", {
  id: text("id").primaryKey(),
  fixId: text("fix_id").notNull().references(() => modelFix.id, { onDelete: "cascade" }),
  source: text("source").$type<"viewer" | "quest_system">().notNull(),
  modelRevisionId: text("model_revision_id").references(() => modelRevision.id, { onDelete: "restrict" }),
  viewpoint: text("viewpoint_json", { mode: "json" }).$type<ModelFixViewpoint>(),
  imageId: text("image_id").notNull().references(() => attachment.id, { onDelete: "restrict" }),
  secondImageId: text("second_image_id").references(() => attachment.id, { onDelete: "restrict" }),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  ...createdPair(),
}, (t) => [
  uniqueIndex("ux_model_fix_screenshot_request").on(t.createdBy, t.requestId),
  index("ix_model_fix_screenshot_order").on(t.fixId, t.createdAtMs, t.id),
  check("ck_model_fix_screenshot_source", sql`(source = 'viewer' AND model_revision_id IS NOT NULL AND viewpoint_json IS NOT NULL)
    OR (source = 'quest_system' AND model_revision_id IS NULL AND viewpoint_json IS NULL AND second_image_id IS NULL)`),
]);
