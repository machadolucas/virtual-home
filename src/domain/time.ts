/**
 * The one place calendar maths happens (CLAUDE.md rule 4).
 *
 * Three representations, never mixed:
 *  - **instant** — epoch milliseconds, a plain `number`;
 *  - **`LocalDate`** — `'YYYY-MM-DD'` in the household time zone, a calendar fact ("due on 1 May");
 *  - **`LocalTime`** — `'HH:MM'` wall clock, so a delivery time survives DST.
 *
 * Never add `7 * 86_400_000` to get "next week": every slot instant is recomputed from its local
 * date, which is what keeps `09:00` at `09:00` across both DST transitions.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §0.1.
 */
import { tzOffset } from "@date-fns/tz/tzOffset";
import { ValidationError } from "./errors";

/** Injectable "now", so no domain code ever reads the system clock directly. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** `'YYYY-MM-DD'` in the household time zone. */
export type LocalDate = string;
/** `'HH:MM'`, 24-hour wall clock. */
export type LocalTime = string;
/** `'YYYY-MM-DDTHH:MM'` — a local date and time, used as a sortable comparison key. */
export type LocalDateTime = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Days in `month1to12` of `year`, proleptic Gregorian (so 2028-02 → 29). */
export function lastDayOfMonth(year: number, month1to12: number): number {
  // Day 0 of the next month is the last day of this one; `Date.UTC` normalises month 13.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function isValidLocalDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= lastDayOfMonth(year, month);
}

