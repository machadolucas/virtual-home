"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  HOUSEHOLD_SETTING_ID,
  appAlert,
  householdSetting,
  user,
  userNotifyDevice,
} from "@/db/schema";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { readHouseholdRow, userContext } from "@/server/queries/settings/household";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import { DEFAULT_HOUSE_BACKGROUND, sameBackground } from "@/house/model/background";
import {
  acknowledgeAlertInput,
  addNotifyDeviceInput,
  householdSettingsInput,
  removeNotifyDeviceInput,
  setNotifyDeviceActiveInput,
  updateDisplayColorInput,
  updateHouseBackgroundInput,
} from "./schemas";

/**
 * Household settings, display colours, notify devices and alert acknowledgement.
 *
 * Note what is absent: creating a user, changing anybody's password, deleting a member. Those need
 * access to the machine (`pnpm vh-admin`) by design — there is no privileged tier in the browser to
 * do them from, and a household of two does not need one
 * (`docs/design-notes/auth-security-operations.md` §4.1).
 */

export const updateHouseholdSettings = action(householdSettingsInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const before = readHouseholdRow(tx);
      const next = {
        displayName: input.displayName,
        timezone: input.timezone,
        deliveryTime: input.deliveryTime,
        reminderIntervalDays: input.reminderIntervalDays,
        sendWindowStart: input.sendWindowStart,
        sendWindowEnd: input.sendWindowEnd,
        catchupGapMinutes: input.catchupGapMinutes,
        catchupDigestThreshold: input.catchupDigestThreshold,
        slotGraceMinutes: input.slotGraceMinutes,
        actionTtlDays: input.actionTtlDays,
        batteryThresholdPct: input.batteryThresholdPct,
        batteryClearPct: input.batteryClearPct,
        batterySustainMinutes: input.batterySustainMinutes,
        batteryClearSustainMinutes: input.batteryClearSustainMinutes,
        batteryStaleHours: input.batteryStaleHours,
        reorderHorizonDays: input.reorderHorizonDays,
        haBaseUrl: input.haBaseUrl,
        inventoryPushEnabled: input.inventoryPushEnabled,
        updatedAtMs: nowMs(),
        updatedBy: ctx.actorUserId,
      };
      tx.update(householdSetting)
        .set(next)
        .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
        .run();

      const changes: Record<string, [unknown, unknown]> = {};
      for (const [key, value] of Object.entries(next)) {
        if (key === "updatedAtMs" || key === "updatedBy") continue;
        const previous = (before as unknown as Record<string, unknown>)[key];
        if (previous !== value) changes[key] = [previous, value];
      }
      if (Object.keys(changes).length > 0) {
        writeAudit(tx, ctx, {
          entityTable: "household_setting",
          entityId: HOUSEHOLD_SETTING_ID,
          action: "updated",
          summary: `household settings updated (${Object.keys(changes).join(", ")})`,
          changes,
        });
      }
    }),
  );
  // The time zone and the reorder horizon change what nearly every page computes.
  revalidatePath("/", "layout");
  return { ok: true as const };
});

/**
 * The 3D view's background.
 *
 * Household-level, like the time zone and the notification window: the model is the household's,
 * there are two people looking at it, and a per-person viewer theme would mean the two of them
 * describing different pictures to each other over the phone. The UI says so in words.
 *
 * `{ mode: "theme" }` is stored as NULL rather than as JSON, so "we have never chosen" and "we
 * chose to follow the theme" are the same row — there is no difference worth keeping.
 */
export const updateHouseBackground = action(updateHouseBackgroundInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const before = readHouseholdRow(tx);
      const value = sameBackground(input.background, DEFAULT_HOUSE_BACKGROUND)
        ? null
        : JSON.stringify(input.background);
      if (value === before.houseBackgroundJson) return;
      tx.update(householdSetting)
        .set({ houseBackgroundJson: value, updatedAtMs: nowMs(), updatedBy: ctx.actorUserId })
        .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "household_setting",
        entityId: HOUSEHOLD_SETTING_ID,
        action: "updated",
        summary: `3D background set to ${input.background.mode}`,
        changes: { house_background_json: [before.houseBackgroundJson, value] },
      });
    }),
  );
  revalidatePath("/house");
  revalidatePath("/settings/household");
  return { ok: true as const };
});

/**
 * A display colour is the one profile field editable from the browser, because it is the one that
 * is purely cosmetic: it tints avatars and attribution chips and grants nothing.
 */
