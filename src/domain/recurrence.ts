/**
 * Recurrence rules and `computeNextDue` — pure calendar logic, `now` injected.
 *
 * Design: `docs/design-notes/domain-scheduling-inventory.md` §2.
 *
 * Two behaviours carry the whole design and are easy to get wrong:
 *  - **completion-anchored** rules (`interval_from_completion`) deliberately drift: completing a
 *    6-month task two months late moves the whole cycle two months later, because "6 months after
 *    the actual completion" is what the household means. There is **no** roll-forward: a backdated
 *    anchor yields an immediately-overdue occurrence, which is the truth.
 *  - **calendar** rules (`fixed_monthly`, `fixed_yearly`, `fixed_interval`, `seasonal_window`)
 *    never drift: the reference is the previous *due date*, never the completion date, and every
 *    `fixed_interval` candidate is recomputed as `anchorDate + k × every`, which is what kills the
 *    31 → 28 → 28 → 28 bug.
 *
 * `fixed_weekly` is **not implemented** in this version (see `docs/design-notes/README.md`); the
 * Zod schema rejects it rather than silently accepting a rule nothing honours.
 */
import { z } from "zod";
import type { ScheduleAnchorSource } from "@/db/schema/maintenance";
import { ValidationError } from "./errors";
import {
  addDaysLocal,
  addMonthsClamped,
  compareLocalDate,
  formatLocalDate,
  isValidLocalDate,
  lastDayOfMonth,
  localDateOf,
  monthsBetweenLocal,
  daysBetweenLocal,
  parseLocalDate,
  type LocalDate,
} from "./time";

export const RECURRENCE_UNITS = ["day", "week", "month", "year"] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

/** `{ month: 1..12, day: 1..31 | 'last' }` */
export interface MonthDay {
  month: number;
  day: number | "last";
}

export type RecurrenceRule =
  | { v: 1; kind: "one_off" }
  /** "6 months after the actual completion" */
  | {
      v: 1;
      kind: "interval_from_completion";
      every: number;
      unit: RecurrenceUnit;
      clamp?: "end_of_month";
    }
  /** "every April and October, on the 1st" / "every 1st of the month" */
  | { v: 1; kind: "fixed_monthly"; months: number[]; dayOfMonth: number | "last" }
  /** "every year on 15 November" */
  | { v: 1; kind: "fixed_yearly"; month: number; day: number | "last" }
  /** calendar-anchored interval that must not drift: "every 3 months from 2026-01-31" */
  | { v: 1; kind: "fixed_interval"; anchorDate: LocalDate; every: number; unit: RecurrenceUnit }
  /** "between 1 May and 30 June, once per year" */
  | {
      v: 1;
      kind: "seasonal_window";
      windowStart: MonthDay;
      windowEnd: MonthDay;
      dueOn: "window_start" | "window_end" | { afterStartDays: number };
      timesPerYear: 1;
    }
  /** condition-driven plans carry no calendar rule */
  | { v: 1; kind: "condition" };

export type RecurrenceKind = RecurrenceRule["kind"];

/** Kinds whose next due date is measured from the completion, not from the previous due date. */
export const COMPLETION_ANCHORED_KINDS: readonly RecurrenceKind[] = ["interval_from_completion"];

export function isCompletionAnchored(rule: RecurrenceRule): boolean {
  return COMPLETION_ANCHORED_KINDS.includes(rule.kind);
}

/** Same value set as `maintenance_plan.schedule_anchor_source`, by construction. */
export type AnchorSource = ScheduleAnchorSource;

export interface Anchor {
  /**
   * Completion-anchored kinds: the completion's local date.
   * Calendar kinds: the **due date** of the occurrence just closed — never the completion date.
   */
  date: LocalDate | null;
  source: AnchorSource;
}

