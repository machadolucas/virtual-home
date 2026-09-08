"use client";

import { useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../cn";
import { IconButton } from "../IconButton";
import { Kbd } from "../Kbd";
import { fieldSurface } from "../Input";

export interface GlobalSearchProps {
  /**
   * Registers the input so the shell's `/` shortcut can focus it. Called once
   * on mount with the element (and with `null` on unmount).
   */
  registerInput?: (element: HTMLInputElement | null) => void;
  className?: string;
}

/**
 * Placeholder for the global search. The field, the `/` shortcut and the
 * result surface are real; the index behind them is not built yet, so the
 * surface says so instead of showing invented results.
 */
export function GlobalSearch({ registerInput, className }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const open = query.trim().length > 0;

  return (
    <div className={cn("relative min-w-0 flex-1 md:max-w-md", className)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3"
      >
        <Search className="size-4" />
      </span>
      <input
        ref={(element) => {
          inputRef.current = element;
          registerInput?.(element);
        }}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("");
            event.currentTarget.blur();
          }
        }}
        placeholder="Search rooms, equipment, supplies…"
        aria-label="Search the house"
        aria-describedby={hintId}
        autoComplete="off"
        enterKeyHint="search"
        className={cn(fieldSurface, "h-9 pl-8 pr-16 text-sm")}
      />
      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {open ? (
          <IconButton
            label="Clear search"
            size="sm"
            icon={<X aria-hidden="true" />}
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
          />
        ) : (
          <span aria-hidden="true" className="hidden md:flex">
            <Kbd>/</Kbd>
          </span>
        )}
      </span>
      <p id={hintId} className="sr-only">
        Press slash to focus search. Search is not connected yet.
      </p>
      {open ? (
        <div
          className={cn(
            "absolute left-0 right-0 top-full z-50 mt-1.5 rounded-md border border-line",
            "bg-surface p-3 text-sm leading-6 text-ink-2 shadow-pop",
            "animate-[vh-pop-in_120ms_var(--vh-ease-out)]",
          )}
        >
          <p className="font-medium text-ink">Search is not connected yet.</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-3">
            It will match rooms, surfaces, equipment, supplies and history entries, and jump
            straight into the house view.
          </p>
        </div>
      ) : null}
    </div>
  );
}