export const updateDisplayColor = action(updateDisplayColorInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx.select().from(user).where(eq(user.id, input.userId)).get();
      if (!row) throw new NotFoundError("user", input.userId);
      tx.update(user)
        .set({ displayColor: input.displayColor, updatedAt: new Date(nowMs()) })
        .where(eq(user.id, input.userId))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "user",
        entityId: input.userId,
        action: "updated",
        summary: `display colour for ${row.name} set to ${input.displayColor ?? "the default"}`,
        changes: { display_color: [row.displayColor, input.displayColor] },
      });
    }),
  );
  revalidatePath("/settings/users");
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const addNotifyDevice = action(addNotifyDeviceInput, async (input, session) => {
  const { db } = getDb();
  const deviceId = mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const owner = tx.select().from(user).where(eq(user.id, input.userId)).get();
      if (!owner) throw new NotFoundError("user", input.userId);
      const existing = tx
        .select({ id: userNotifyDevice.id, userId: userNotifyDevice.userId })
        .from(userNotifyDevice)
        .where(eq(userNotifyDevice.notifyService, input.notifyService))
        .get();
      if (existing) {
        // `ux_notify_device_service` is global, not per user: one phone reaches one person, and a
        // service registered twice would double every reminder.
        throw new ValidationError(
          "notify_service_taken",
          "that notification service is already registered to somebody",
          { deviceId: existing.id },
        );
      }
      const id = newId();
      tx.insert(userNotifyDevice)
        .values({
          id,
          userId: input.userId,
          label: input.label,
          notifyService: input.notifyService,
          haDeviceName: input.haDeviceName ?? null,
          isActive: true,
          createdAtMs: nowMs(),
          createdBy: ctx.actorUserId,
        })
        .run();
      writeAudit(tx, ctx, {
        entityTable: "user_notify_device",
        entityId: id,
        action: "created",
        summary: `${input.label} (${input.notifyService}) added for ${owner.name}`,
      });
      return id;
    }),
  );
  revalidatePath("/settings/users");
  return { deviceId };
});

export const setNotifyDeviceActive = action(setNotifyDeviceActiveInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx
        .select()
        .from(userNotifyDevice)
        .where(eq(userNotifyDevice.id, input.deviceId))
        .get();
      if (!row) throw new NotFoundError("user_notify_device", input.deviceId);
      tx.update(userNotifyDevice)
        .set({ isActive: input.isActive })
        .where(eq(userNotifyDevice.id, input.deviceId))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "user_notify_device",
        entityId: input.deviceId,
        action: "updated",
        summary: `${row.label} ${input.isActive ? "enabled" : "muted"}`,
        changes: { is_active: [row.isActive, input.isActive] },
      });
    }),
  );
  revalidatePath("/settings/users");
  return { ok: true as const };
});

export const removeNotifyDevice = action(removeNotifyDeviceInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx
        .select()
        .from(userNotifyDevice)
        .where(eq(userNotifyDevice.id, input.deviceId))
        .get();
      if (!row) throw new NotFoundError("user_notify_device", input.deviceId);
      tx.delete(userNotifyDevice).where(eq(userNotifyDevice.id, input.deviceId)).run();
      writeAudit(tx, ctx, {
        entityTable: "user_notify_device",
        entityId: input.deviceId,
        action: "deleted",
        summary: `${row.label} (${row.notifyService}) removed`,
      });
    }),
  );
  revalidatePath("/settings/users");
  return { ok: true as const };
});

/**
 * Acknowledge an alert: "I have seen this", not "this is fixed".
 *
 * `resolved_at_ms` stays null, so the partial unique index keeps deduplicating and the worker will
 * re-raise nothing. Only the condition that caused it going away resolves it — a human ticking a
 * box does not make a battery full.
 */
export const acknowledgeAlert = action(acknowledgeAlertInput, async (input, session) => {
  const { db } = getDb();
  mapDomainErrors(() =>
    writeTx(db, (tx) => {
      const ctx = userContext(session, tx);
      const row = tx.select().from(appAlert).where(eq(appAlert.id, input.alertId)).get();
      if (!row) throw new NotFoundError("app_alert", input.alertId);
      tx.update(appAlert)
        .set({ acknowledgedAtMs: nowMs(), acknowledgedBy: ctx.actorUserId })
        .where(eq(appAlert.id, input.alertId))
        .run();
      writeAudit(tx, ctx, {
        entityTable: "app_alert",
        entityId: input.alertId,
        action: "acknowledged",
        summary: `alert acknowledged: ${row.title}`,
      });
    }),
  );
  revalidatePath("/settings/system");
  return { ok: true as const };
});
