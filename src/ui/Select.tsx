"use client";

import { Select as RadixSelect } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { cn, focusRing } from "./cn";
import type { InputSize } from "./Input";

const SIZE: Record<InputSize, string> = {
  sm: "h-8 px-2 text-[0.8125rem]",
  md: "h-9 px-2.5 text-sm",
  lg: "h-11 px-3 text-base",
};

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line inside the option (units, ids, hints). */
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Accessible name when the select has no visible `<label>`. */
  ariaLabel?: string;
  selectSize?: InputSize;
  className?: string;
}

/**
 * Radix Select rather than a native `<select>`: the option list must be able
 * to show a hint line per option and match the app's surfaces. Keyboard and
 * typeahead behaviour come from Radix; we only supply the chrome.
 */
export function Select({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder = "Choose…",
  id,
  name,
  disabled,
  required,
  invalid,
  describedBy,
  ariaLabel,
  selectSize = "md",
  className,
}: SelectProps) {
  return (
    <RadixSelect.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      required={required}
      name={name}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-sm border bg-surface-2 text-ink",
          "border-line-strong transition-colors duration-100 hover:border-ink-3",
          "data-[placeholder]:text-ink-3",
          "disabled:cursor-not-allowed disabled:opacity-60",
          "aria-[invalid=true]:border-overdue aria-[invalid=true]:bg-overdue-soft",
          focusRing,
          SIZE[selectSize],
          className,
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon asChild>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-50 max-h-[min(24rem,var(--radix-select-content-available-height))]",
            "min-w-[var(--radix-select-trigger-width)] overflow-hidden",
            "rounded-md border border-line bg-surface shadow-overlay",
            "data-[state=open]:animate-[vh-pop-in_120ms_var(--vh-ease-out)]",
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-ink-3">
            <ChevronDown aria-hidden="true" className="size-4 rotate-180" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  "relative flex cursor-default select-none items-start gap-2 rounded-sm",
                  "py-1.5 pl-7 pr-2.5 text-sm text-ink outline-none",
                  "data-highlighted:bg-surface-3",
                  "data-[state=checked]:bg-accent-soft data-[state=checked]:text-accent-text",
                  "data-disabled:pointer-events-none data-disabled:opacity-50",
                  "min-h-9 md:min-h-8",
                )}
              >
                <RadixSelect.ItemIndicator className="absolute left-1.5 top-1.5">
                  <Check aria-hidden="true" className="size-4" />
                </RadixSelect.ItemIndicator>
                <span className="flex min-w-0 flex-col">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  {option.hint ? (
                    <span className="text-xs text-ink-3">{option.hint}</span>
                  ) : null}
                </span>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-ink-3">
            <ChevronDown aria-hidden="true" className="size-4" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
