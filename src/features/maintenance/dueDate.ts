/**
 * Due-date wording. Pure, React-free and shared by the server components that render Today, the
 * task page and History — so "overdue by 3 days" is spelled exactly one way in the whole app.
 *
 * Two honesty rules from `docs/design-notes/domain-scheduling-inventory.md` come out of here:
 *  - §2.4: when the plan's anchor is only approximate (`baseline_approx`), the UI never says
 *    "overdue by 47 days" — it says "estimated overdue", because the 47 is not a fact;
 *  - §5 in spirit: nothing here invents a status. `unknown` exists for "we have no due date".
 */
import type { StatusKind } from "@/ui/status";
import {
  addDaysLocal,
  compareLocalDate,
  daysBetweenLocal,
  parseLocalDate,
  type LocalDate,
} from "@/domain/time";

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-09-08` → `8 Sep 2026`. Never locale-dependent: the household reads one format. */
export function formatDate(date: LocalDate): string {
  const { year, month, day } = parseLocalDate(date);
  return `${day} ${MONTHS_SHORT[month - 1] ?? month} ${year}`;
}

/** `2026-09-08` → `8 Sep` — for dense rows where the year is implied by context. */
export function formatDateShort(date: LocalDate, today: LocalDate): string {
  const { year, month, day } = parseLocalDate(date);
  const sameYear = parseLocalDate(today).year === year;
  const base = `${day} ${MONTHS_SHORT[month - 1] ?? month}`;
  return sameYear ? base : `${base} ${year}`;
}

/** An instant as `8 Sep 2026, 14:05` in the household zone. */
export function formatInstant(atMs: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** Signed day offset from `today` to `dueDate`: negative = in the past. */
export function dayOffset(dueDate: LocalDate, today: LocalDate): number {
  return daysBetweenLocal(today, dueDate);
}

export interface DueWordingOptions {
  /**
   * The plan's anchor was `baseline_approx` (or the occurrence's generation note says
   * `anchorPrecision: 'approx'`). Suppresses exact overdue counts.
   */
  approximate?: boolean;
}

/**
 * Short relative wording for a due date, e.g. `Due today`, `Overdue by 3 days`, `Due in 12 days`.
 *
 * Beyond a month the relative phrasing stops being useful, so it falls back to the date itself —
 * callers show the absolute date alongside anyway.
 */
export function describeDue(
  dueDate: LocalDate,
  today: LocalDate,
  options: DueWordingOptions = {},
): string {
  const offset = dayOffset(dueDate, today);
  if (offset < 0) {
    const late = -offset;
    if (options.approximate) return "Estimated overdue";
    if (late === 1) return "Overdue by 1 day";
    if (late < 31) return `Overdue by ${late} days`;
    const months = Math.round(late / 30);
    return `Overdue by about ${months} ${months === 1 ? "month" : "months"}`;
  }
  if (offset === 0) return "Due today";
  if (offset === 1) return "Due tomorrow";
  if (offset <= 30) return `Due in ${offset} days`;
  return `Due ${formatDate(dueDate)}`;
}

/** How long ago something happened, in the same voice: `Today`, `Yesterday`, `12 days ago`. */
export function describePast(date: LocalDate, today: LocalDate): string {
  const offset = dayOffset(date, today);
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  if (offset > 1) return `In ${offset} days`;
  const ago = -offset;
  if (ago === 1) return "Yesterday";
  if (ago <= 30) return `${ago} days ago`;
  const months = Math.round(ago / 30);
  if (months < 24) return `about ${months} ${months === 1 ? "month" : "months"} ago`;
  return formatDate(date);
}

/** The subset of an occurrence the status/wording helpers read. */
export interface DueLike {
  status: "pending" | "due" | "completed" | "skipped" | "cancelled";
  dueDate: LocalDate;
  blockedReason: string | null;
  serviceBookingId: string | null;
}

/**
 * The status glyph a task row carries (`src/ui/status.ts` kinds).
 *
 * `blocked` deliberately wins over `overdue`: a blocked task is in the "waiting" group and its row
 * has to say *why* it is not being done. The overdue wording is still shown in the same row, so
 * no information is lost by the glyph choice.
 */
export function occurrenceStatusKind(occ: DueLike, today: LocalDate): StatusKind {
  if (occ.status === "completed") return "ok";
  if (occ.status === "skipped" || occ.status === "cancelled") return "unknown";
  if (occ.blockedReason !== null || occ.serviceBookingId !== null) return "blocked";
  if (compareLocalDate(occ.dueDate, today) < 0) return "overdue";
  return "due";
}

/** Words for a seasonal window: `Window 1 May – 30 Jun`, plus whether it has closed. */
export function describeWindow(
  windowStart: LocalDate | null,
  windowEnd: LocalDate | null,
  today: LocalDate,
): { label: string; closed: boolean } | null {
  if (windowStart === null || windowEnd === null) return null;
  return {
    label: `${formatDate(windowStart)} – ${formatDate(windowEnd)}`,
    closed: compareLocalDate(windowEnd, today) < 0,
  };
}

/** `estimatedMinutes` → `45 min` / `2 h 15 min`. `null` in, `null` out — never "0 min". */
export function formatMinutes(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** How far out a postpone opens by default, in days. A week is the unit people actually think in. */
const POSTPONE_DEFAULT_DAYS = 7;

/**
 * The date the postpone dialog should open with.
 *
 * A week after the due date is the intent, but for a task that is already a month overdue that is
 * a date in the past: the field opens invalid, the button opens disabled, and the user has to
 * retype something before the dialog does anything. So the floor is a week from *today*, and the
 * whole thing is clamped to the household's postpone limit.
 *
 * When the limit itself is already behind us the postpone budget is spent — `postponeExhausted`
 * says so, and the caller should offer that fact rather than an impossible range.
 */
export function defaultPostponeDate(
  dueDate: LocalDate,
  today: LocalDate,
  limitDate: LocalDate,
): LocalDate {
  const fromDue = addDaysLocal(dueDate, POSTPONE_DEFAULT_DAYS);
  const fromToday = addDaysLocal(today, POSTPONE_DEFAULT_DAYS);
  const wanted = compareLocalDate(fromDue, fromToday) > 0 ? fromDue : fromToday;
  return compareLocalDate(wanted, limitDate) > 0 ? limitDate : wanted;
}

/** True when the household's postpone limit is already in the past: no legal date is left. */
export function postponeExhausted(today: LocalDate, limitDate: LocalDate): boolean {
  return compareLocalDate(limitDate, today) < 0;
}
