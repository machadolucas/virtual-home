/**
 * Reminder-slot arithmetic (§4.2).
 *
 * For a recipient state with `anchor_date = A`, household `delivery_time = D`, zone `tz` and
 * `reminder_interval_days = I`:
 *
 *     t(n) = instantOf(addDaysLocal(A, I * n), D, tz)     n = 0, 1, 2, …
 *
 * `t(0)` is the "task is due" notification — there are no advance reminders. Every instant is
 * recomputed from its **local date**, which is why an outage, a DST transition or a restart never
 * shifts the weekly rhythm.
 */
import {
  addDaysLocal,
  instantOf,
  isWithinLocalTimeWindow,
  localTimeOf,
  type LocalDate,
  type LocalTime,
} from "../time";

/** The local date of slot `n`. */
export function slotLocalDate(anchorDate: LocalDate, n: number, intervalDays: number): LocalDate {
  return addDaysLocal(anchorDate, intervalDays * n);
}

/** `t(n)` — the instant slot `n` is scheduled for. */
export function slotInstant(
  anchorDate: LocalDate,
  n: number,
  intervalDays: number,
  deliveryTime: LocalTime,
  tz: string,
): number {
  return instantOf(slotLocalDate(anchorDate, n, intervalDays), deliveryTime, tz);
}

/**
 * The fast-forward target: the largest `n >= fromIndex` with `t(n) <= now`.
 *
 * Because `nStar` is the *largest* such `n`, the slot inserted after it (`nStar + 1`) is always in
 * the future, so an immediate re-fire loop is impossible (§4.4).
 */
export function nStar(
  anchorDate: LocalDate,
  fromIndex: number,
  intervalDays: number,
  deliveryTime: LocalTime,
  tz: string,
  now: number,
): number {
  let n = fromIndex;
  while (slotInstant(anchorDate, n + 1, intervalDays, deliveryTime, tz) <= now) n += 1;
  return n;
}

/** Is the wall clock at `now` inside the household's send window? */
export function isInSendWindow(
  now: number,
  tz: string,
  windowStart: LocalTime,
  windowEnd: LocalTime,
): boolean {
  return isWithinLocalTimeWindow(localTimeOf(now, tz), windowStart, windowEnd);
}

/**
 * The next instant at which the send window opens, at or after `now`.
 *
 * Used to park a *late* slot rather than push it at 03:00 (§4.5 rule 7). When `now` is already
 * inside the window this returns `now`, so an on-time slot is never delayed.
 */
export function nextSendWindowOpen(
  now: number,
  tz: string,
  windowStart: LocalTime,
  windowEnd: LocalTime,
  todayLocalDate: LocalDate,
): number {
  if (isInSendWindow(now, tz, windowStart, windowEnd)) return now;
  const todayOpen = instantOf(todayLocalDate, windowStart, tz);
  if (todayOpen >= now) return todayOpen;
  return instantOf(addDaysLocal(todayLocalDate, 1), windowStart, tz);
}
