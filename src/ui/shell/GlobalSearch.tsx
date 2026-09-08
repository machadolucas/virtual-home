"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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

interface SearchHit {
  id: string;
  label: string;
  secondary: string | null;
  href: string;
}

interface SearchGroup {
  kind: string;
  label: string;
  hits: SearchHit[];
  hasMore: boolean;
}

/** Typing pause before a request goes out. Long enough that a fast typist causes one query. */
const DEBOUNCE_MS = 180;
const MIN_QUERY = 2;

/** One stable empty array, so "no results yet" is not a new identity every render. */
const EMPTY_GROUPS: SearchGroup[] = [];

/**
 * The global search: equipment, supplies, rooms and zones, projects, procedures and maintenance
 * plans, each hit carrying the href that opens it. `/api/search` does the matching.
 *
 * Keyboard is the point of a header search, so the whole list is reachable with the arrow keys and
 * `Enter`, and `Escape` closes without navigating. Each option carries a real id and the input
 * points `aria-activedescendant` at the active one — without that, arrow-key movement changes a
 * background colour and is announced to nobody, which is not "reachable".
 *
 * The panel is dismissible as well as openable: it closes on blur and on a click outside, because
 * a `z-50` overlay that only disappears when the query is emptied sits over whatever the user
 * clicked next.
 *
 * The surface never invents a result: it says "no matches", "searching" or "there are more" rather
 * than showing something plausible.
 */
export function GlobalSearch({ registerInput, className }: GlobalSearchProps) {
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  /** The query `groups` belongs to, so a stale list is never shown as this query's answer. */
  const [resultQuery, setResultQuery] = useState("");
  const [failedQuery, setFailedQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /**
   * Dismissed by blur, an outside click or `Escape` — as distinct from "there is nothing to show".
   * Kept separate from `query` so tabbing away does not silently erase what was typed.
   */
  const [dismissed, setDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const hintId = useId();
  const listId = useId();
  const router = useRouter();

  const trimmed = query.trim();
  const open = trimmed.length > 0 && !dismissed;
  const tooShort = trimmed.length < MIN_QUERY;

  // Everything the surface shows is derived from "which query do the results belong to", rather
  // than from a status the effect writes: a synchronous setState in an effect is both a lint error
  // and a real double render.
  const fresh = !tooShort && resultQuery === trimmed;
  const pending = !tooShort && !fresh && failedQuery !== trimmed;
  const failed = failedQuery === trimmed;

  // Memoised so the empty case is one stable array rather than a new one per render, which would
  // make the flat list below recompute forever.
  const visibleGroups = useMemo(() => (fresh ? groups : EMPTY_GROUPS), [fresh, groups]);
  // Flat list in render order, so the arrow keys can walk across group boundaries.
  const flat = useMemo(() => visibleGroups.flatMap((group) => group.hits), [visibleGroups]);
  const activeIndex = flat.length === 0 ? 0 : Math.min(active, flat.length - 1);

  useEffect(() => {
    if (trimmed.length < MIN_QUERY) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
          if (!res.ok) throw new Error(`search failed: ${res.status}`);
          const body = (await res.json()) as { groups?: SearchGroup[] };
          setGroups(body.groups ?? []);
          setResultQuery(trimmed);
          setFailedQuery(null);
          setActive(0);
        } catch (err) {
          if (controller.signal.aborted) return;
          if (err instanceof DOMException && err.name === "AbortError") return;
          setGroups([]);
          setFailedQuery(trimmed);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed]);

  const close = useCallback(() => {
    setQuery("");
    setGroups([]);
    setResultQuery("");
    setFailedQuery(null);
    setActive(0);
    setDismissed(false);
  }, []);

  // A click that lands anywhere else closes the panel. `pointerdown` rather than `click` so the
  // panel is gone before the thing underneath reacts, and capture so a handler that stops
  // propagation cannot leave the overlay hanging over the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setDismissed(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const go = useCallback(
    (hit: SearchHit) => {
      close();
      inputRef.current?.blur();
      router.push(hit.href);
    },
    [close, router],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        close();
        event.currentTarget.blur();
        return;
      }
      if (flat.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % flat.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + flat.length) % flat.length);
        return;
      }
      if (event.key === "Enter") {
        const hit = flat[activeIndex] ?? flat[0];
        if (hit) {
          event.preventDefault();
          go(hit);
        }
      }
    },
    [flat, activeIndex, close, go],
  );

  /** Stable per-position ids, so `aria-activedescendant` has something to point at. */
  const optionId = (position: number): string => `${listId}-option-${position}`;
  const activeOptionId = open && flat.length > 0 ? optionId(activeIndex) : undefined;

  // Walks with the render so a flat index can be compared against the active one.
  let index = -1;

  return (
    <div ref={rootRef} className={cn("relative min-w-0 flex-1 md:max-w-md", className)}>
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
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setDismissed(false);
        }}
        onFocus={() => setDismissed(false)}
        // Options call `preventDefault` on mousedown, so choosing one does not blur — this only
        // fires when focus really leaves the search.
        onBlur={() => setDismissed(true)}
        onKeyDown={onKeyDown}
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
              close();
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
        Press slash to focus search. Type at least two characters, then use the arrow keys and
        Enter.
      </p>
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          className={cn(
            "absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[70vh] overflow-y-auto rounded-md border border-line",
            "bg-surface p-1.5 text-sm leading-6 text-ink-2 shadow-pop",
            "animate-[vh-pop-in_120ms_var(--vh-ease-out)]",
          )}
        >
          {tooShort ? (
            <p role="status" className="px-1.5 py-1 text-xs text-ink-3">
              Keep typing…
            </p>
          ) : failed ? (
            <p role="status" className="px-1.5 py-1 text-xs text-ink-3">
              Search could not run just now.
            </p>
          ) : visibleGroups.length === 0 ? (
            <p role="status" className="px-1.5 py-1 text-xs text-ink-3">
              {pending ? "Searching…" : "No matches."}
            </p>
          ) : (
            visibleGroups.map((group) => (
              /*
                A listbox may contain options and groups, nothing else — so the wrappers between
                this element and each option are marked presentational and the visible headings are
                hidden from the tree, with their text folded into the group's own name instead.
              */
              <div
                key={group.kind}
                role="group"
                aria-label={
                  group.hasMore
                    ? `${group.label}, more match than are listed`
                    : group.label
                }
                className="py-0.5"
              >
                <p
                  aria-hidden="true"
                  className="px-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-3"
                >
                  {group.label}
                </p>
                <ul role="presentation">
                  {group.hits.map((hit) => {
                    index += 1;
                    const isActive = index === activeIndex;
                    return (
                      <li key={`${group.kind}:${hit.id}`} role="presentation">
                        <button
                          type="button"
                          id={optionId(index)}
                          role="option"
                          aria-selected={isActive}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => go(hit)}
                          className={cn(
                            // 44 px on a phone, where this is a finger target; the compact 32 px
                            // row is for pointer-sized screens only.
                            "flex min-h-11 w-full items-baseline gap-2 rounded px-1.5 text-left md:min-h-8",
                            isActive ? "bg-surface-3 text-ink" : "text-ink hover:bg-surface-3",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{hit.label}</span>
                          {hit.secondary ? (
                            <span className="shrink-0 text-xs text-ink-3">{hit.secondary}</span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {group.hasMore ? (
                  <p aria-hidden="true" className="px-1.5 text-[10px] text-ink-3">
                    More match — narrow the search.
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
