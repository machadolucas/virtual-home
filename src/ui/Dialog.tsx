"use client";

import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useOverlayContainer } from "./OverlayContainer";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element that opens the dialog. Omit when driving `open` yourself. */
  trigger?: ReactNode;
  title: ReactNode;
  /** Always provide: it becomes the dialog's accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Right-aligned action row. Put the confirming action last. */
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Hide the corner close button (confirm-or-cancel dialogs). */
  hideClose?: boolean;
  className?: string;
}

const SIZE = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
} as const;

/** Shared backdrop, also used by `Sheet`. */
export const dialogOverlay = cn(
  "fixed inset-0 z-40 bg-scrim",
  "data-[state=open]:animate-[vh-fade-in_120ms_var(--vh-ease)]",
  "data-[state=closed]:animate-[vh-fade-out_120ms_var(--vh-ease)]",
);

/**
 * Centred modal for short, focused decisions. Focus trapping, restore, Escape
 * and scroll locking come from Radix. Anything with more than a couple of
 * fields belongs on a page, not in here.
 */
export function Dialog({
  open,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose = false,
  className,
}: DialogProps) {
  const container = useOverlayContainer();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay className={dialogOverlay} />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[calc(100dvh-3rem)] flex-col overflow-hidden",
            "rounded-xl border border-line bg-surface shadow-overlay",
            "data-[state=open]:animate-[vh-pop-in_150ms_var(--vh-ease-out)]",
            "data-[state=closed]:animate-[vh-pop-out_120ms_var(--vh-ease)]",
            SIZE[size],
            className,
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
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
            {hideClose ? null : (
              <RadixDialog.Close asChild>
                <IconButton
                  label="Close"
                  size="sm"
                  icon={<X aria-hidden="true" />}
                  className="-mr-1.5 -mt-1"
                />
              </RadixDialog.Close>
            )}
          </div>
          {children ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-6 text-ink-2">
              {children}
            </div>
          ) : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** `<Dialog.Close asChild>` for callers that need to close from the body. */
export const DialogClose = RadixDialog.Close;
