"use client";

import { Dialog as RadixDialog } from "radix-ui";
import { X } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useOverlayContainer } from "./OverlayContainer";
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
  /** Preserve the body subtree while the modal itself closes normally. */
  keepMounted?: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
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
  keepMounted = false,
  returnFocusRef,
}: SheetProps) {
  const container = useOverlayContainer();
  const previousFocus = useRef<HTMLElement | null>(null);
  const parkingRef = useRef<HTMLDivElement | null>(null);
  const bodyHostRef = useRef<HTMLDivElement | null>(null);
  const [bodyHost, setBodyHost] = useState<HTMLDivElement | null>(null);
  const park = useCallback((node: HTMLDivElement | null) => {
    parkingRef.current = node;
    if (node && !bodyHostRef.current) {
      const host = document.createElement("div");
      host.style.display = "contents";
      bodyHostRef.current = host;
      node.appendChild(host);
      setBodyHost(host);
    }
  }, []);
  const mountBody = useCallback((slot: HTMLDivElement | null) => {
    const host = bodyHostRef.current;
    if (!host) return;
    // Move the stable portal target before Radix removes its content. React state stays mounted,
    // while the closed modal's focus scope, dismissable layer and scroll lock really unmount.
    (slot ?? parkingRef.current)?.appendChild(host);
  }, []);
  const body = <>
    {children ? <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-ink-2 sm:px-5">{children}</div> : null}
    {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3">{footer}</div> : null}
  </>;
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {keepMounted ? <div ref={park} hidden inert aria-hidden="true" /> : null}
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal container={container}>
        <RadixDialog.Overlay className={dialogOverlay} />
        <RadixDialog.Content
          onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={event => { const target = returnFocusRef?.current ?? previousFocus.current; if (target?.isConnected) { event.preventDefault(); target.focus(); } }}
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
          {keepMounted ? <div ref={mountBody} style={{display:"contents"}} /> : body}
        </RadixDialog.Content>
      </RadixDialog.Portal>
      {keepMounted && bodyHost ? createPortal(body, bodyHost) : null}
    </RadixDialog.Root>
  );
}

export const SheetClose = RadixDialog.Close;
