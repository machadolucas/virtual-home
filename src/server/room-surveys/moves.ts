import "server-only";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { asset, assetPlacement, furnishing, roomSurveyMove } from "@/db/schema";
import type { StoredSurveyPose } from "@/db/schema/roomSurveys";
import { roomAt, type ManifestIndex } from "@/house/model/manifestIndex";
import type { Vec3 } from "@/house/model/types";
import { MAX_ROOM_SURVEY_MOVES, surveyDistanceM, surveyHeadingChange, type RoomSurveyMoveInput } from "@/house/roomSurveyTypes";
import { badRequest, conflict, notFound } from "@/server/api/handler";
import { manifestIndexOf, type CurrentPackage } from "@/server/house-model/package";
import { assertInBounds, mm } from "@/server/queries/infrastructure/model";
import { digest, findRoomSurvey, requireSurveyRevision, surveyAudit, surveyMoveDto, validateReplay } from "./registry";

interface Target {
  name: string;
  version: number;
  pose: StoredSurveyPose;
  equipment: boolean;
  surfaceAttached: boolean;
}

function targetFor(
  db: Db, target: RoomSurveyMoveInput["target"], pkg: CurrentPackage, revisionId: string, index: ManifestIndex,
): Target {
  if (target.kind === "furnishing") {
    const row = db.select().from(furnishing).where(and(eq(furnishing.id, target.id), eq(furnishing.modelId, pkg.modelId))).get();
    if (!row || !index.floors.has(row.floorId) || (row.roomId !== null && !index.rooms.has(row.roomId)))
      throw conflict("survey_target_not_current");
    return {
      name: row.name, version: row.updatedAtMs, surfaceAttached: false, equipment: false,
      pose: { position: [row.posX, row.posY, row.posZ], yawDeg: row.rotYawDeg, modelNodeId: row.modelNodeId,
        floorId: row.floorId, roomId: row.roomId, mountHeightM: null },
    };
  }

  const match = db.select({ row: assetPlacement, name: asset.name }).from(assetPlacement)
    .innerJoin(asset, eq(asset.id, assetPlacement.assetId)).where(and(
      eq(assetPlacement.id, target.id), eq(assetPlacement.modelRevisionId, revisionId),
      eq(assetPlacement.needsReconciliation, false), eq(assetPlacement.placementKind, "body"),
      eq(asset.isVirtual, false), inArray(asset.status, ["planned", "installed"]), isNull(asset.replacedByAssetId),
    )).get();
  if (!match) throw conflict("survey_target_not_current");
  const { row, name } = match;
  if (row.posX === null || row.posY === null || row.posZ === null) throw conflict("survey_target_not_current");
  const room = index.rooms.get(row.modelNodeId);
  const floorId = room?.floorId ?? row.modelNodeId;
  if (!index.floors.has(floorId)) throw conflict("survey_target_not_current");
  return {
    name, version: row.updatedAtMs, equipment: true,
    surfaceAttached: row.mountSurfaceId !== null || row.mountKind === "wall" || row.mountKind === "ceiling",
    pose: {
      position: [row.posX, row.posY, row.posZ], yawDeg: row.rotYawDeg ?? 0,
      modelNodeId: row.modelNodeId, roomId: room?.id ?? roomAt(index, floorId, row.posX, row.posZ),
      floorId, mountHeightM: row.mountHeightM,
    },
  };
}

function validateCurrentSurvey(db: Db, pkg: CurrentPackage, found: ReturnType<typeof findRoomSurvey>) {
  if (found.fingerprint !== pkg.fingerprint || requireSurveyRevision(db, pkg.modelId, pkg.fingerprint) !== found.row.revisionId)
    throw conflict("survey_model_changed");
}

function sameStoredPose(a: StoredSurveyPose, b: StoredSurveyPose) {
  return a.position.every((value, index) => value === b.position[index]) &&
    a.yawDeg === b.yawDeg && a.modelNodeId === b.modelNodeId && a.roomId === b.roomId &&
    a.floorId === b.floorId && a.mountHeightM === b.mountHeightM;
}

