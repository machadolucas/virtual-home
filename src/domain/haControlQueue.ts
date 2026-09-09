import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { assetHaLink, haControlCommand, haDevice, haEntity, haEntityState } from "@/db/schema";
import {
  assertSupportedCommand,
  capabilitiesForEntity,
  haControlCommandSchema,
  serviceCallForCommand,
  type HaControlCommand,
} from "./haControl";

export interface ClaimedHaControlCommand {
  id: string;
  domain: "light" | "switch";
  entityId: string;
  command: HaControlCommand;
}

const LIVE_LINK_STATES = ["active", "renamed"] as const;

function fail(tx: Db, id: string, atMs: number, error: string): void {
  tx.update(haControlCommand)
    .set({ state: "failed", finishedAtMs: atMs, lastError: error })
    .where(eq(haControlCommand.id, id))
    .run();
}

/**
 * Claim the oldest live command after rechecking registry identity and equipment linkage.
 * Invalid rows are terminally failed and skipped; no command can be redirected by an HA rename.
 */
export function claimHaControlCommand(
  handle: DbHandle,
  atMs: number,
): ClaimedHaControlCommand | null {
  return writeTx(handle.db, (tx) => {
    tx.update(haControlCommand)
      .set({ state: "expired", finishedAtMs: atMs, lastError: "control_expired" })
      .where(and(eq(haControlCommand.state, "queued"), lte(haControlCommand.expiresAtMs, atMs)))
      .run();
    // A worker crash after claim leaves the HA outcome unknowable. Make it terminal, never resend.
    tx.update(haControlCommand)
      .set({ state: "failed", finishedAtMs: atMs, lastError: "result_unknown" })
      .where(and(eq(haControlCommand.state, "sending"), lte(haControlCommand.expiresAtMs, atMs)))
      .run();

    // A bounded loop prevents one malformed row from blocking valid commands behind it.
    for (let checked = 0; checked < 20; checked += 1) {
      const row = tx
        .select()
        .from(haControlCommand)
        .where(eq(haControlCommand.state, "queued"))
        .orderBy(asc(haControlCommand.createdAtMs))
        .get();
      if (!row) return null;

      const entity = tx
        .select({
          registryId: haEntity.registryId,
          entityId: haEntity.entityId,
          domain: haEntity.domain,
          deviceId: haEntity.deviceId,
          disabledBy: haEntity.disabledBy,
          hiddenBy: haEntity.hiddenBy,
          state: haEntityState.state,
          attributesJson: haEntityState.attributesJson,
          deviceDisabledBy: haDevice.disabledBy,
        })
        .from(haEntity)
        .leftJoin(haEntityState, eq(haEntityState.registryId, haEntity.registryId))
        .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
        .where(and(eq(haEntity.registryId, row.entityRegistryId), isNull(haEntity.removedAtMs)))
        .get();
      if (!entity || (entity.domain !== "light" && entity.domain !== "switch")) {
        fail(tx, row.id, atMs, "control_entity_missing");
        continue;
      }
      if (entity.domain !== row.domain) {
        fail(tx, row.id, atMs, "control_entity_changed");
        continue;
      }
      if (entity.disabledBy !== null || entity.hiddenBy !== null || entity.deviceDisabledBy !== null) {
        fail(tx, row.id, atMs, "control_entity_disabled");
        continue;
      }

      const linked = tx
        .select({ id: assetHaLink.id })
        .from(assetHaLink)
        .where(
          and(
            eq(assetHaLink.assetId, row.assetId),
            inArray(assetHaLink.linkState, [...LIVE_LINK_STATES]),
            or(
              eq(assetHaLink.haEntityRegistryId, entity.registryId),
              entity.deviceId === null ? undefined : eq(assetHaLink.haDeviceId, entity.deviceId),
            ),
          ),
        )
        .get();
      if (!linked) {
        fail(tx, row.id, atMs, "control_entity_unlinked");
        continue;
      }
      if (entity.state === null || entity.state === "unknown" || entity.state === "unavailable") {
        fail(tx, row.id, atMs, "entity_unavailable");
        continue;
      }

      let rawCommand: unknown;
      try {
        rawCommand = JSON.parse(row.commandJson) as unknown;
      } catch {
        fail(tx, row.id, atMs, "invalid_control_command");
        continue;
      }
      const parsed = haControlCommandSchema.safeParse(rawCommand);
      if (!parsed.success) {
        fail(tx, row.id, atMs, "invalid_control_command");
        continue;
      }
      let attributes: Record<string, unknown> = {};
      if (entity.attributesJson) {
        try {
          const value: unknown = JSON.parse(entity.attributesJson);
          if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            attributes = value as Record<string, unknown>;
          }
        } catch {
          fail(tx, row.id, atMs, "control_capability_changed");
          continue;
        }
      }
      if (assertSupportedCommand(entity.domain, capabilitiesForEntity(entity.domain, attributes), parsed.data)) {
        fail(tx, row.id, atMs, "control_capability_changed");
        continue;
      }
      tx.update(haControlCommand)
        .set({ state: "sending", sendingAtMs: atMs, lastError: null })
        .where(and(eq(haControlCommand.id, row.id), eq(haControlCommand.state, "queued")))
        .run();
      return {
        id: row.id,
        domain: entity.domain,
        entityId: entity.entityId,
        command: parsed.data,
      };
    }
    return null;
  });
}

export function finishHaControlCommand(
  handle: DbHandle,
  id: string,
  atMs: number,
  outcome: { sent: true } | { sent: false; error: string },
): void {
  writeTx(handle.db, (tx) => {
    tx.update(haControlCommand)
      .set({
        state: outcome.sent ? "sent" : "failed",
        finishedAtMs: atMs,
        lastError: outcome.sent ? null : outcome.error,
      })
      .where(and(eq(haControlCommand.id, id), eq(haControlCommand.state, "sending")))
      .run();
  });
}

export { serviceCallForCommand };
