import "server-only";
import { createHash } from "node:crypto";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import type { z } from "zod";
import { readTx, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { auditLog, modelFix, modelRevision, roomSurvey, roomSurveyMove, roomSurveyObservation } from "@/db/schema";
import { pointInFootprint } from "@/house/model/geometry2d";
import type { Room, Vec3 } from "@/house/model/types";
import {
  MAX_ROOM_SURVEY_MOVES, MAX_ROOM_SURVEY_OBSERVATIONS, roomSurveyBounds, surveyDistanceM, surveyHeadingChange, surveyMeasurementLengthM,
  type RoomSurvey, type RoomSurveyCapture, type RoomSurveyGeometry, type RoomSurveyMove,
  type RoomSurveyObservation, type RoomSurveyObservationInput, type RoomSurveyPage, type RoomSurveyStatistics,
  type RoomSurveySummary, type roomSurveyGeometryPageInput, type roomSurveyListInput,
} from "@/house/roomSurveyTypes";
import { badRequest, conflict, notFound } from "@/server/api/handler";
import { manifestIndexOf, type CurrentPackage } from "@/server/house-model/package";
import { insertSurveyGeometry, prepareSurveyGeometry, readGeometryMetadata, readGeometryPage, readSurveyGeometry } from "./geometry";

type SurveyRow = typeof roomSurvey.$inferSelect;
export type MoveRow = typeof roomSurveyMove.$inferSelect;
const summarySelection = { row: roomSurvey, fingerprint: modelRevision.contentHash };

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateReplay(row: { requestHash: string }, hash: string) {
  if (row.requestHash !== hash) throw conflict("survey_request_reused");
}

export function surveyAudit(tx: Db, actor: string, surveyId: string, action: string, summary: string, atMs: number) {
  tx.insert(auditLog).values({
    id: newId(), atMs, actorKind: "user", actorUserId: actor, entityTable: "room_survey",
    entityId: surveyId, action, summary,
  }).run();
}

export function findRoomSurvey(db: Db, id: string, modelId?: string) {
  const result = db.select(summarySelection).from(roomSurvey)
    .innerJoin(modelRevision, eq(roomSurvey.revisionId, modelRevision.id)).where(and(
      eq(roomSurvey.id, id), modelId === undefined ? undefined : eq(roomSurvey.modelId, modelId),
    )).get();
  if (!result) throw notFound("unknown_room_survey");
  return result;
}

function summary(row: SurveyRow, fingerprint: string): RoomSurveySummary {
  const { id, modelId, floorId, roomId, roomName, registrationErrorM, createdAtMs, statistics } = row;
  return { id, modelId, fingerprint, floorId, roomId, roomName, registrationErrorM, capturedAtMs: createdAtMs, statistics };
}

export function surveyMoveDto(row: MoveRow): RoomSurveyMove {
  const pose = ({ position, yawDeg }: RoomSurveyMove["before"]) => ({ position, yawDeg });
  return {
    id: row.id, surveyId: row.surveyId, target: { kind: row.targetKind, id: row.targetId, name: row.targetName },
    before: pose(row.before), after: pose(row.after),
    displacementCm: Math.round(surveyDistanceM(row.before.position, row.after.position) * 1000) / 10,
    headingChangeDeg: Math.round(surveyHeadingChange(row.before.yawDeg, row.after.yawDeg) * 10) / 10,
    registrationErrorM: row.registrationErrorM, status: row.status, applyBlockedReason: row.applyBlockedReason,
    createdAtMs: row.createdAtMs, appliedAtMs: row.appliedAtMs, undoneAtMs: row.undoneAtMs,
  };
}

export function surveyObservationDto(row: typeof roomSurveyObservation.$inferSelect): RoomSurveyObservation {
  const { fixId, surveyId, kind, position, createdAtMs } = row;
  return { fixId, surveyId, kind, position, createdAtMs };
}

export function getRoomSurveyGeometry(db: Db, id: string, modelId?: string) {
  findRoomSurvey(db, id, modelId);
  return readSurveyGeometry(db, id);
}

export function getRoomSurvey(db: Db, id: string, modelId?: string): RoomSurvey {
  return readTx(db, (tx) => {
    const found = findRoomSurvey(tx, id, modelId);
    const geometry = readGeometryMetadata(tx, id);
    const moves = tx.select().from(roomSurveyMove).where(eq(roomSurveyMove.surveyId, id))
      .orderBy(desc(roomSurveyMove.createdAtMs), desc(roomSurveyMove.id)).limit(MAX_ROOM_SURVEY_MOVES).all();
    const observations = tx.select().from(roomSurveyObservation).where(eq(roomSurveyObservation.surveyId, id))
      .orderBy(desc(roomSurveyObservation.createdAtMs), desc(roomSurveyObservation.fixId)).limit(MAX_ROOM_SURVEY_OBSERVATIONS).all();
    return {
      ...summary(found.row, found.fingerprint),
      moves: moves.map(surveyMoveDto),
      observations: observations.map(surveyObservationDto),
      surfaces: geometry.surfaces,
      measurements: geometry.measurements.map((m) => ({ ...m, lengthM: Math.round(surveyMeasurementLengthM(m) * 1000) / 1000 })),
    };
  });
}

export function listRoomSurveys(db: Db, input: z.output<typeof roomSurveyListInput>): RoomSurveyPage {
  const filter = and(
    input.modelId === undefined ? undefined : eq(roomSurvey.modelId, input.modelId),
    input.roomId === undefined ? undefined : eq(roomSurvey.roomId, input.roomId),
  );
  const cursor = input.cursor ? db.select({ at: roomSurvey.createdAtMs, id: roomSurvey.id }).from(roomSurvey)
    .where(and(filter, eq(roomSurvey.id, input.cursor))).get() : undefined;
  if (input.cursor && !cursor) throw notFound("unknown_room_survey_cursor");
  const rows = db.select(summarySelection).from(roomSurvey)
    .innerJoin(modelRevision, eq(roomSurvey.revisionId, modelRevision.id)).where(and(filter, cursor && or(
      lt(roomSurvey.createdAtMs, cursor.at),
      and(eq(roomSurvey.createdAtMs, cursor.at), lt(roomSurvey.id, cursor.id)),
    ))).orderBy(desc(roomSurvey.createdAtMs), desc(roomSurvey.id)).limit(input.limit + 1).all();
  const items = rows.slice(0, input.limit).map(({ row, fingerprint }) => summary(row, fingerprint));
  return { items, nextCursor: rows.length > input.limit ? items.at(-1)?.id ?? null : null };
}

export function readRoomSurveyGeometryPage(db: Db, input: z.output<typeof roomSurveyGeometryPageInput>) {
  return readGeometryPage(db, input);
}

function surveyStatistics(input: RoomSurveyGeometry, room: Room): RoomSurveyStatistics {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const { min: scopeMin, max: scopeMax } = roomSurveyBounds(room);
  let includesAdjoining = false;
  const track = (point: Vec3, nearRoom: boolean) => {
    for (const axis of [0, 1, 2] as const) {
      // Browser points are rounded to millimetres after plane clipping.
      if (nearRoom && (point[axis] < scopeMin[axis] - 0.001 || point[axis] > scopeMax[axis] + 0.001))
        throw badRequest("survey_geometry_outside_extent");
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
    if (!includesAdjoining && !pointInFootprint(point[0], point[2], room.footprint)) includesAdjoining = true;
  };
  const sources: RoomSurveyStatistics["sources"] = {};
  let pointCount = 0, triangleCount = 0;
  for (const surface of input.surfaces) {
    sources[surface.source] = (sources[surface.source] ?? 0) + 1;
    pointCount += surface.points.length;
    triangleCount += (surface.indices?.length ?? 0) / 3;
    const nearRoom = input.scope !== "full" || (surface.source !== "plane" && surface.source !== "mesh");
    for (const point of surface.points) track(point, nearRoom);
  }
  for (const { a, b } of input.measurements) { track(a, true); track(b, true); }
  return { extent: { min, max }, includesAdjoining, scope: input.scope ?? "bounded", sources, pointCount, triangleCount, measurementCount: input.measurements.length };
}

export function requireSurveyRevision(db: Db, modelId: string, fingerprint: string) {
  const row = db.select({ id: modelRevision.id }).from(modelRevision).where(and(
    eq(modelRevision.modelId, modelId), eq(modelRevision.contentHash, fingerprint), eq(modelRevision.status, "current"),
  )).get();
  if (!row) throw conflict("survey_model_changed");
  return row.id;
}

export function storeRoomSurvey(db: Db, pkg: CurrentPackage, actor: string, input: RoomSurveyCapture): RoomSurveySummary {
  const hash = digest({ modelId: pkg.modelId, ...input });
  const replay = (tx: Db) => {
    const existing = tx.select(summarySelection).from(roomSurvey)
      .innerJoin(modelRevision, eq(roomSurvey.revisionId, modelRevision.id)).where(and(
        eq(roomSurvey.createdBy, actor), eq(roomSurvey.requestId, input.requestId),
      )).get();
    if (!existing) return null;
    validateReplay(existing.row, hash);
    return summary(existing.row, existing.fingerprint);
  };
  const old = replay(db);
  if (old) return old;
  if (input.fingerprint !== pkg.fingerprint) throw conflict("survey_model_changed");
  const room = manifestIndexOf(pkg).rooms.get(input.roomId);
  if (!room || input.floorId !== room.floorId) throw badRequest("survey_unknown_room");
  const statistics = surveyStatistics(input.geometry, room);
  const id = newId();
  const prepared = prepareSurveyGeometry(id, input.geometry);
  return writeTx(db, (tx) => {
    const duplicate = replay(tx);
    if (duplicate) return duplicate;
    const revisionId = requireSurveyRevision(tx, pkg.modelId, pkg.fingerprint);
    const at = nowMs();
    const row = tx.insert(roomSurvey).values({
      id, modelId: pkg.modelId, revisionId, roomId: room.id, floorId: room.floorId, roomName: room.name,
      registrationErrorM: input.registrationErrorM, statistics, requestId: input.requestId, requestHash: hash,
      createdAtMs: at, createdBy: actor,
    }).returning().get();
    insertSurveyGeometry(tx, id, prepared);
    surveyAudit(tx, actor, id, "captured", "Saved calibrated room survey", at);
    return summary(row, pkg.fingerprint);
  });
}

export function storeSurveyObservation(db: Db, modelId: string, surveyId: string, actor: string, input: RoomSurveyObservationInput) {
  return writeTx(db, (tx) => {
    const survey = findRoomSurvey(tx, surveyId, modelId).row;
    const hash = digest({ surveyId, ...input });
    const old = tx.select().from(roomSurveyObservation).where(and(
      eq(roomSurveyObservation.createdBy, actor), eq(roomSurveyObservation.requestId, input.requestId),
    )).get();
    if (old) {
      validateReplay(old, hash);
      return surveyObservationDto(old);
    }
    if (tx.select({ value: count() }).from(roomSurveyObservation)
      .where(eq(roomSurveyObservation.surveyId, surveyId)).get()!.value >= MAX_ROOM_SURVEY_OBSERVATIONS)
      throw conflict("survey_observation_limit");
    const at = nowMs(), id = newId();
    tx.insert(modelFix).values({
      id, modelId: survey.modelId, mode: "mr", status: "pending", description: input.description,
      createdAtMs: at, createdBy: actor, updatedAtMs: at, updatedBy: actor,
    }).run();
    const row = tx.insert(roomSurveyObservation).values({
      fixId: id, surveyId, kind: input.kind, position: input.position, requestId: input.requestId, requestHash: hash,
      createdAtMs: at, createdBy: actor,
    }).returning().get();
    surveyAudit(tx, actor, surveyId, "observation_recorded", "Recorded a pending room survey model fix", at);
    return surveyObservationDto(row);
  });
}
