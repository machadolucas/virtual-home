"use client";

import { useCallback, useState, useTransition } from "react";
import { toast } from "@/ui";

/**
 * Calling a server action from a client component: pending state, an error message that says what
 * did *not* change, and a toast on success.
 *
 * It lives in `features/settings` because the supplies, equipment and settings screens all need it
 * and these three feature folders are the only shared home this slice owns. Nothing about it is
 * settings-specific.
 *
 * Two behaviours worth knowing:
 *  - The idempotency key covers **one submit and the retries of that submit**, not the component's
 *    lifetime. A double-clicked button replays the first result instead of writing twice, and a
 *    retry after a refusal reuses the key (the mutation may have committed with the response
 *    lost); a *success* mints a new one. Minting it once per hook instance instead would swallow
 *    the second real submit from anything that stays mounted — a dialog that records a purchase,
 *    reopens and records another — because `action()` replays a stored response by key alone and
 *    would answer the second submit with the first one's data.
 *  - `reset()` starts a new key *and* clears the error and the last result, for a form starting
 *    over. Nothing has to call it just to submit twice.
 *  - `error` holds the domain's own `code` mapped to a sentence. A code with no mapping is shown
 *    verbatim rather than replaced by "something went wrong": an unfamiliar code is still a
 *    better clue than no clue.
 */

export type ActionResult<O> =
  | { ok: true; data: O }
  | { ok: false; error: string; details?: unknown };

export interface UseActionOptions<O> {
  /** Toast title on success. Omit for a silent action (a filter, a read). */
  successTitle?: string;
  successDescription?: (data: O) => string | undefined;
  onSuccess?: (data: O) => void;
  /**
   * Called with the mapped message when the action refuses.
   *
   * The reason this exists: an optimistic control has to put the picture back, and doing that in an
   * effect keyed on `error` is a setState-in-effect cascade. Here it happens in the same transition
   * as the failure.
   */
  onError?: (message: string) => void;
  /** Extra codes this call can produce, mapped to sentences. */
  messages?: Record<string, string>;
}

/** Codes every action can return, plus the domain codes the inventory/asset slice throws. */
const BASE_MESSAGES: Record<string, string> = {
  unauthorized: "Your session expired. Reload the page and sign in again.",
  invalid_request: "Some of the values were not accepted. Check the highlighted fields.",
  internal: "The server could not complete that. Nothing was changed.",
  not_found: "That record no longer exists. Reload the page.",
  conflict: "Somebody else changed this at the same time. Reload and try again.",

  // Inventory
  already_reversed: "That movement has already been corrected, so it cannot be corrected twice.",
  qty_zero: "A movement of zero says nothing. Enter an amount.",
  qty_sign: "That amount has the wrong sign for this kind of movement.",
  qty_not_whole_unit: "This item is counted in whole units. Enter a whole number.",
  not_a_kit: "That item is not a kit, so it cannot be opened.",
  kit_empty: "This kit has no contents listed yet, so there is nothing to move.",
  not_a_kit_explode: "That group of movements is not a kit being opened.",
  part_not_estimated: "Only an item tracked as an estimate carries a percentage.",
  lot_initial_qty_missing: "Set the container's full size first, or a percentage means nothing.",
  estimate_pct_invalid: "The estimate must be a whole percentage between 0 and 100.",
  counted_invalid: "The counted amount must be zero or more.",
  lot_part_mismatch: "That lot belongs to a different item.",
  is_kit_immutable:
    "Whether an item is a kit cannot be changed later — its existing movements mean different things on each side of that line.",
  unit_immutable_with_history:
    "The unit cannot be changed once this item has movements: every recorded amount is counted in it, so changing it would quietly rewrite the whole ledger. Archive this item and add it again with the right unit.",
  tracking_mode_immutable_with_history:
    "This item cannot switch to whole units only once it has movements — an amount already recorded as a fraction could not be stated any more.",
  nested_kit: "A kit inside a kit is not supported. List the individual parts instead.",
  reorder_target_below_threshold:
    "The reorder target must be at least the threshold, or every order would leave the item still low.",
  part_does_not_track_lots: "Turn on lot tracking for this item before adding a lot.",

  // Equipment and Home Assistant
  already_replaced: "This unit has already been replaced. Its successor holds the record now.",
  replacement_is_same_asset: "A unit cannot replace itself.",
  replacement_cycle: "That unit is already part of this replacement chain.",
  link_not_missing:
    "Only a link whose Home Assistant entry has disappeared can be repointed.",
  link_still_missing:
    "The Home Assistant entry is still gone. Repoint the link instead of marking it active.",
  link_asset_mismatch: "That link belongs to another piece of equipment.",
  device_already_linked: "This equipment already has an inactive link to that device. Restore or remove that link first.",
  entity_already_linked: "That entity is already linked to this equipment. Remove its existing link before changing its role.",
  ha_role_taken: "This equipment already has an entity in that role. Remove the existing link first, or choose another role.",
  entity_removed: "That Home Assistant entry is itself gone.",
  device_removed: "That device is no longer in Home Assistant's registry.",
  system_has_plans: "Scheduled work points at this system. Retarget or cancel it first.",
  rule_has_history:
    "This rule has already produced tasks, so it cannot be deleted. Disable it instead.",
  notify_service_taken: "That notification service is already registered to somebody.",
  status_not_creatable:
    "Add the unit as planned or in service, then retire it — that records the date.",
  unsafe_path: "That is not a directory inside the incoming folder.",
  invalid_package: "The package has validation errors and was not installed.",
};

