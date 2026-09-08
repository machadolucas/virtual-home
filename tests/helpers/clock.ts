/**
 * The fake clock every scheduling test injects. No test reads the system clock.
 *
 * `Clock` is deliberately tiny (`now(): number`), so the fake adds only the three moves a test
 * needs: step forward by a duration, jump to an absolute instant, jump to a household-local
 * wall-clock time (which is how the DST cases are written readably).
 */
import { instantOf, type Clock, type LocalDate, type LocalTime } from "@/domain/time";

export interface FakeClock extends Clock {
  /** Move forward (or, with a negative value, back) by `ms`. */
  advance(deltaMs: number): void;
  /** Jump to an absolute instant, given as an ISO 8601 string or epoch milliseconds. */
  set(at: string | number): void;
  /**
   * Jump to `'YYYY-MM-DDTHH:MM'` **local** time in `tz` — DST-resolved by `instantOf`, so
   * `advanceToLocal('2027-03-28T09:00', 'Europe/Helsinki')` lands on `06:00Z`.
   */
  advanceToLocal(local: string, tz: string): void;
  /** Convenience for assertions: the current instant. */
  readonly nowMs: number;
}

const LOCAL_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/;

function toInstant(at: string | number): number {
  if (typeof at === "number") return at;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) throw new Error(`fakeClock: unparseable instant ${at}`);
  return parsed;
}

/** A clock starting at `startIso` (any `Date.parse`-able string, or epoch ms). */
export function fakeClock(startIso: string | number): FakeClock {
  let current = toInstant(startIso);
  return {
    now: () => current,
    get nowMs() {
      return current;
    },
    advance(deltaMs: number) {
      current += deltaMs;
    },
    set(at: string | number) {
      current = toInstant(at);
    },
    advanceToLocal(local: string, tz: string) {
      const m = LOCAL_DATE_TIME_RE.exec(local);
      if (!m) throw new Error(`fakeClock: expected 'YYYY-MM-DDTHH:MM', got ${local}`);
      current = instantOf(m[1] as LocalDate, m[2] as LocalTime, tz);
    },
  };
}

/** Milliseconds helpers, so tests read as prose. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
