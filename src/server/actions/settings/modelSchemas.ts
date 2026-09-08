import "server-only";
import { z } from "zod";

/**
 * Input shapes for the house-model reconciliation actions.
 *
 * Separate module because `"use server"` files may only export functions. It sits beside
 * `schemas.ts` rather than inside it so the model slice's inputs travel with the model actions.
 *
 * A node id is checked here only for *shape* — that it looks like one of the package's semantic
 * ids. Whether the new revision actually contains it is a database question, answered inside the
 * write transaction by `decideReconciliationItem` (`unknown_node`); a client-side pattern is not
 * allowed to be the authority on that.
 */

/** Mirrors `IdSchema` in `src/house/model/schema.ts`: the ids the manifest is allowed to use. */
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const nodeIdText = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === "" || NODE_ID.test(value), "expected a semantic id like r-g-kitchen")
  .transform((value) => (value === "" ? null : value));

export const decideReconciliationItemInput = z.object({
  itemId: z.string().min(1),
  decision: z.enum(["remap", "keep", "archive"]),
  /**
   * Only meaningful for `remap`. Omitted (or empty) means "accept the proposal on the item", which
   * is what the row's suggested candidate is for.
   */
  newNodeId: nodeIdText.optional(),
  note: z.string().trim().max(500).optional(),
});

/** Applying and abandoning both name one plan; both carry an idempotency key. */
export const reconciliationActionInput = z.object({
  reconciliationId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

export type DecideReconciliationItemInput = z.infer<typeof decideReconciliationItemInput>;
