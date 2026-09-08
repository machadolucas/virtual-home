"use client";

import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Mount once, high in the tree (the app shell does). Radix needs a provider
 * for the shared open/close delay behaviour.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** Focusable trigger. A tooltip on a non-focusable element is unreachable. */
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Keyboard hint rendered on the right of the tooltip. */
  shortcut?: string;
}

/**
 * Supplementary hints only — never the sole carrier of meaning, because
 * tooltips do not exist on touch. Anything essential is also visible text or
 * an `aria-label`.
 */
export function Tooltip({ children, content, side = "top", align = "center", shortcut }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-60 flex max-w-64 items-center gap-2 rounded-sm border border-line",
            "bg-surface px-2 py-1 text-xs leading-5 text-ink shadow-pop",
            "data-[state=delayed-open]:animate-[vh-fade-in_100ms_var(--vh-ease)]",
          )}
        >
          <span>{content}</span>
          {shortcut ? (
            <kbd className="rounded-xs border border-line-strong bg-surface-2 px-1 font-mono text-[0.6875rem] text-ink-2">
              {shortcut}
            </kbd>
          ) : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
