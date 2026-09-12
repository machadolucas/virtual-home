import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { haControlCommand } from "@/db/schema";
import { assertSupportedCommand, HA_CONTROL_TTL_MS, haControlCommandSchema } from "@/domain/haControl";
import { HttpError, notFound } from "@/server/api/handler";
import { readEquipmentHaControls } from "@/server/ha/control";
import { defineOperation } from "@/server/operations/core";

export const queueHaControl=defineOperation(z.object({assetId:z.string().min(1).max(128),requestId:z.uuid(),registryId:z.string().min(1).max(255),command:haControlCommandSchema}).strict(),(input,session)=>{
  const {assetId}=input;
  const at = nowMs();
  const { db } = getDb();

  const commandId = writeTx(db, (tx) => {
    const existing = tx
      .select()
      .from(haControlCommand)
      .where(
        and(
          eq(haControlCommand.requestId, input.requestId),
          eq(haControlCommand.requestedBy, session.user.id),
        ),
      )
      .get();
    if (existing) {
      if (
        existing.assetId !== assetId ||
        existing.entityRegistryId !== input.registryId ||
        existing.commandJson !== JSON.stringify(input.command)
      ) {
        throw new HttpError(409, "request_id_conflict");
      }
      return existing.id;
    }

    const controls = readEquipmentHaControls(tx, assetId);
    if (!controls) throw notFound("equipment_not_found");
    if (!controls.connected) throw new HttpError(503, "ha_disconnected");
    const entity = controls.entities.find((candidate) => candidate.registryId === input.registryId);
    if (!entity) throw notFound("linked_control_entity_not_found");
    if (!entity.available) throw new HttpError(409, "entity_unavailable");
    const unsupported = assertSupportedCommand(
      entity.entityId.slice(0, entity.entityId.indexOf(".")),
      entity.capabilities,
      input.command,
    );
    if (unsupported) {
      throw new HttpError(422, "unsupported_capability", undefined, { capability: unsupported });
    }

    const id = newId();
    tx.insert(haControlCommand)
      .values({
        id,
        requestId: input.requestId,
        assetId,
        entityRegistryId: entity.registryId,
        entityIdSnapshot: entity.entityId,
        domain: entity.entityId.slice(0, entity.entityId.indexOf(".")),
        commandJson: JSON.stringify(input.command),
        state: "queued",
        requestedBy: session.user.id,
        createdAtMs: at,
        expiresAtMs: at + HA_CONTROL_TTL_MS,
      })
      .run();
    return id;
  });

  return {commandId,status:"queued" as const,observed:false as const};
});