export function isValidLocalTime(s: string): boolean {
  const m = TIME_RE.exec(s);
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

export interface LocalDateParts {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
}

export function parseLocalDate(d: LocalDate): LocalDateParts {
  if (!isValidLocalDate(d)) throw new ValidationError("invalid_local_date", `not a LocalDate: ${d}`);
  const m = DATE_RE.exec(d)!;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatLocalDate(year: number, month: number, day: number): LocalDate {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function parseLocalTime(t: LocalTime): { hour: number; minute: number } {
  if (!isValidLocalTime(t)) throw new ValidationError("invalid_local_time", `not a LocalTime: ${t}`);
  const m = TIME_RE.exec(t)!;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Lexicographic == chronological for `YYYY-MM-DD`, which is the whole point of the format. */
export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Same for `HH:MM`. */
export function compareLocalTime(a: LocalTime, b: LocalTime): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** UTC offset of `tz` at `at`, in milliseconds east of UTC (Helsinki winter → `+7_200_000`). */
function offsetMsAt(at: number, tz: string): number {
  const minutes = tzOffset(tz, new Date(at));
  if (!Number.isFinite(minutes)) {
    throw new ValidationError("invalid_timezone", `unknown time zone: ${tz}`);
  }
  return minutes * MS_PER_MINUTE;
}

/**
 * Wall-clock fields of `at` in `tz`.
 *
 * Shifting the instant by the zone offset and then reading the **UTC** getters is exact: it is the
 * definition of local time, and it never depends on the process time zone.
 */
function wallPartsOf(at: number, tz: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const shifted = new Date(at + offsetMsAt(at, tz));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

export function localDateOf(at: number, tz: string): LocalDate {
  const p = wallPartsOf(at, tz);
  return formatLocalDate(p.year, p.month, p.day);
}

export function localTimeOf(at: number, tz: string): LocalTime {
  const p = wallPartsOf(at, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** `'YYYY-MM-DDTHH:MM'` — sortable, and the key `instantOf` validates its candidates against. */
export function localDateTimeOf(at: number, tz: string): LocalDateTime {
  return `${localDateOf(at, tz)}T${localTimeOf(at, tz)}`;
}

/** ISO weekday of a LocalDate: 1 = Monday … 7 = Sunday. */
export function isoWeekdayOf(d: LocalDate): number {
  const p = parseLocalDate(d);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

/**
 * Local date + local wall time in `tz` → instant.
 *
 * The two DST edges are decided here, once, and tested explicitly (§0.1):
 *  1. **Nonexistent** wall time (spring-forward gap, e.g. Helsinki `03:30` on 2027-03-28):
 *     the **first valid instant at or after** the requested wall time — i.e. the transition
 *     instant, which reads `04:00` local.
 *  2. **Ambiguous** wall time (autumn fall-back, `03:30` twice on 2027-10-31): the **earlier**
 *     (still-DST) occurrence.
 */
export function instantOf(date: LocalDate, time: LocalTime, tz: string): number {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute } = parseLocalTime(time);
  const wanted: LocalDateTime = `${formatLocalDate(year, month, day)}T${pad2(hour)}:${pad2(minute)}`;

  // Treat the wall time as if it were UTC, then subtract the offset that actually applies. Every
  // offset in force within a day either side of the naive instant gives one candidate; the ones
  // that read back as exactly `wanted` are the real answers. Probing the whole neighbourhood
  // (rather than iterating to a fixed point) is what makes the *ambiguous* case yield both
  // occurrences instead of only the one the iteration happens to converge on.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const probeWindow = 26 * 60 * MS_PER_MINUTE;
  const offsets = [...new Set([
    offsetMsAt(naive - probeWindow, tz),
    offsetMsAt(naive, tz),
    offsetMsAt(naive + probeWindow, tz),
  ])];
  const candidates = [...new Set(offsets.map((o) => naive - o))].sort((a, b) => a - b);
  const valid = candidates.filter((c) => localDateTimeOf(c, tz) === wanted);
  // Ambiguous → the earlier one; candidates are sorted, so `valid[0]` is it.
  if (valid.length > 0) return valid[0]!;

  // Nonexistent: the wall clock jumps over `wanted`. Between the two candidates lies exactly one
  // offset transition; the first instant whose local time is at or after `wanted` *is* that
  // transition. Binary search finds it exactly (transitions are whole minutes, but ms costs 22
  // iterations and this path is rare).
  let lo = candidates[0]!;
  let hi = candidates[candidates.length - 1]!;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (localDateTimeOf(mid, tz) >= wanted) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Calendar-day arithmetic on a LocalDate. `n` may be negative. */
export function addDaysLocal(d: LocalDate, n: number): LocalDate {
  const { year, month, day } = parseLocalDate(d);
  const shifted = new Date(Date.UTC(year, month - 1, day) + n * MS_PER_DAY);
  return formatLocalDate(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Add `n` months, clamping a day-of-month that the target month does not have
 * (2026-01-31 + 1 month → 2026-02-28). This is the only clamp mode we implement.
 */
export function addMonthsClamped(d: LocalDate, n: number): LocalDate {
  const { year, month, day } = parseLocalDate(d);
  const zeroBased = year * 12 + (month - 1) + n;
  const targetYear = Math.floor(zeroBased / 12);
  const targetMonth = zeroBased - targetYear * 12 + 1;
  return formatLocalDate(targetYear, targetMonth, Math.min(day, lastDayOfMonth(targetYear, targetMonth)));
}

/** Whole days from `a` to `b` (negative when `b` precedes `a`). */
export function daysBetweenLocal(a: LocalDate, b: LocalDate): number {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  const ms = Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day);
  return Math.round(ms / MS_PER_DAY);
}

/** Whole months from `a` to `b`, ignoring the day of month. */
export function monthsBetweenLocal(a: LocalDate, b: LocalDate): number {
  const pa = parseLocalDate(a);
  const pb = parseLocalDate(b);
  return (pb.year - pa.year) * 12 + (pb.month - pa.month);
}

/** `start <= now <= end` on the wall clock; a window with `start > end` wraps midnight. */
export function isWithinLocalTimeWindow(now: LocalTime, start: LocalTime, end: LocalTime): boolean {
  if (compareLocalTime(start, end) <= 0) return now >= start && now <= end;
  return now >= start || now <= end;
}
