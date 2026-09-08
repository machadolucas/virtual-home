"use client";

import { Checkbox as RadixCheckbox } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn, focusRing } from "./cn";

export interface CheckboxProps {
  /** Force a specific id. Omitted, one is generated — the label still points at it. */
  id?: string;
  name?: string;
  value?: string;
  checked?: boolean | "indeterminate";
  defaultChecked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean | "indeterminate") => void;
  disabled?: boolean;
  required?: boolean;
  describedBy?: string;
  /** Accessible name when there is no visible label and no external `<label htmlFor>`. */
  ariaLabel?: string;
  /** Inline label. Omit only when an external `<label htmlFor>` exists. */
  label?: ReactNode;
  /** Secondary line under the label. */
  hint?: ReactNode;
  className?: string;
}

/**
 * The box is 18 px but the clickable row is at least 44 px tall on phones, so
 * the target is comfortable without a giant checkbox.
 *
 * The id is generated when the caller does not supply one. It has to be: the
 * visible label is a *sibling* of the control, not its parent, so without a
 * resolving `htmlFor` the box has no accessible name at all and the label is
 * not clickable — and most call sites have no reason to invent an id.
 */
export function Checkbox({
  id,
  name,
  value,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  required,
  describedBy,
  ariaLabel,
  label,
  hint,
  className,
}: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;

  const box = (
    <RadixCheckbox.Root
      id={controlId}
      name={name}
      value={value}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      required={required}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={describedBy}
      className={cn(
        "grid size-[1.125rem] shrink-0 place-items-center rounded-xs border",
        "border-line-strong bg-surface-2 text-on-accent transition-colors duration-100",
        "hover:border-ink-3",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-55",
        focusRing,
        !label && className,
      )}
    >
      <RadixCheckbox.Indicator className="grid place-items-center">
        {checked === "indeterminate" || defaultChecked === "indeterminate" ? (
          <Minus aria-hidden="true" className="size-3.5" strokeWidth={3} />
        ) : (
          <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );

  if (!label) return box;

  return (
    <div className={cn("flex min-h-11 items-start gap-2.5 py-1.5 md:min-h-9", className)}>
      <span className="flex h-6 items-center">{box}</span>
      <span className="flex min-w-0 flex-col">
        <label
          htmlFor={controlId}
          className={cn(
            "text-sm leading-6 text-ink",
            disabled ? "opacity-55" : "cursor-pointer",
          )}
        >
          {label}
        </label>
        {hint ? <span className="text-xs leading-5 text-ink-3">{hint}</span> : null}
      </span>
    </div>
  );
}
