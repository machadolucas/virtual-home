"use client";

import { Tabs as RadixTabs } from "radix-ui";
import type { ReactNode } from "react";
import { cn, focusRingInset } from "./cn";

export interface TabItem {
  value: string;
  label: string;
  /** Small trailing count (e.g. number of rows behind the tab). */
  count?: number;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Accessible name for the tab list. */
  ariaLabel: string;
  children?: ReactNode;
  className?: string;
}

/**
 * Underlined tabs for switching between views of the same subject. Arrow keys
 * move between tabs (Radix); the panel is a separate tab stop.
 *
 * The active tab is marked by an underline AND a weight change, not colour
 * alone.
 */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  ariaLabel,
  children,
  className,
}: TabsProps) {
  return (
    <RadixTabs.Root
      value={value}
      defaultValue={defaultValue ?? items[0]?.value}
      onValueChange={onValueChange}
      className={cn("flex min-h-0 flex-col", className)}
    >
      <RadixTabs.List
        aria-label={ariaLabel}
        className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-line"
      >
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 border-transparent",
              "px-3 pb-2 pt-2 text-sm font-medium text-ink-3 transition-colors duration-100",
              "hover:text-ink-2",
              "data-[state=active]:border-accent data-[state=active]:font-semibold",
              "data-[state=active]:text-ink",
              "disabled:pointer-events-none disabled:opacity-55",
              "md:min-h-9",
              focusRingInset,
              "[&_svg]:size-4",
            )}
          >
            {item.icon}
            {item.label}
            {typeof item.count === "number" ? (
              <span className="vh-tnum rounded-full bg-surface-3 px-1.5 text-xs text-ink-2">
                {item.count}
              </span>
            ) : null}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {children}
    </RadixTabs.Root>
  );
}

export const TabsPanel = RadixTabs.Content;
