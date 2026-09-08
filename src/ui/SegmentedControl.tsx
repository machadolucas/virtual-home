"use client";

import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn, focusRingInset } from "./cn";

export interface SegmentedItem<T extends string = string> {
  value: T;
  label: string;
  /** Decorative glyph shown before the label. */
  icon?: ReactNode;
  /** Show only the icon and expose `label` as the accessible name. */
  iconOnly?: boolean;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  items: readonly SegmentedItem<T>[];
  /** Accessible name for the group (e.g. "House view"). */
  ariaLabel: string;
  size?: "sm" | "md";
  /** Stretch each segment to equal width (phone toolbars). */
  fullWidth?: boolean;
  className?: string;
}

/**
 * A single-choice switch for view modes ("Plan / 3D", "Day / Week"). Built on
 * Radix ToggleGroup in single mode, so arrow keys move between segments and
 * the group is one tab stop.
 *
 * Deliberately ignores the empty string that ToggleGroup emits when the active
 * item is clicked again: a segmented control must always have a selection.
 */
export function SegmentedControl<T extends string = string>({
  value,
  onValueChange,
  items,
  ariaLabel,
  size = "md",
  fullWidth = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5",
        fullWidth && "w-full",
        className,
      )}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          aria-label={item.iconOnly ? item.label : undefined}
          title={item.iconOnly ? item.label : undefined}
          className={cn(
            "inline-flex select-none items-center justify-center gap-1.5 rounded-sm",
            "font-medium text-ink-2 transition-colors duration-100",
            "hover:text-ink",
            "data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-panel",
            "data-[state=on]:ring-1 data-[state=on]:ring-line-strong",
            "disabled:pointer-events-none disabled:opacity-55",
            focusRingInset,
            size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-[0.8125rem]",
            item.iconOnly && (size === "sm" ? "w-9 px-0" : "w-10 px-0"),
            fullWidth && "flex-1",
            "[&_svg]:size-4",
          )}
        >
          {item.icon}
          {item.iconOnly ? null : <span>{item.label}</span>}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
