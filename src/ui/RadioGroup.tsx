"use client";

import { RadioGroup as RadixRadioGroup } from "radix-ui";
import { cn, focusRing } from "./cn";

export interface RadioOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface RadioGroupProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly RadioOption[];
  name?: string;
  disabled?: boolean;
  required?: boolean;
  /** Accessible name for the group; required when no visible label exists. */
  ariaLabel?: string;
  describedBy?: string;
  /** Renders options side by side on wide screens. */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

export function RadioGroup({
  value,
  defaultValue,
  onValueChange,
  options,
  name,
  disabled,
  required,
  ariaLabel,
  describedBy,
  orientation = "vertical",
  className,
}: RadioGroupProps) {
  return (
    <RadixRadioGroup.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      name={name}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      orientation={orientation}
      className={cn(
        "flex gap-1",
        orientation === "vertical" ? "flex-col" : "flex-col sm:flex-row sm:gap-5",
        className,
      )}
    >
      {options.map((option) => {
        const id = `${name ?? "radio"}-${option.value}`;
        return (
          <div key={option.value} className="flex min-h-11 items-start gap-2.5 py-1.5 md:min-h-9">
            <span className="flex h-6 items-center">
              <RadixRadioGroup.Item
                id={id}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "grid size-[1.125rem] shrink-0 place-items-center rounded-full border",
                  "border-line-strong bg-surface-2 transition-colors duration-100",
                  "hover:border-ink-3",
                  "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
                  "disabled:cursor-not-allowed disabled:opacity-55",
                  focusRing,
                )}
              >
                <RadixRadioGroup.Indicator className="block size-1.5 rounded-full bg-on-accent" />
              </RadixRadioGroup.Item>
            </span>
            <span className="flex min-w-0 flex-col">
              <label
                htmlFor={id}
                className={cn(
                  "text-sm leading-6 text-ink",
                  option.disabled ? "opacity-55" : "cursor-pointer",
                )}
              >
                {option.label}
              </label>
              {option.hint ? (
                <span className="text-xs leading-5 text-ink-3">{option.hint}</span>
              ) : null}
            </span>
          </div>
        );
      })}
    </RadixRadioGroup.Root>
  );
}
