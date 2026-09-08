"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Check, CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "./cn";
import { IconButton } from "./IconButton";

/**
 * A 60-line toast system: one module-scope store, one viewport, no dependency.
 *
 * Toasts are for the outcome of an action the user just took ("Completion
 * recorded", "Could not reach Home Assistant"). They are never used for
 * background events — those belong on the screen that owns them, because a
 * toast that nobody sees is a lost message.
 */

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastInput {
  title: string;
  /** One extra line. Keep it short; long text belongs on the page. */
  description?: string;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss. `0` keeps it until dismissed. */
  duration?: number;
  /** A single undo/retry affordance. */
  action?: { label: string; onClick: () => void };
}

export interface ToastItem extends ToastInput {
  id: string;
  tone: ToastTone;
  duration: number;
}

const MAX_VISIBLE = 4;
const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 4500,
  success: 3500,
  warning: 7000,
  error: 0, // errors stay until dismissed: the user must see what failed
};

let items: readonly ToastItem[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly ToastItem[] {
  return items;
}

const EMPTY: readonly ToastItem[] = [];
function serverSnapshot(): readonly ToastItem[] {
  return EMPTY;
}

/** Show a toast. Returns its id so callers can dismiss it early. */
export function toast(input: ToastInput): string {
  const tone = input.tone ?? "info";
  counter += 1;
  const item: ToastItem = {
    ...input,
    tone,
    id: `t${counter}`,
    duration: input.duration ?? DEFAULT_DURATION[tone],
  };
  items = [...items, item].slice(-MAX_VISIBLE);
  emit();
  return item.id;
}

export function dismissToast(id: string): void {
  const next = items.filter((item) => item.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function dismissAllToasts(): void {
  if (items.length === 0) return;
  items = [];
  emit();
}

/** Convenience wrappers. */
export const toasts = {
  info: (title: string, description?: string) => toast({ title, description, tone: "info" }),
  success: (title: string, description?: string) => toast({ title, description, tone: "success" }),
  warning: (title: string, description?: string) => toast({ title, description, tone: "warning" }),
  error: (title: string, description?: string) => toast({ title, description, tone: "error" }),
};

/** Read the queue (for tests or a custom viewport). */
export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

const TONE_STYLE: Record<ToastTone, { border: string; fg: string; Icon: typeof Info }> = {
  info: { border: "border-line-strong", fg: "text-ink-2", Icon: Info },
  success: { border: "border-ok/45", fg: "text-ok", Icon: Check },
  warning: { border: "border-due/45", fg: "text-due", Icon: TriangleAlert },
  error: { border: "border-overdue/50", fg: "text-overdue", Icon: CircleAlert },
};

function Toast({ item }: { item: ToastItem }) {
  const { border, fg, Icon } = TONE_STYLE[item.tone];

  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = window.setTimeout(() => dismissToast(item.id), item.duration);
    return () => window.clearTimeout(timer);
  }, [item.id, item.duration]);

  return (
    <li
      role={item.tone === "error" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-md border bg-surface",
        "px-3 py-2.5 shadow-pop",
        "animate-[vh-pop-in_150ms_var(--vh-ease-out)]",
        border,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", fg)} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{item.title}</p>
        {item.description ? (
          <p className="mt-0.5 text-xs leading-5 text-ink-2">{item.description}</p>
        ) : null}
        {item.action ? (
          <button
            type="button"
            onClick={() => {
              item.action?.onClick();
              dismissToast(item.id);
            }}
            className={cn(
              "mt-1.5 inline-flex min-h-6 items-center rounded-xs text-xs font-semibold",
              "text-accent-text underline decoration-accent/40 underline-offset-2",
              "hover:decoration-accent",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          >
            {item.action.label}
          </button>
        ) : null}
      </div>
      <IconButton
        label="Dismiss"
        size="sm"
        icon={<X aria-hidden="true" />}
        onClick={() => dismissToast(item.id)}
        className="-mr-1 -mt-0.5"
      />
    </li>
  );
}

/**
 * Mount once in the root layout. Bottom-centre on phones (thumb reach, clear
 * of the bottom tab bar), bottom-right on desktop.
 */
export function ToastViewport() {
  const queue = useToasts();
  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-70 flex justify-center px-3",
        "bottom-[calc(var(--vh-tabbar-h)+env(safe-area-inset-bottom)+0.75rem)]",
        "md:inset-x-auto md:bottom-4 md:right-4 md:justify-end md:px-0",
      )}
    >
      <ul className="flex w-full max-w-sm list-none flex-col gap-2">
        {queue.map((item) => (
          <Toast key={item.id} item={item} />
        ))}
      </ul>
    </div>
  );
}
