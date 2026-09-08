import "server-only";
import { z } from "zod";
import { CONDITION_RULE_KINDS, HA_LINK_ROLES, PRIORITIES } from "@/db/schema";

/** Input shapes for the Home Assistant settings actions. */

export const decideMappingInput = z.object({
  haKind: z.enum(["area", "floor"]),
  haId: z.string().min(1),
  /** Required for `confirm`; ignored for `reject`. */
  locationId: z.string().min(1).nullable().optional(),
  decision: z.enum(["confirm", "reject", "clear"]),
});

/**
 * Create equipment from a cached HA device and link its entities in one go.
 *
 * The role per entity is explicit rather than guessed: `battery_level` decides what the
 * low-battery rule watches, and guessing that from a device class would quietly point a rule at
 * the wrong sensor.
 */
export const importDeviceInput = z.object({
  deviceId: z.string().min(1),
  /** `null` creates a new asset; a value links the device to that existing one. */
  existingAssetId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  category: z.string().min(1),
  manufacturer: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
  modelName: z
    .string()
    .trim()
    .max(200)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
  locationId: z.string().min(1).nullable().optional(),
  isVirtual: z.boolean().default(false),
  /** Link the device row itself, in addition to the entities. */
  linkDevice: z.boolean().default(true),
  entities: z
    .array(z.object({ registryId: z.string().min(1), role: z.enum(HA_LINK_ROLES) }))
    .max(50)
    .default([]),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const upsertConditionRuleInput = z
  .object({
    ruleId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(CONDITION_RULE_KINDS),
    scope: z.enum(["all_batteries", "asset", "entity"]),
    assetId: z.string().min(1).nullable().optional(),
    haEntityRegistryId: z.string().min(1).nullable().optional(),
    thresholdPct: z.number().int().min(0).max(100).nullable().optional(),
    clearThresholdPct: z.number().int().min(0).max(100).nullable().optional(),
    sustainMinutes: z.number().int().min(0).max(20_160).nullable().optional(),
    clearSustainMinutes: z.number().int().min(0).max(20_160).nullable().optional(),
    defaultPartId: z.string().min(1).nullable().optional(),
    priority: z.enum(PRIORITIES).default("normal"),
    titleTemplate: z.string().trim().min(1).max(200),
    enabled: z.boolean().default(true),
  })
  .refine((value) => value.scope !== "asset" || value.assetId != null, {
    message: "a rule scoped to one piece of equipment needs that equipment",
    path: ["assetId"],
  })
  .refine((value) => value.scope !== "entity" || value.haEntityRegistryId != null, {
    message: "a rule scoped to one entity needs that entity",
    path: ["haEntityRegistryId"],
  })
  .refine(
    (value) =>
      value.thresholdPct == null ||
      value.clearThresholdPct == null ||
      value.clearThresholdPct > value.thresholdPct,
    {
      message:
        "the clear level must be above the low level, or the rule would open and close forever on a battery sitting on the line",
      path: ["clearThresholdPct"],
    },
  );

export const setConditionRuleEnabledInput = z.object({
  ruleId: z.string().min(1),
  enabled: z.boolean(),
});

export const deleteConditionRuleInput = z.object({ ruleId: z.string().min(1) });

export type ImportDeviceInput = z.infer<typeof importDeviceInput>;
export type UpsertConditionRuleInput = z.infer<typeof upsertConditionRuleInput>;
