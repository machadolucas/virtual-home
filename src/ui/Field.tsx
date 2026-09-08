"use client";

import { useId, type ReactNode } from "react";
import { cn } from "./cn";

export interface FieldRenderArgs {
  /** Put this on the control; the label's `htmlFor` already points at it. */
  id: string;
  /** Pass as `aria-describedby` so help text and errors are announced. */
  describedBy: string | undefined;
  /** Pass as `aria-invalid`. */
  invalid: boolean;
  /** Pass as `aria-errormessage` when invalid (id of the error node). */
  errorId: string | undefined;
}

export interface FieldProps {
  label: ReactNode;
  /** Persistent guidance. Shown above the error, never replaced by it. */
  help?: ReactNode;
  /** When set, the field renders as invalid and announces this text. */
  error?: ReactNode;
  /** Marks the control as required and shows a text marker (not colour-only). */
  required?: boolean;
  /** Visually hide the label but keep it for assistive technology. */
  hideLabel?: boolean;
  className?: string;
  /** Force a specific control id (when the id must match something else). */
  id?: string;
  children: (args: FieldRenderArgs) => ReactNode;
}

/**
 * Label + control + help + error, wired together with real ids.
 *
 * Uses a render callback rather than cloning children: the control keeps full
 * control of its own props, and there is no hidden magic to debug when
 * `aria-describedby` goes missing.
 */
export function Field({
  label,
  help,
  error,
  required = false,
  hideLabel = false,
  className,
  id,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `f-${generated}`;
  const helpId = help ? `${controlId}-help` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={controlId}
        className={cn(
          "text-[0.8125rem] font-medium text-ink-2",
          hideLabel && "sr-only",
        )}
      >
        {label}
        {required ? (
          <span className="ml-1 font-normal text-ink-3">(required)</span>
        ) : null}
      </label>
      {children({ id: controlId, describedBy, invalid: Boolean(error), errorId })}
      {help ? (
        <p id={helpId} className="text-xs leading-5 text-ink-3">
          {help}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-xs leading-5 font-medium text-overdue"
        >
          <span aria-hidden="true">&#9650;</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
