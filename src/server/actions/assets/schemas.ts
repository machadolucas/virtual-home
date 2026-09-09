import "server-only";
import { z } from "zod";
import {
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  CONSUMABLE_ROLES,
  DATE_PRECISIONS,
  HA_LINK_ROLES,
  REPLACEMENT_REASONS,
  SYSTEM_KINDS,
  SYSTEM_STATUSES,
} from "@/db/schema";

/** Input shapes for the equipment actions. Separate module: `"use server"` files export only functions. */

export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const optionalText = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional();

export const assetFields = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES),
  manufacturer: optionalText,
  modelName: optionalText,
  serialNumber: optionalText,
  productCode: optionalText,
  locationId: z.string().min(1).nullable().optional(),
  parentAssetId: z.string().min(1).nullable().optional(),
  isVirtual: z.boolean().default(false),
  status: z.enum(ASSET_STATUSES).default("installed"),
  installedOn: localDate.nullable().optional(),
  installedOnPrecision: z.enum(DATE_PRECISIONS).nullable().optional(),
  purchasePriceCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  warrantyUntil: localDate.nullable().optional(),
  expectedLifeYears: z.number().int().min(0).max(200).nullable().optional(),
  /**
   * Free text, and the only place a "how to find it" note can live: there is no
   * `asset.location_note` column, and adding one is a schema change this slice does not own. The
   * form therefore asks for both in one field and labels it accordingly.
   */
  notes: z
    .string()
    .trim()
    .max(4000)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
});

export const consumableLine = z.object({
  partId: z.string().min(1),
  role: z.enum(CONSUMABLE_ROLES),
  qtyMilli: z.number().int().positive(),
  notes: optionalText,
});

export const createAssetInput = assetFields.extend({
  idempotencyKey: z.string().min(8).max(200).optional(),
  consumables: z.array(consumableLine).max(30).default([]),
  systemIds: z.array(z.string().min(1)).max(20).default([]),
  /** Link these HA entities straight away — the "create from HA device" path uses this. */
  haDeviceId: z.string().min(1).nullable().optional(),
  haEntityLinks: z
    .array(
      z.object({
        registryId: z.string().min(1),
        role: z.enum(HA_LINK_ROLES),
      }),
    )
    .max(30)
    .default([]),
});

export const updateAssetInput = assetFields.extend({
  assetId: z.string().min(1),
});

export const setConsumablesInput = z.object({
  assetId: z.string().min(1),
  consumables: z.array(consumableLine).max(30),
});

export const retireAssetInput = z.object({
  assetId: z.string().min(1),
  /** `removed` when it is physically gone, `retired` when it is still there but out of service. */
  status: z.enum(["removed", "retired", "lost"]),
  removedOn: localDate,
  notes: optionalText,
});

/** One atomic list-page removal. Kept bounded so a browser cannot hold the write lock indefinitely. */
export const bulkRemoveAssetsInput = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(1000).refine(
    (ids) => new Set(ids).size === ids.length,
    "equipment ids must be unique",
  ),
  idempotencyKey: z.string().min(8).max(200),
});

export const permanentlyDeleteAssetsInput = z.object({
  assetIds: z.array(z.string().min(1)).min(1).max(1000).refine(
    (ids) => new Set(ids).size === ids.length,
    "equipment ids must be unique",
  ),
  idempotencyKey: z.string().min(8).max(200),
});

/**
 * The replacement flow. Exactly one of `newAsset` / `existingAssetId` — the domain's
 * `NewAssetInput | ExistingAssetRef` union, expressed so a form can post either.
 */
export const replaceAssetInput = z
  .object({
    oldAssetId: z.string().min(1),
    replacedOn: localDate,
    reason: z.enum(REPLACEMENT_REASONS),
    notes: z
      .string()
      .trim()
      .max(2000)
      .transform((value) => (value === "" ? null : value))
      .nullable()
      .optional(),
    cloneConsumables: z.boolean().default(true),
    cloneHaLinks: z.boolean().default(false),
    existingAssetId: z.string().min(1).nullable().optional(),
    newAsset: assetFields.partial().optional(),
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .refine(
    (value) =>
      (value.existingAssetId != null) !== (value.newAsset !== undefined && value.newAsset !== null),
    {
      message: "choose either a brand-new unit or an existing spare, not both",
      path: ["existingAssetId"],
    },
  );

export const linkHaEntityInput = z.object({
  assetId: z.string().min(1),
  registryId: z.string().min(1),
  role: z.enum(HA_LINK_ROLES),
  notes: optionalText,
});

export const linkHaDeviceInput = z.object({
  assetId: z.string().min(1),
  deviceId: z.string().min(1),
  role: z.enum(HA_LINK_ROLES).default("primary"),
  notes: optionalText,
});

export const unlinkHaInput = z.object({
  assetId: z.string().min(1),
  linkId: z.string().min(1),
});

export const relinkHaInput = z.object({
  assetId: z.string().min(1),
  linkId: z.string().min(1),
  /** The live registry entry to repoint at. */
  registryId: z.string().min(1),
});

export const setLinkStateInput = z.object({
  assetId: z.string().min(1),
  linkId: z.string().min(1),
  linkState: z.enum(["active", "retired"]),
});

export const upsertSystemInput = z.object({
  systemId: z.string().min(1).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SYSTEM_KINDS),
  status: z.enum(SYSTEM_STATUSES).default("active"),
  description: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional(),
  members: z
    .array(z.object({ assetId: z.string().min(1), role: optionalText }))
    .max(200)
    .default([]),
  locationIds: z.array(z.string().min(1)).max(100).default([]),
});

export const deleteSystemInput = z.object({ systemId: z.string().min(1) });

export type CreateAssetInput = z.infer<typeof createAssetInput>;
export type UpdateAssetInput = z.infer<typeof updateAssetInput>;
export type ReplaceAssetFormInput = z.infer<typeof replaceAssetInput>;
export type UpsertSystemInput = z.infer<typeof upsertSystemInput>;
