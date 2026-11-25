import { and, eq, inArray, isNull } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { haDevice, haEntity, haEntityState } from "@/db/schema/ha";
import { householdSetting, HOUSEHOLD_SETTING_ID } from "@/db/schema/household";
import {
  EMPTY_VENTILATION_FEEDBACK, VENTILATION_FANS, ventilationFeedbackSchema,
  type VentilationFeedbackConfig,
} from "@/domain/ventilationFeedback";

export function readVentilationFeedback(db: Db): VentilationFeedbackConfig {
  const row = db.select({ json: householdSetting.ventilationFeedbackJson })
    .from(householdSetting).where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID)).get();
  if (row?.json) {
    try {
      const result = ventilationFeedbackSchema.safeParse(JSON.parse(row.json));
      if (result.success) return result.data;
    } catch { /* Invalid persisted configuration behaves like an unconfigured house. */ }
  }
  return EMPTY_VENTILATION_FEEDBACK;
}

export function ventilationEntities(db: Db, config = readVentilationFeedback(db)) {
  const ids = VENTILATION_FANS.map((fan) => config[fan]).filter((id) => id !== null);
  if (ids.length === 0) return [];
  return db.select({
    registryId: haEntity.registryId,
    entityId: haEntity.entityId,
    deviceId: haEntity.deviceId,
    unit: haEntity.unitOfMeasurement,
    platform: haEntity.platform,
    uniqueId: haEntity.uniqueId,
  })
    .from(haEntity)
    .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
    .where(and(
      inArray(haEntity.registryId, ids),
      eq(haEntity.domain, "sensor"),
      isNull(haEntity.removedAtMs),
      isNull(haEntity.disabledBy),
      isNull(haDevice.removedAtMs),
      isNull(haDevice.disabledBy),
    ))
    .all();
}

export function configureVentilationFeedback(handle: DbHandle, input: unknown): VentilationFeedbackConfig {
  const config = ventilationFeedbackSchema.parse(input);
  return writeTx(handle.db, (tx) => {
    const rows = ventilationEntities(tx, config);
    for (const fan of VENTILATION_FANS) {
      const id = config[fan];
      if (!id) continue;
      const row = rows.find((entity) => entity.registryId === id);
      if (!row || row.registryId === row.entityId || row.registryId === `${row.platform}:${row.uniqueId}`) {
        throw new Error(`Choose an enabled HA sensor by its stable registry ID for ${fan}.`);
      }
      const cached = tx.select({ attributes: haEntityState.attributesJson })
        .from(haEntityState).where(eq(haEntityState.entityId, row.entityId)).get();
      const cachedUnit = cached?.attributes ? JSON.parse(cached.attributes).unit_of_measurement : undefined;
      const unit: unknown = cachedUnit ?? row.unit;
      if (unit != null && unit !== "%") throw new Error(`The ${fan} sensor must report percent.`);
    }
    if (rows.length === 2 && (!rows[0]?.deviceId || rows[0].deviceId !== rows[1]?.deviceId)) {
      throw new Error("Choose supply and extract sensors on the same HA device.");
    }
    const result = tx.update(householdSetting)
      .set({ ventilationFeedbackJson: JSON.stringify(config), updatedAtMs: Date.now(), updatedBy: null })
      .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
      .run();
    if (result.changes === 0) throw new Error("Set up the household before configuring ventilation feedback.");
    return config;
  });
}