export interface NextDue {
  dueDate: LocalDate;
  windowStartDate?: LocalDate;
  windowEndDate?: LocalDate;
  /** Calendar dates in the series that fell entirely in the past and were rolled over. */
  missedSeriesDates: LocalDate[];
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const localDateSchema = z.string().refine(isValidLocalDate, { message: "not a YYYY-MM-DD date" });
const monthSchema = z.number().int().min(1).max(12);
const everySchema = z.number().int().min(1);
const dayOfMonthSchema = z.union([z.number().int().min(1).max(31), z.literal("last")]);
const unitSchema = z.enum(RECURRENCE_UNITS);

/**
 * A month/day pair that exists in **every** year — so `{month:2, day:29}` is rejected while
 * `{month:2, day:'last'}` is accepted. Used by `fixed_yearly` and `seasonal_window`, whose dates
 * are materialised in an arbitrary year and must never silently shift.
 */
const monthDaySchema = z
  .object({ month: monthSchema, day: dayOfMonthSchema })
  .refine((md) => md.day === "last" || md.day <= lastDayOfMonth(2001, md.month), {
    message: "day does not exist in that month every year",
  });

export const recurrenceRuleSchema: z.ZodType<RecurrenceRule> = z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("one_off") }),
  z.object({
    v: z.literal(1),
    kind: z.literal("interval_from_completion"),
    every: everySchema,
    unit: unitSchema,
    clamp: z.literal("end_of_month").optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("fixed_monthly"),
    months: z
      .array(monthSchema)
      .min(1)
      .refine((ms) => new Set(ms).size === ms.length, { message: "months must be unique" }),
    dayOfMonth: dayOfMonthSchema,
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("fixed_yearly"),
    month: monthSchema,
    day: dayOfMonthSchema,
  }).refine((r) => r.day === "last" || r.day <= lastDayOfMonth(2001, r.month), {
    message: "day does not exist in that month every year",
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("fixed_interval"),
    anchorDate: localDateSchema,
    every: everySchema,
    unit: unitSchema,
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("seasonal_window"),
    windowStart: monthDaySchema,
    windowEnd: monthDaySchema,
    dueOn: z.union([
      z.literal("window_start"),
      z.literal("window_end"),
      z.object({ afterStartDays: z.number().int().min(0) }),
    ]),
    timesPerYear: z.literal(1),
  }),
  z.object({ v: z.literal(1), kind: z.literal("condition") }),
]) as z.ZodType<RecurrenceRule>;

