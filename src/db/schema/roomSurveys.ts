import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Vec3 } from "@/house/model/types";
import type {
  RoomSurveyGeometryMetadata, RoomSurveyMove, RoomSurveyObservation, RoomSurveyPose, RoomSurveyStatistics,
} from "@/house/roomSurveyTypes";
import { auditQuad, createdPair, oneOf } from "./columns";
import { modelRevision } from "./model";
import { modelFix } from "./modelFixes";

export interface StoredSurveyPose extends RoomSurveyPose {
  modelNodeId: string;
  roomId: string | null;
  floorId: string;
  /** Only equipment uses the mount height. Nullable legacy values are preserved for undo. */
  mountHeightM: number | null;
}

export const roomSurvey = sqliteTable("room_survey", {
  id: text("id").primaryKey(),
  modelId: text("model_id").notNull(),
  revisionId: text("revision_id").notNull().references(() => modelRevision.id, { onDelete: "restrict" }),
  roomId: text("room_id").notNull(),
  floorId: text("floor_id").notNull(),
  roomName: text("room_name").notNull(),
  registrationErrorM: real("registration_error_m").notNull(),
  statistics: text("statistics_json", { mode: "json" }).$type<RoomSurveyStatistics>().notNull(),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  ...createdPair(),
}, (t) => [
  uniqueIndex("ux_room_survey_request").on(t.createdBy, t.requestId),
  index("ix_room_survey_order").on(t.createdAtMs, t.id),
  index("ix_room_survey_model_room_order").on(t.modelId, t.roomId, t.createdAtMs, t.id),
  check("ck_room_survey_residual", sql`registration_error_m >= 0 AND registration_error_m <= 0.05`),
]);

export const roomSurveyGeometry = sqliteTable("room_survey_geometry", {
  surveyId: text("survey_id").primaryKey().references(() => roomSurvey.id, { onDelete: "cascade" }),
  metadata: text("metadata_json", { mode: "json" }).$type<RoomSurveyGeometryMetadata>().notNull(),
});

export const roomSurveyGeometryChunk = sqliteTable("room_survey_geometry_chunk", {
  surveyId: text("survey_id").notNull().references(() => roomSurveyGeometry.surveyId, { onDelete: "cascade" }),
  surface: integer("surface").notNull(),
  section: text("section").$type<"points" | "indices">().notNull(),
  chunk: integer("chunk").notNull(),
  payload: text("payload_json", { mode: "json" }).$type<Vec3[] | number[]>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.surveyId, t.surface, t.section, t.chunk] }),
  check("ck_room_survey_geometry_chunk_section", oneOf("section", ["points", "indices"])),
]);

export const roomSurveyMove = sqliteTable("room_survey_move", {
  id: text("id").primaryKey(),
  surveyId: text("survey_id").notNull().references(() => roomSurvey.id, { onDelete: "cascade" }),
  targetKind: text("target_kind").$type<RoomSurveyMove["target"]["kind"]>().notNull(),
  targetId: text("target_id").notNull(),
  targetName: text("target_name").notNull(),
  targetVersion: integer("target_version").notNull(),
  appliedTargetVersion: integer("applied_target_version"),
  before: text("before_json", { mode: "json" }).$type<StoredSurveyPose>().notNull(),
  after: text("after_json", { mode: "json" }).$type<StoredSurveyPose>().notNull(),
  applyBlockedReason: text("apply_blocked_reason").$type<RoomSurveyMove["applyBlockedReason"]>(),
  registrationErrorM: real("registration_error_m").notNull(),
  status: text("status").$type<RoomSurveyMove["status"]>().notNull(),
  appliedAtMs: integer("applied_at_ms"),
  undoneAtMs: integer("undone_at_ms"),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  ...auditQuad(),
}, (t) => [
  uniqueIndex("ux_room_survey_move_request").on(t.createdBy, t.requestId),
  index("ix_room_survey_move_order").on(t.surveyId, t.createdAtMs, t.id),
  check("ck_room_survey_move_target", oneOf("target_kind", ["equipment", "furnishing"])),
  check("ck_room_survey_move_status", oneOf("status", ["proposed", "applied", "undone"])),
  check("ck_room_survey_move_residual", sql`registration_error_m >= 0 AND registration_error_m <= 0.05`),
]);

export const roomSurveyObservation = sqliteTable("room_survey_observation", {
  fixId: text("fix_id").primaryKey().references(() => modelFix.id, { onDelete: "restrict" }),
  surveyId: text("survey_id").notNull().references(() => roomSurvey.id, { onDelete: "restrict" }),
  kind: text("kind").$type<RoomSurveyObservation["kind"]>().notNull(),
  position: text("position_json", { mode: "json" }).$type<Vec3>().notNull(),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  ...createdPair(),
}, (t) => [
  uniqueIndex("ux_room_survey_observation_request").on(t.createdBy, t.requestId),
  index("ix_room_survey_observation_order").on(t.surveyId, t.createdAtMs, t.fixId),
  check("ck_room_survey_observation_kind", oneOf("kind", ["structure", "new_object"])),
]);
