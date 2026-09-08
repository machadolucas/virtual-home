"use client";
import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Environment hooks, all through `useSyncExternalStore` rather than `useState` plus an effect.
 *
 * Two reasons: a media query *is* an external store, so this is what React 19 wants for it; and
 * the first client render already sees the correct value, so a phone never renders the desktop
 * layout for one frame before correcting itself.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);

  // The server has no media queries; `false` keeps hydration deterministic.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * `prefers-reduced-motion: reduce`, watched **live**: a user who flips the OS setting mid-session
 * gets instant camera cuts from then on.
 */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** `matchMedia('(max-width: 767px)')`. Drives the phone simplifications (§12). */
export function useIsPhone(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Coarse pointer → bigger hit targets and touch pick tolerance. */
export function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

/**
 * A coarse clock, bucketed to `intervalMs`, for staleness classification.
 *
 * Staleness is a function of `now`, and reading `Date.now()` during render is impure — so the
 * clock is an external store too. One shared interval per bucket size drives every subscriber
 * (§9.4: "a single 30 s interval"), and it never touches the HA store or the house store, so a
 * staleness tick costs one React render of the badges and no GPU frame.
 */
export function useNow(intervalMs = 30_000): number {
  const ticker = useMemo(() => tickerFor(intervalMs), [intervalMs]);
  return useSyncExternalStore(ticker.subscribe, ticker.getSnapshot, ticker.getServerSnapshot);
}

interface Ticker {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => number;
  getServerSnapshot: () => number;
}

const tickers = new Map<number, Ticker>();

function tickerFor(intervalMs: number): Ticker {
  const existing = tickers.get(intervalMs);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let handle: ReturnType<typeof setInterval> | null = null;
  let snapshot = 0;

  const ticker: Ticker = {
    subscribe(onChange) {
      listeners.add(onChange);
      if (handle === null) {
        snapshot = bucket(Date.now(), intervalMs);
        handle = setInterval(() => {
          const next = bucket(Date.now(), intervalMs);
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of listeners) listener();
        }, intervalMs);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && handle !== null) {
          clearInterval(handle);
          handle = null;
        }
      };
    },
    // Stable between ticks, which is what `useSyncExternalStore` requires of a snapshot.
    getSnapshot: () => (snapshot === 0 ? bucket(Date.now(), intervalMs) : snapshot),
    getServerSnapshot: () => 0,
  };

  tickers.set(intervalMs, ticker);
  return ticker;
}

const bucket = (now: number, intervalMs: number): number =>
  Math.floor(now / intervalMs) * intervalMs;