export interface UseActionReturn<I, O> {
  run: (input: I) => void;
  pending: boolean;
  error: string | null;
  /** Field-level messages from a zod failure, when the action returned `invalid_request`. */
  fieldErrors: Record<string, string[]>;
  data: O | null;
  reset: () => void;
  /**
   * Pass into the action input so a double submit replays instead of repeating. Read it at submit
   * time — it changes after every success, which is what lets the same form submit twice.
   */
  idempotencyKey: string;
}

export function useAction<I, O>(
  fn: (input: I) => Promise<ActionResult<O>>,
  options: UseActionOptions<O> = {},
): UseActionReturn<I, O> {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [data, setData] = useState<O | null>(null);
  // State rather than a ref: the key is part of what the hook returns, and reading a ref during
  // render is exactly the pattern that makes a component miss an update.
  const [idempotencyKey, setIdempotencyKey] = useState(freshKey);

  const reset = useCallback(() => {
    setIdempotencyKey(freshKey());
    setError(null);
    setFieldErrors({});
    setData(null);
  }, []);

  const run = useCallback(
    (input: I) => {
      setError(null);
      setFieldErrors({});
      startTransition(async () => {
        const result = await fn(input);
        if (result.ok) {
          setData(result.data);
          // The key has done its job. Rotating it here — and only here — is what makes the next
          // submit a real second write instead of a replay of this one, while a retry after a
          // failure still carries the key that may already have committed.
          setIdempotencyKey(freshKey());
          if (options.successTitle !== undefined) {
            toast({
              title: options.successTitle,
              description: options.successDescription?.(result.data),
              tone: "success",
            });
          }
          options.onSuccess?.(result.data);
          return;
        }
        const message =
          options.messages?.[result.error] ?? BASE_MESSAGES[result.error] ?? result.error;
        setError(message);
        setFieldErrors(extractFieldErrors(result.details));
        options.onError?.(message);
        toast({ title: "Not saved", description: message, tone: "error", duration: 0 });
      });
    },
    // `options` is recreated on every render by every caller, so depending on it would rebuild
    // `run` constantly. The fields we read are stable in practice (literals and stable callbacks).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  );

  return { run, pending, error, fieldErrors, data, reset, idempotencyKey };
}

function freshKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** `zod`'s `flatten()` shape, read defensively — it is JSON that crossed a network boundary. */
function extractFieldErrors(details: unknown): Record<string, string[]> {
  if (details === null || typeof details !== "object") return {};
  const flattened = (details as { fieldErrors?: unknown }).fieldErrors;
  if (flattened === null || typeof flattened !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(flattened as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return out;
}
