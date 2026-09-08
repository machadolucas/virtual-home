"use client";
/**
 * Calling a maintenance server action from a client component.
 *
 * `action()` never throws across the wire: it returns `{ ok: false, error, details }`. This hook
 * keeps that shape instead of flattening it, because the error *code* is what several dialogs
 * branch on — `insufficient_stock` has to reach the completion form with its lines (§5.3), and
 * `successor_touched` has to reach the void dialog with what is blocking it.
 */
import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/ui";

/**
 * The shape `action()` returns. Declared here rather than type-imported from
 * `@/server/api/action`, which is `server-only`: a type import is erased, but keeping the client
 * bundle's import graph free of server modules is one less thing to get wrong later.
 */
export type ActionResult<O> =
  | { ok: true; data: O }
  | { ok: false; error: string; details?: unknown };

export interface ActionFailure {
  error: string;
  details?: unknown;
}

export interface UseActionOptions {
  /** Shown as a success toast. Omit for actions whose result is visible on the page. */
  success?: string;
  /** Refresh the route's server components after a success. Default `true`. */
  refresh?: boolean;
  /** Called on success, before the refresh. */
  onDone?: () => void;
}

export interface UseActionState<I, O> {
  run: (input: I) => Promise<O | null>;
  pending: boolean;
  failure: ActionFailure | null;
  clearFailure: () => void;
}

/** Human wording for the error codes these screens can actually produce. */
export const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: "Your session has expired. Sign in again.",
  invalid_request: "Something in the form is not valid.",
  not_found: "That record no longer exists.",
  occurrence_not_open: "This task is no longer open — someone may have just closed it.",
  already_closed: "This task was already closed.",
  already_blocked: "This task is already blocked.",
  not_blocked: "This task is not blocked.",
  already_booked: "This task already has a booking.",
  already_voided: "That completion has already been voided.",
  successor_touched:
    "The follow-up task has already been worked on, so this cannot be undone automatically. Deal with that task first.",
  reopen_window_expired: "This was closed too long ago to reopen.",
  postpone_in_past: "A postpone cannot move the due date backwards.",
  postpone_too_far: "That is further than a postpone may reach from the original due date.",
  not_a_recipient: "This task is assigned to the other member, so you have no reminder to snooze.",
  recipient_not_active: "There is no active reminder to snooze.",
  insufficient_stock: "There is not enough of one or more parts in stock.",
  no_draft: "There is no draft to work with.",
  no_steps: "Add at least one step before publishing.",
  plan_cancelled: "This plan has been cancelled.",
  internal: "Something went wrong. Nothing was changed.",
};

export function messageFor(failure: ActionFailure): string {
  return ERROR_MESSAGES[failure.error] ?? `The action failed (${failure.error}).`;
}

export function useAction<I, O>(
  fn: (input: I) => Promise<ActionResult<O>>,
  options: UseActionOptions = {},
): UseActionState<I, O> {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);

  const run = useCallback(
    async (input: I): Promise<O | null> => {
      setBusy(true);
      setFailure(null);
      try {
        const result = await fn(input);
        if (!result.ok) {
          setFailure({ error: result.error, details: result.details });
          // `insufficient_stock` is handled inline by the form, so it is not also shouted about.
          if (result.error !== "insufficient_stock") {
            toast({ title: messageFor({ error: result.error }), tone: "error", duration: 0 });
          }
          return null;
        }
        if (options.success !== undefined) {
          toast({ title: options.success, tone: "success" });
        }
        options.onDone?.();
        if (options.refresh !== false) startTransition(() => router.refresh());
        return result.data;
      } finally {
        setBusy(false);
      }
    },
    [fn, options, router],
  );

  return {
    run,
    pending: busy || pending,
    failure,
    clearFailure: useCallback(() => setFailure(null), []),
  };
}

/** A stable idempotency / request key for the lifetime of one form instance. */
export function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
