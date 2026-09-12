"use client";

import { Popover as RadixPopover } from "radix-ui";
import type { ReactNode } from "react";
import { useOverlayContainer } from "./OverlayContainer";
import { cn } from "./cn";

export interface PopoverProps {
  /** The control that opens the popover. Must be focusable. */
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** Accessible name for the popover surface. */
  ariaLabel?: string;
  /** Set `false` when the children own their padding (menus, lists). */
  padded?: boolean;
  className?: string;
}

/**
 * Non-modal transient surface: filters, column pickers, small forms attached
 * to a control. Focus moves into it, Escape closes it, an outside click
 * dismisses it. For anything a user must answer before continuing use
 * `Dialog`; for anything purely informational use `Tooltip`.
 *
 * Sets no `width` of its own (only min/max) and makes padding opt-out, because
 * `cn()` does not resolve Tailwind conflicts: a caller's `w-64` or `p-1.5`
 * would silently lose to a default in the same utility group.
 */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ariaLabel,
  padded = true,
  className,
}: PopoverProps) {
  const container = useOverlayContainer();
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal container={container}>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          aria-label={ariaLabel}
          className={cn(
            "z-50 max-h-[min(28rem,var(--radix-popover-content-available-height))]",
            "min-w-40 max-w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto",
            "rounded-md border border-line bg-surface text-sm text-ink-2 shadow-pop",
            padded && "p-3",
            "data-[state=open]:animate-[vh-pop-in_120ms_var(--vh-ease-out)]",
            "data-[state=closed]:animate-[vh-pop-out_100ms_var(--vh-ease)]",
            className,
          )}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export const PopoverClose = RadixPopover.Close;