export function proposeSurveyMove(db: Db, pkg: CurrentPackage, surveyId: string, actor: string, input: RoomSurveyMoveInput) {
  const index = manifestIndexOf(pkg);
  const hash = digest({ surveyId, ...input });
  return writeTx(db, (tx) => {
    const survey = findRoomSurvey(tx, surveyId, pkg.modelId);
    const old = tx.select().from(roomSurveyMove).where(and(
      eq(roomSurveyMove.createdBy, actor), eq(roomSurveyMove.requestId, input.requestId),
    )).get();
    if (old) {
      validateReplay(old, hash);
      return surveyMoveDto(old);
    }
    validateCurrentSurvey(tx, pkg, survey);
    const room = index.rooms.get(survey.row.roomId);
    if (!room || survey.row.floorId !== room.floorId) throw conflict("survey_model_changed");
    if (tx.select({ value: count() }).from(roomSurveyMove)
      .where(eq(roomSurveyMove.surveyId, surveyId)).get()!.value >= MAX_ROOM_SURVEY_MOVES)
      throw conflict("survey_move_limit");
    const target = targetFor(tx, input.target, pkg, survey.row.revisionId, index);
    if (target.pose.floorId !== room.floorId) throw badRequest("survey_outside_floor");
    if (surveyDistanceM(target.pose.position, input.before.position) > 0.001 ||
      Math.abs(surveyHeadingChange(target.pose.yawDeg, input.before.yawDeg)) > 0.001)
      throw conflict("survey_target_changed");

    const position = input.sample.position.map(mm) as Vec3;
    assertInBounds(pkg, position);
    if (roomAt(index, room.floorId, position[0], position[2]) !== room.id ||
      position[1] < room.floorElevation - 0.05 ||
      (room.ceilingHeight !== undefined && position[1] > room.floorElevation + room.ceilingHeight + 0.05))
      throw badRequest("survey_outside_room");
    const yawDeg = mm(input.sample.yawDeg ?? target.pose.yawDeg);
    if (surveyDistanceM(position, target.pose.position) < 0.0005 && Math.abs(surveyHeadingChange(target.pose.yawDeg, yawDeg)) < 0.001)
      throw badRequest("survey_move_no_change");

    const after: StoredSurveyPose = {
      position, yawDeg, floorId: room.floorId, roomId: room.id, modelNodeId: room.id,
      mountHeightM: target.equipment ? mm(position[1] - room.floorElevation) : null,
    };
    const id = newId(), at = nowMs();
    const stored = tx.insert(roomSurveyMove).values({
      id, surveyId, targetKind: input.target.kind, targetId: input.target.id, targetName: target.name,
      targetVersion: target.version, before: target.pose, after,
      applyBlockedReason: target.surfaceAttached ? "surface_support_unverified" : null,
      registrationErrorM: input.registrationErrorM, status: "proposed", requestId: input.requestId, requestHash: hash,
      createdAtMs: at, createdBy: actor, updatedAtMs: at, updatedBy: actor,
    }).returning().get();
    surveyAudit(tx, actor, surveyId, "move_proposed", "Proposed an existing object placement correction", at);
    return surveyMoveDto(stored);
  });
}

function persistPose(tx: Db, target: Target, id: string, pose: StoredSurveyPose, actor: string, at: number) {
  const shared = {
    modelNodeId: pose.modelNodeId,
    posX: pose.position[0], posY: pose.position[1], posZ: pose.position[2],
    rotYawDeg: pose.yawDeg, updatedAtMs: at, updatedBy: actor,
  };
  if (target.equipment) {
    return tx.update(assetPlacement).set({ ...shared, mountHeightM: pose.mountHeightM })
      .where(and(eq(assetPlacement.id, id), eq(assetPlacement.updatedAtMs, target.version))).run().changes;
  }
  return tx.update(furnishing).set({ ...shared, floorId: pose.floorId, roomId: pose.roomId })
    .where(and(eq(furnishing.id, id), eq(furnishing.updatedAtMs, target.version))).run().changes;
}

export function changeSurveyMove(
  db: Db, pkg: CurrentPackage, surveyId: string, moveId: string, actor: string, action: "apply" | "undo",
) {
  const index = manifestIndexOf(pkg);
  return writeTx(db, (tx) => {
    const survey = findRoomSurvey(tx, surveyId, pkg.modelId);
    const row = tx.select().from(roomSurveyMove).where(and(
      eq(roomSurveyMove.id, moveId), eq(roomSurveyMove.surveyId, surveyId),
    )).get();
    if (!row) throw notFound("unknown_room_survey_move");
    const status = action === "apply" ? "applied" : "undone";
    if (row.status === status) return surveyMoveDto(row);
    if (row.status !== (action === "apply" ? "proposed" : "applied")) throw conflict("survey_move_status_changed");
    if (row.applyBlockedReason) throw conflict("survey_target_not_movable");
    validateCurrentSurvey(tx, pkg, survey);
    const target = targetFor(tx, { kind: row.targetKind, id: row.targetId }, pkg, survey.row.revisionId, index);
    if (target.surfaceAttached) throw conflict("survey_target_not_movable");

    const expectedPose = action === "apply" ? row.before : row.after;
    const expectedVersion = action === "apply" ? row.targetVersion : row.appliedTargetVersion;
    if (target.version !== expectedVersion || !sameStoredPose(target.pose, expectedPose))
      throw conflict("survey_target_changed");
    const at = Math.max(nowMs(), target.version + 1, row.updatedAtMs + 1);
    const destination = action === "apply" ? row.after : row.before;
    assertInBounds(pkg, destination.position);
    const writes = persistPose(tx, target, row.targetId, destination, actor, at);
    if (writes !== 1) throw conflict("survey_target_changed");
    const stored = tx.update(roomSurveyMove).set({
      status, ...(action === "apply" ? { appliedAtMs: at, appliedTargetVersion: at } : { undoneAtMs: at }),
      updatedAtMs: at, updatedBy: actor,
    }).where(eq(roomSurveyMove.id, row.id)).returning().get();
    surveyAudit(tx, actor, surveyId, action === "apply" ? "move_applied" : "move_undone",
      action === "apply" ? "Applied an approved surveyed placement" : "Restored the surveyed placement's prior pose", at);
    return surveyMoveDto(stored);
  });
}
