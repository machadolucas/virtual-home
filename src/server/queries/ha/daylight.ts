import "server-only";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { haDevice, haEntity, haEntityState } from "@/db/schema";
import type { DaylightHaEntity } from "@/house/model/daylight";

/**
 * Live HA readings that can tune the presentation lighting. The registry id is the selection
 * identity; entityId is only the current, renameable address used by HA state events.
 *
 * Enabled illuminance and weather entities are watched by the worker even before selection. The
 * left-joined state is therefore allowed to be absent while HA is connecting; the selector can
 * show the source immediately and the viewer uses calculated daylight until its first reading.
 */
export function readDaylightHaEntities(tx: Db): DaylightHaEntity[] {
  return tx
    .select({
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      name: haEntity.name,
      deviceName: haDevice.nameByUser,
      fallbackDeviceName: haDevice.name,
      deviceClass: haEntity.deviceClass,
      unit: haEntity.unitOfMeasurement,
      state: haEntityState.state,
      lastUpdatedMs: haEntityState.lastUpdatedMs,
    })
    .from(haEntity)
    .leftJoin(haEntityState, eq(haEntityState.registryId, haEntity.registryId))
    .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
    .where(
      and(
        isNull(haEntity.removedAtMs),
        isNull(haEntity.disabledBy),
        isNull(haEntity.hiddenBy),
        isNull(haDevice.removedAtMs),
        isNull(haDevice.disabledBy),
        or(
          and(
            eq(haEntity.deviceClass, "illuminance"),
            sql`(${haEntity.unitOfMeasurement} IS NULL OR lower(trim(${haEntity.unitOfMeasurement})) IN ('lx', 'lux', 'klx', 'klux'))`,
          ),
          eq(haEntity.domain, "weather"),
        ),
      ),
    )
    .orderBy(asc(haEntity.domain), asc(haEntity.entityId))
    .all()
    .map((row) => ({
      registryId: row.registryId,
      entityId: row.entityId,
      name: row.name ?? row.deviceName ?? row.fallbackDeviceName ?? row.entityId,
      kind: row.deviceClass === "illuminance" ? "illuminance" : "weather",
      state: row.state,
      lastUpdatedMs: row.lastUpdatedMs,
      deviceClass: row.deviceClass,
      unit: row.unit,
    }));
}
