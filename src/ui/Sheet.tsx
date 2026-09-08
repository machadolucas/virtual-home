"use client";

import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { IconButton } from "./IconButton";
import { dialogOverlay } from "./Dialog";

export type SheetSide = "right" | "bottom";

export interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** `bottom` is the phone default; `right` suits desktop inspectors. */
  side?: SheetSide;
  className?: string;
}

/**
 * An edge-anchored panel built on the same Radix Dialog as `Dialog`, so it
 * gets identical focus and Escape behaviour.
 *
 * Use `side="bottom"` for phone flows (instructions, completion, photos) — the
 * sheet reaches at most 88 % of the dynamic viewport height and keeps a safe
 * area inset for the home indicator. `side="right"` is the desktop inspector.
 */
export function Sheet({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  side = "bottom",
  className,
}: SheetProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={dialogOverlay} />
        <RadixDialog.Content
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border-line bg-surface shadow-overlay",
            side === "bottom" && [
              "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-xl border-t",
              "pb-[env(safe-area-inset-bottom)]",
              "data-[state=open]:animate-[vh-slide-up_220ms_var(--vh-ease-out)]",
              "data-[state=closed]:animate-[vh-slide-down_160ms_var(--vh-ease)]",
            ],
            side === "right" && [
              "inset-y-0 right-0 w-[min(28rem,100vw)] border-l",
              "pr-[env(safe-area-inset-right)]",
              "data-[state=open]:animate-[vh-slide-from-right_220ms_var(--vh-ease-out)]",
              "data-[state=closed]:animate-[vh-slide-to-right_160ms_var(--vh-ease)]",
            ],
            className,
          )}
        >
          {side === "bottom" ? (
            <div
              aria-hidden="true"
              className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong"
            />
          ) : null}
          <div className="flex items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5">
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-base font-semibold tracking-[-0.01em] text-ink">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm leading-6 text-ink-2">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            <RadixDialog.Close asChild>
              <IconButton
                label="Close"
                size="sm"
                icon={<X aria-hidden="true" />}
                className="-mr-1.5 -mt-1"
              />
            </RadixDialog.Close>
          </div>
          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-ink-2 sm:px-5">
              {children}
            </div>
          ) : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3 sm:px-5">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const SheetClose = RadixDialog.Close;
