"use client";

import { Switch as RadixSwitch } from "radix-ui";
import type { ReactNode } from "react";
import { cn, focusRing } from "./cn";

export interface SwitchProps {
  id?: string;
  name?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  describedBy?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
}

/**
 * A switch means "takes effect immediately". Use `Checkbox` inside forms that
 * are submitted. The thumb travel is a transform, so it is a single 120 ms
 * transition that reduced-motion collapses to nothing.
 */
export function Switch({
  id,
  name,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  describedBy,
  ariaLabel,
  label,
  hint,
  className,
}: SwitchProps) {
  const control = (
    <RadixSwitch.Root
      id={id}
      name={name}
      checked={checked}
      defaultChecked={defaultChecked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={describedBy}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border",
        "border-line-strong bg-surface-3 transition-colors duration-100",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-55",
        focusRing,
        !label && className,
      )}
    >
      <RadixSwitch.Thumb
        className={cn(
          "block size-4.5 translate-x-[0.1875rem] rounded-full bg-paper shadow-panel",
          "transition-transform duration-100",
          "data-[state=checked]:translate-x-[1.1875rem]",
        )}
      />
    </RadixSwitch.Root>
  );

  if (!label) return control;

  return (
    <div className={cn("flex min-h-11 items-start justify-between gap-4 py-1.5", className)}>
      <span className="flex min-w-0 flex-col">
        <label
          htmlFor={id}
          className={cn("text-sm leading-6 text-ink", disabled ? "opacity-55" : "cursor-pointer")}
        >
          {label}
        </label>
        {hint ? <span className="text-xs leading-5 text-ink-3">{hint}</span> : null}
      </span>
      <span className="flex h-6 items-center">{control}</span>
    </div>
  );
}
