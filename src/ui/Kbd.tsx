import type { ReactNode } from "react";
import { cn } from "./cn";

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** A single key cap. Compose several for a chord: `<Kbd>⌘</Kbd><Kbd>K</Kbd>`. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong",
        "bg-surface-2 px-1 font-mono text-[0.6875rem] font-medium leading-none text-ink-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
