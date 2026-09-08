import "server-only";
import { z } from "zod";

/** Input shapes for the settings actions. Separate module: `"use server"` files export only functions. */

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM (24-hour)");

/**
 * The household form.
 *
 * Every bound here mirrors a CHECK in `household_setting`, so a value that passes zod is a value
 * SQLite will accept — the alternative is a constraint violation surfacing as `"internal"`.
 */
export const householdSettingsInput = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    timezone: z
      .string()
      .min(1)
      .refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "unknown IANA time zone"),
    deliveryTime: localTime,
    reminderIntervalDays: z.number().int().min(1).max(365),
    sendWindowStart: localTime,
    sendWindowEnd: localTime,
    catchupGapMinutes: z.number().int().min(1).max(10_080),
    catchupDigestThreshold: z.number().int().min(1).max(100),
    slotGraceMinutes: z.number().int().min(0).max(1440),
    actionTtlDays: z.number().int().min(1).max(365),
    batteryThresholdPct: z.number().int().min(0).max(100),
    batteryClearPct: z.number().int().min(0).max(100),
    batterySustainMinutes: z.number().int().min(0).max(20_160),
    batteryClearSustainMinutes: z.number().int().min(0).max(20_160),
    batteryStaleHours: z.number().int().min(1).max(8760),
    reorderHorizonDays: z.number().int().min(1).max(3650),
    haBaseUrl: z
      .string()
      .trim()
      .min(1)
      .refine((value) => /^https?:\/\//.test(value), "expected an http(s) URL"),
    inventoryPushEnabled: z.boolean(),
  })
  .refine((value) => value.batteryClearPct > value.batteryThresholdPct, {
    message:
      "the clear level must be above the low level, or a battery hovering on the line would open and close a task forever",
    path: ["batteryClearPct"],
  })
  .refine((value) => value.sendWindowStart < value.sendWindowEnd, {
    message: "the send window must start before it ends",
    path: ["sendWindowEnd"],
  });

export const updateDisplayColorInput = z.object({
  userId: z.string().min(1),
  /** Lowercase `#rrggbb` — the CHECK is a GLOB, so anything else is rejected by SQLite too. */
  displayColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-f]{6}$/, "expected a lowercase #rrggbb colour")
    .nullable(),
});

export const addNotifyDeviceInput = z.object({
  userId: z.string().min(1),
  label: z.string().trim().min(1).max(120),
  notifyService: z
    .string()
    .trim()
    .regex(/^notify\.[a-z0-9_]+$/, "expected a service like notify.mobile_app_my_phone"),
  haDeviceName: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

export const removeNotifyDeviceInput = z.object({ deviceId: z.string().min(1) });

export const setNotifyDeviceActiveInput = z.object({
  deviceId: z.string().min(1),
  isActive: z.boolean(),
});

export const installPackageInput = z.object({
  /**
   * A directory *name* inside `model-incoming`, never a path: the action joins it itself, so a
   * caller cannot walk out of the incoming directory.
   */
  directoryName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) => !value.includes("/") && !value.includes("\\") && !value.startsWith("."),
      "expected a directory name inside model-incoming",
    ),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const acknowledgeAlertInput = z.object({ alertId: z.string().min(1) });

export type HouseholdSettingsInput = z.infer<typeof householdSettingsInput>;
export type AddNotifyDeviceInput = z.infer<typeof addNotifyDeviceInput>;