/** Parse (and validate) `maintenance_plan.recurrence_json`. */
export function parseRecurrenceRule(json: string): RecurrenceRule {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ValidationError("invalid_recurrence_json", "recurrence_json is not valid JSON");
  }
  const parsed = recurrenceRuleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("invalid_recurrence_rule", "recurrence_json failed validation", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------------------------

function addUnit(d: LocalDate, n: number, unit: RecurrenceUnit): LocalDate {
  switch (unit) {
    case "day":
      return addDaysLocal(d, n);
    case "week":
      return addDaysLocal(d, n * 7);
    case "month":
      return addMonthsClamped(d, n);
    case "year":
      return addMonthsClamped(d, n * 12);
  }
}

function materialiseDay(year: number, month: number, day: number | "last"): LocalDate {
  const last = lastDayOfMonth(year, month);
  return formatLocalDate(year, month, day === "last" ? last : Math.min(day, last));
}

function materialiseMonthDay(md: MonthDay, year: number): LocalDate {
  return materialiseDay(year, md.month, md.day);
}

/** Sort key that makes "does this month/day come before that one" a plain number comparison. */
function monthDayKey(md: MonthDay): number {
  return md.month * 100 + (md.day === "last" ? 99 : md.day);
}

/**
 * The first date of `rule`'s series strictly after `ref`.
 *
 * `fixed_interval` recomputes `anchorDate + every × k` for each candidate rather than stepping from
 * the previous one — that is the whole reason the 31st stays the 31st.
 */
function firstSeriesDateStrictlyAfter(rule: RecurrenceRule, ref: LocalDate): LocalDate {
  switch (rule.kind) {
    case "fixed_monthly": {
      const months = [...rule.months].sort((a, b) => a - b);
      const from = parseLocalDate(ref).year;
      for (let year = from; year <= from + 5; year++) {
        for (const month of months) {
          const cand = materialiseDay(year, month, rule.dayOfMonth);
          if (compareLocalDate(cand, ref) > 0) return cand;
        }
      }
      throw new ValidationError("no_series_date", "fixed_monthly produced no candidate");
    }
    case "fixed_yearly": {
      const from = parseLocalDate(ref).year;
      for (let year = from; year <= from + 5; year++) {
        const cand = materialiseDay(year, rule.month, rule.day);
        if (compareLocalDate(cand, ref) > 0) return cand;
      }
      throw new ValidationError("no_series_date", "fixed_yearly produced no candidate");
    }
    case "fixed_interval": {
      const dateAt = (k: number): LocalDate => addUnit(rule.anchorDate, rule.every * k, rule.unit);
      // Estimate k, then walk to the exact boundary. Estimating keeps this O(1) for an anchor
      // decades in the past; the walk keeps it correct across clamped month ends.
      let k =
        rule.unit === "month" || rule.unit === "year"
          ? Math.floor(
              monthsBetweenLocal(rule.anchorDate, ref) / (rule.every * (rule.unit === "year" ? 12 : 1)),
            )
          : Math.floor(
              daysBetweenLocal(rule.anchorDate, ref) / (rule.every * (rule.unit === "week" ? 7 : 1)),
            );
      if (!Number.isFinite(k) || k < 0) k = 0;
      while (compareLocalDate(dateAt(k), ref) <= 0) k += 1;
      while (k > 0 && compareLocalDate(dateAt(k - 1), ref) > 0) k -= 1;
      return dateAt(k);
    }
    default:
      throw new ValidationError("not_a_calendar_series", `kind ${rule.kind} has no fixed series`);
  }
}

/** Shared body of every non-drifting calendar kind, so their skip behaviour is literally identical. */
function nextForCalendarSeries(rule: RecurrenceRule, anchor: Anchor, today: LocalDate): NextDue {
  const ref = anchor.date ?? today;
  let cand = firstSeriesDateStrictlyAfter(rule, ref);
  const missedSeriesDates: LocalDate[] = [];
  // Strict `<`: a series date landing on today stays today's due date.
  while (compareLocalDate(cand, today) < 0) {
    missedSeriesDates.push(cand);
    cand = firstSeriesDateStrictlyAfter(rule, cand);
  }
  return { dueDate: cand, missedSeriesDates };
}

interface SeasonalCandidate {
  start: LocalDate;
  end: LocalDate;
  due: LocalDate;
}

function seasonalCandidates(
  rule: Extract<RecurrenceRule, { kind: "seasonal_window" }>,
  ref: LocalDate,
  today: LocalDate,
): SeasonalCandidate[] {
  // A window "belongs to" the year of its **start**, which is what makes 15 Nov → 15 Feb
  // unambiguous.
  const spansNewYear = monthDayKey(rule.windowEnd) < monthDayKey(rule.windowStart);
  const out: SeasonalCandidate[] = [];
  const fromYear = parseLocalDate(ref).year - 1;
  const toYear = parseLocalDate(today).year + 2;
  for (let year = fromYear; year <= toYear; year++) {
    const start = materialiseMonthDay(rule.windowStart, year);
    const end = materialiseMonthDay(rule.windowEnd, spansNewYear ? year + 1 : year);
    const due =
      rule.dueOn === "window_start"
        ? start
        : rule.dueOn === "window_end"
          ? end
          : addDaysLocal(start, rule.dueOn.afterStartDays);
    if (compareLocalDate(start, ref) > 0) out.push({ start, end, due });
  }
  out.sort((a, b) => compareLocalDate(a.start, b.start));
  return out;
}

// ---------------------------------------------------------------------------------------------
// computeNextDue
// ---------------------------------------------------------------------------------------------

/**
 * The next due date for `rule`, or `null` when the rule generates no further occurrence
 * (`one_off`, `condition`).
 *
 * Pure apart from `now`, which is injected — every test uses a fake clock.
 */
export function computeNextDue(
  rule: RecurrenceRule,
  anchor: Anchor,
  now: number,
  tz: string,
): NextDue | null {
  const today = localDateOf(now, tz);

  switch (rule.kind) {
    case "one_off":
    case "condition":
      return null;

    case "interval_from_completion": {
      if (anchor.date === null) {
        throw new ValidationError(
          "anchor_required",
          "interval_from_completion needs an anchor date",
        );
      }
      // No rolling forward, on purpose: a backdated anchor produces an immediately-overdue
      // occurrence rather than silently hiding a missed cycle.
      return { dueDate: addUnit(anchor.date, rule.every, rule.unit), missedSeriesDates: [] };
    }

    case "fixed_monthly":
    case "fixed_yearly":
    case "fixed_interval":
      return nextForCalendarSeries(rule, anchor, today);

    case "seasonal_window": {
      const ref = anchor.date ?? addDaysLocal(today, -1);
      const candidates = seasonalCandidates(rule, ref, today);
      const missedSeriesDates: LocalDate[] = [];
      for (const cand of candidates) {
        // `end < today`, not `due < today`: an occurrence whose window is still open should be
        // created as due-now, not skipped.
        if (compareLocalDate(cand.end, today) < 0) {
          missedSeriesDates.push(cand.due);
          continue;
        }
        return {
          dueDate: cand.due,
          windowStartDate: cand.start,
          windowEndDate: cand.end,
          missedSeriesDates,
        };
      }
      throw new ValidationError("no_series_date", "seasonal_window produced no candidate");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// describeRule
// ---------------------------------------------------------------------------------------------

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

function plural(n: number, unit: string): string {
  return n === 1 ? unit : `${unit}s`;
}

function ordinalDay(day: number | "last"): string {
  if (day === "last") return "last day";
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  return `${day}${suffix}`;
}

function monthDayText(md: MonthDay): string {
  return md.day === "last" ? `the last day of ${monthName(md.month)}` : `${md.day} ${monthName(md.month)}`;
}

/** Human wording for a rule, e.g. `"Every 6 months after completion"`. */
export function describeRule(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case "one_off":
      return "One-off";
    case "condition":
      return "When a condition triggers";
    case "interval_from_completion":
      return rule.every === 1
        ? `Every ${rule.unit} after completion`
        : `Every ${rule.every} ${plural(rule.every, rule.unit)} after completion`;
    case "fixed_monthly": {
      const day = `the ${ordinalDay(rule.dayOfMonth)}`;
      if (rule.months.length === 12) return `Every month on ${day}`;
      const months = [...rule.months].sort((a, b) => a - b).map(monthName);
      const list =
        months.length === 1
          ? months[0]!
          : `${months.slice(0, -1).join(", ")} and ${months[months.length - 1]!}`;
      return `Every ${list} on ${day}`;
    }
    case "fixed_yearly":
      return `Every year on ${monthDayText({ month: rule.month, day: rule.day })}`;
    case "fixed_interval":
      return rule.every === 1
        ? `Every ${rule.unit} from ${rule.anchorDate}`
        : `Every ${rule.every} ${plural(rule.every, rule.unit)} from ${rule.anchorDate}`;
    case "seasonal_window": {
      const window = `between ${monthDayText(rule.windowStart)} and ${monthDayText(rule.windowEnd)}`;
      if (rule.dueOn === "window_end") return `Once a year ${window}, due at the end of the window`;
      if (rule.dueOn === "window_start") return `Once a year ${window}`;
      return `Once a year ${window}, due ${rule.dueOn.afterStartDays} days after it opens`;
    }
  }
}
