import "server-only";
import { z } from "zod";
import {
  COMPATIBILITY_CONFIDENCES,
  PART_TRACKING_MODES,
  PART_UNITS,
  STOCK_TRANSACTION_REASONS,
} from "@/db/schema";

/**
 * Input shapes for the inventory actions.
 *
 * Kept out of the `"use server"` modules on purpose: a `"use server"` file may only export async
 * functions, so every schema, constant and type lives here instead.
 */

/** `YYYY-MM-DD`; the domain re-validates, this just keeps obvious junk out of the transaction. */
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Integer thousandths. Never a float: 2 pcs is 2000, and 2000.5 is a bug. */
export const milli = z.number().int();
export const positiveMilli = z.number().int().positive();

const optionalText = z
  .string()
  .trim()
  .max(500)
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional();

const optionalUrl = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => value === "" || /^https?:\/\//.test(value),
    "a supplier link must be an http(s) URL",
  )
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .optional();

export const partFields = z.object({
  name: z.string().trim().min(1).max(200),
  spec: optionalText,
  dimensions: optionalText,
  manufacturer: optionalText,
  productCode: optionalText,
  ean: optionalText,
  trackingMode: z.enum(PART_TRACKING_MODES),
  unit: z.enum(PART_UNITS),
  isKit: z.boolean().default(false),
  /** Only a kit may be `not_stocked` (a pure bill of materials). */
  stocked: z.boolean().default(true),
  reorderThresholdMilli: milli.nonnegative().nullable().optional(),
  reorderTargetMilli: milli.nonnegative().nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  defaultStoragePlaceId: z.string().min(1).nullable().optional(),
  tracksLots: z.boolean().default(false),
  notes: z.string().trim().max(4000).transform((v) => (v === "" ? null : v)).nullable().optional(),
});

export const createPartInput = partFields.extend({
  idempotencyKey: z.string().min(8).max(200).optional(),
  components: z
    .array(z.object({ componentPartId: z.string().min(1), qtyMilli: positiveMilli }))
    .max(50)
    .default([]),
  suppliers: z
    .array(
      z.object({
        supplierName: z.string().trim().min(1).max(200),
        supplierSku: optionalText,
        url: optionalUrl,
        lastPriceCents: z.number().int().nonnegative().nullable().optional(),
        currency: z.string().trim().length(3).nullable().optional(),
        packQtyMilli: positiveMilli.nullable().optional(),
        leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
        isPreferred: z.boolean().default(false),
        note: optionalText,
      }),
    )
    .max(10)
    .default([]),
  compatibility: z
    .array(
      z.object({
        assetId: z.string().min(1).nullable().optional(),
        assetModelName: optionalText,
        manufacturer: optionalText,
        confidence: z.enum(COMPATIBILITY_CONFIDENCES),
        note: optionalText,
      }),
    )
    .max(50)
    .default([]),
});

export const updatePartInput = partFields.extend({
  partId: z.string().min(1),
});

export const setKitComponentsInput = z.object({
  partId: z.string().min(1),
  components: z
    .array(z.object({ componentPartId: z.string().min(1), qtyMilli: positiveMilli }))
    .max(50),
});

export const upsertSupplierInput = z.object({
  partId: z.string().min(1),
  supplierId: z.string().min(1).nullable().optional(),
  supplierName: z.string().trim().min(1).max(200),
  supplierSku: optionalText,
  url: optionalUrl,
  lastPriceCents: z.number().int().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).nullable().optional(),
  packQtyMilli: positiveMilli.nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  isPreferred: z.boolean().default(false),
  note: optionalText,
});

export const removeSupplierInput = z.object({
  partId: z.string().min(1),
  supplierId: z.string().min(1),
});

export const addPurchaseInput = z.object({
  partId: z.string().min(1),
  qtyMilli: positiveMilli,
  lotId: z.string().min(1).nullable().optional(),
  storagePlaceId: z.string().min(1).nullable().optional(),
  unitPriceCents: z.number().int().nonnegative().nullable().optional(),
  /** Household-local date the goods arrived; defaults to today when omitted. */
  occurredOn: localDate.optional(),
  notes: optionalText,
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const stockTakeInput = z.object({
  partId: z.string().min(1),
  countedMilli: milli.nonnegative(),
  lotId: z.string().min(1).nullable().optional(),
  occurredOn: localDate.optional(),
  notes: optionalText,
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const explodeKitInput = z.object({
  kitPartId: z.string().min(1),
  count: z.number().int().positive().max(1000),
  storagePlaceId: z.string().min(1).nullable().optional(),
  notes: optionalText,
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const undoExplodeInput = z.object({
  kitPartId: z.string().min(1),
  groupId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const correctTransactionInput = z.object({
  partId: z.string().min(1),
  transactionId: z.string().min(1),
  reason: z.enum(STOCK_TRANSACTION_REASONS),
  notes: z.string().trim().min(1, "say why — a correction with no reason is unauditable").max(500),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export const setEstimateInput = z.object({
  partId: z.string().min(1),
  lotId: z.string().min(1),
  estimatePct: z.number().int().min(0).max(100),
  notes: optionalText,
});

export const upsertLotInput = z.object({
  partId: z.string().min(1),
  lotId: z.string().min(1).nullable().optional(),
  label: z.string().trim().min(1).max(120),
  storagePlaceId: z.string().min(1).nullable().optional(),
  purchasedOn: localDate.nullable().optional(),
  expiresOn: localDate.nullable().optional(),
  openedOn: localDate.nullable().optional(),
  initialQtyMilli: milli.nonnegative().nullable().optional(),
  isOpen: z.boolean().default(false),
  notes: optionalText,
});

export const archivePartInput = z.object({
  partId: z.string().min(1),
  archived: z.boolean(),
});

export type CreatePartInput = z.infer<typeof createPartInput>;
export type UpdatePartInput = z.infer<typeof updatePartInput>;
export type AddPurchaseInput = z.infer<typeof addPurchaseInput>;
export type StockTakeInput = z.infer<typeof stockTakeInput>;
export type ExplodeKitInput = z.infer<typeof explodeKitInput>;
export type CorrectTransactionInput = z.infer<typeof correctTransactionInput>;
export type SetEstimateInput = z.infer<typeof setEstimateInput>;
export type UpsertLotInput = z.infer<typeof upsertLotInput>;
export type UpsertSupplierInput = z.infer<typeof upsertSupplierInput>;
