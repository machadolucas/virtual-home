/**
 * The schedule chooser: plain-language explanations, form state ↔ `RecurrenceRule`, and the
 * next-three-dates preview.
 *
 * This module exists because the *difference between the kinds* is the hard part of the whole app
 * (§2.3), and it has to be legible in the UI rather than only in the code:
 *
 *  - "6 months after completion" **drifts on purpose** — finish two months late and the whole
 *    cycle moves two months later.
 *  - "every April and October" **never drifts** — finishing April's task in May still leaves
 *    October's date exactly where it was.
 *  - a "seasonal window" is a period the work must happen inside; the due date is a point in that
 *    window and the task stays open (with the window marked closed) if it is missed.
 *
 * Everything here is pure — `computeNextDue` is pure apart from the injected `now` — so the
 * preview can be produced on the server for a form that has not been saved yet.
 */
import {
  computeNextDue,
  describeRule,
  isCompletionAnchored,
  recurrenceRuleSchema,
  type MonthDay,
  type RecurrenceRule,
  type RecurrenceUnit,
} from "@/domain/recurrence";
import type { LocalDate } from "@/domain/time";
import type { ScheduleKind } from "@/db/schema/maintenance";

/**
 * The kinds the *form* offers. `fixed_calendar` in the database splits into three genuinely
 * different questions here, because "which months?" and "how often from a date?" are not the same
 * question to a human.
 */
export const SCHEDULE_FORM_KINDS = [
  "interval_from_completion",
  "fixed_monthly",
  "fixed_yearly",
  "fixed_interval",
  "seasonal_window",
  "one_off",
] as const;
export type ScheduleFormKind = (typeof SCHEDULE_FORM_KINDS)[number];

export interface ScheduleKindExplanation {
  kind: ScheduleFormKind;
  /** The choice as the user would say it. */
  label: string;
  /** One sentence of plain language. No jargon, no rule syntax. */
  plain: string;
  /** A concrete household example. */
  example: string;
  /** The behaviour that distinguishes it from its neighbours. */
  drift: string;
}

export const SCHEDULE_EXPLANATIONS: readonly ScheduleKindExplanation[] = [
  {
    kind: "interval_from_completion",
    label: "A set time after it was last done",
    plain: "The clock restarts every time the task is completed.",
    example: "Replace the ventilation filters 6 months after the last replacement.",
    drift:
      "Finishing late moves everything later: complete a 6-month task two months late and the next one lands two months later too.",
  },
  {
    kind: "fixed_monthly",
    label: "Certain months, on a fixed day",
    plain: "Specific months of the year, always on the same day of the month.",
    example: "Every April and October, on the 1st.",
    drift:
      "The dates never move. Finishing April's task in May still leaves 1 October exactly where it was.",
  },
  {
    kind: "fixed_yearly",
    label: "Once a year, on a fixed date",
    plain: "The same calendar date every year.",
    example: "Every year on 15 November.",
    drift: "The date never moves, no matter when the work is actually done.",
  },
  {
    kind: "fixed_interval",
    label: "Every N months from a fixed date",
    plain: "A steady interval measured from one anchor date, not from the last completion.",
    example: "Every 3 months from 31 January — so the 31st stays the 31st.",
    drift:
      "The series is recomputed from the anchor each time, so a short month never drags the whole schedule earlier.",
  },
  {
    kind: "seasonal_window",
    label: "Inside a season",
    plain: "A period the work has to happen inside, once a year.",
    example: "Between 1 May and 30 June — service the outdoor tap when it is warm enough.",
    drift:
      "Missing the window does not close the task: it stays open, marked “window closed”, and completing it late still satisfies that year.",
  },
  {
    kind: "one_off",
    label: "Once only",
    plain: "A single task with a date. Nothing is generated after it is done.",
    example: "Get the chimney inspected before selling.",
    drift: "No repetition at all.",
  },
];

export function explanationFor(kind: ScheduleFormKind): ScheduleKindExplanation {
  return SCHEDULE_EXPLANATIONS.find((e) => e.kind === kind) ?? SCHEDULE_EXPLANATIONS[0]!;
}

/** Which `maintenance_plan.schedule_kind` a form kind stores as. */
export function scheduleKindOf(kind: ScheduleFormKind): ScheduleKind {
  switch (kind) {
    case "interval_from_completion":
      return "interval_from_completion";
    case "fixed_monthly":
    case "fixed_yearly":
    case "fixed_interval":
      return "fixed_calendar";
    case "seasonal_window":
      return "seasonal_window";
    case "one_off":
      return "one_off";
  }
}

/** The form kind a stored rule came from — so editing a plan reopens the right question. */
export function formKindOf(rule: RecurrenceRule): ScheduleFormKind | null {
  switch (rule.kind) {
    case "interval_from_completion":
      return "interval_from_completion";
    case "fixed_monthly":
      return "fixed_monthly";
    case "fixed_yearly":
      return "fixed_yearly";
    case "fixed_interval":
      return "fixed_interval";
    case "seasonal_window":
      return "seasonal_window";
    case "one_off":
      return "one_off";
    // Condition plans are created by the HA rules, never by this form.
    case "condition":
      return null;
  }
}

/**
 * Everything the schedule step of the wizard holds. One flat object rather than a discriminated
 * union, because a user who switches kind twice should find their previous answers still there.
 */
export interface ScheduleFormState {
  kind: ScheduleFormKind;
  every: number;
  unit: RecurrenceUnit;
  /** `fixed_monthly`: 1..12, at least one. */
  months: number[];
  /** `fixed_monthly`: 1..31 or `'last'`. */
  dayOfMonth: number | "last";
  /** `fixed_yearly`. */
  yearlyMonth: number;
  yearlyDay: number | "last";
  /** `fixed_interval`. */
  anchorDate: LocalDate | "";
  /** `seasonal_window`. */
  windowStart: MonthDay;
  windowEnd: MonthDay;
  dueOn: "window_start" | "window_end" | "after_start_days";
  afterStartDays: number;
}

export const DEFAULT_SCHEDULE_FORM: ScheduleFormState = {
  kind: "interval_from_completion",
  every: 6,
  unit: "month",
  months: [4, 10],
  dayOfMonth: 1,
  yearlyMonth: 11,
  yearlyDay: 15,
  anchorDate: "",
  windowStart: { month: 5, day: 1 },
  windowEnd: { month: 6, day: 30 },
  dueOn: "window_start",
  afterStartDays: 14,
};

export type RuleResult =
  | { ok: true; rule: RecurrenceRule }
  | { ok: false; error: string };

/**
 * Turn the form into a validated `RecurrenceRule`, or explain in one sentence what is missing.
 *
 * The Zod schema is the same one every plan write runs through, so a rule that passes here cannot
 * be rejected later by the server for a different reason.
 */
export function toRecurrenceRule(form: ScheduleFormState): RuleResult {
  const candidate = draftRule(form);
  if (candidate === null) return { ok: false, error: missingFieldMessage(form) };
  const parsed = recurrenceRuleSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "That schedule is not valid." };
  }
  return { ok: true, rule: parsed.data };
}

function draftRule(form: ScheduleFormState): RecurrenceRule | null {
  switch (form.kind) {
    case "one_off":
      return { v: 1, kind: "one_off" };
    case "interval_from_completion":
      if (!Number.isInteger(form.every) || form.every < 1) return null;
      return { v: 1, kind: "interval_from_completion", every: form.every, unit: form.unit };
    case "fixed_monthly":
      if (form.months.length === 0) return null;
      return {
        v: 1,
        kind: "fixed_monthly",
        months: [...form.months].sort((a, b) => a - b),
        dayOfMonth: form.dayOfMonth,
      };
    case "fixed_yearly":
      return { v: 1, kind: "fixed_yearly", month: form.yearlyMonth, day: form.yearlyDay };
    case "fixed_interval":
      if (form.anchorDate === "") return null;
      if (!Number.isInteger(form.every) || form.every < 1) return null;
      return {
        v: 1,
        kind: "fixed_interval",
        anchorDate: form.anchorDate,
        every: form.every,
        unit: form.unit,
      };
    case "seasonal_window":
      return {
        v: 1,
        kind: "seasonal_window",
        windowStart: form.windowStart,
        windowEnd: form.windowEnd,
        dueOn:
          form.dueOn === "after_start_days"
            ? { afterStartDays: form.afterStartDays }
            : form.dueOn,
        timesPerYear: 1,
      };
  }
}

function missingFieldMessage(form: ScheduleFormState): string {
  switch (form.kind) {
    case "fixed_monthly":
      return "Pick at least one month.";
    case "fixed_interval":
      return form.anchorDate === ""
        ? "Pick the date the interval is measured from."
        : "The interval must be a whole number of at least 1.";
    default:
      return "The interval must be a whole number of at least 1.";
  }
}

export interface PreviewEntry {
  dueDate: LocalDate;
  windowStartDate: LocalDate | null;
  windowEndDate: LocalDate | null;
  /** Series dates that fell entirely in the past and were rolled over — never fabricated as done. */
  missedSeriesDates: LocalDate[];
}

export interface SchedulePreview {
  entries: PreviewEntry[];
  /** Wording for the rule itself, from the domain (`describeRule`). */
  ruleText: string;
  /**
   * What the preview *assumes*, spelled out. For completion-anchored rules every date after the
   * first assumes the previous one was completed exactly on time — which is worth saying, because
   * in reality those rules drift.
   */
  assumption: string;
  /** Set when the rule generates nothing further (`one_off`). */
  terminal: boolean;
  error: string | null;
}

export interface PreviewInput {
  rule: RecurrenceRule;
  /** The plan's schedule anchor, or `null` for "no anchor chosen yet". */
  anchorDate: LocalDate | null;
  nowMs: number;
  tz: string;
  count?: number;
}

/**
 * The next `count` due dates. Each step feeds the previous due date back in as the anchor, which is
 * exactly what the lifecycle does — for calendar kinds because the reference *is* the previous due
 * date, and for completion-anchored kinds under the stated assumption that each one is completed
 * on its due date.
 */
export function previewDueDates(input: PreviewInput): SchedulePreview {
  const { rule, tz, nowMs } = input;
  const count = input.count ?? 3;
  const completionAnchored = isCompletionAnchored(rule);
  const ruleText = describeRule(rule);

  if (rule.kind === "one_off" || rule.kind === "condition") {
    return {
      entries: [],
      ruleText,
      assumption:
        rule.kind === "one_off"
          ? "A one-off task has a single date, which you set below."
          : "Condition tasks appear when a reading crosses its threshold, so there is no calendar to preview.",
      terminal: true,
      error: null,
    };
  }

  if (completionAnchored && input.anchorDate === null) {
    return {
      entries: [],
      ruleText,
      assumption:
        "This kind of schedule measures from the last completion, so it needs a starting point before it can show any date.",
      terminal: false,
      error: null,
    };
  }

  const entries: PreviewEntry[] = [];
  let anchor: LocalDate | null = input.anchorDate;

  try {
    for (let i = 0; i < count; i++) {
      const next = computeNextDue(
        rule,
        { date: anchor, source: anchor === null ? "none" : "user_chosen" },
        nowMs,
        tz,
      );
      if (next === null) break;
      entries.push({
        dueDate: next.dueDate,
        windowStartDate: next.windowStartDate ?? null,
        windowEndDate: next.windowEndDate ?? null,
        missedSeriesDates: next.missedSeriesDates,
      });
      // Feeding the produced date back in is what the lifecycle itself does: calendar kinds
      // reference the previous *due date*, and completion-anchored kinds reference the completion
      // (here assumed to land on the due date — stated in `assumption`).
      anchor = next.dueDate;
    }
  } catch (err) {
    // The domain only looks a few years ahead when materialising a calendar series, so asking for
    // a fourth or fifth date can run out of candidates. That is a limit of the lookahead, not a
    // broken rule — so it is only reported as an error when *no* date could be produced at all.
    if (entries.length > 0) {
      return {
        entries,
        ruleText,
        assumption: completionAnchored
          ? "Each date after the first assumes the one before it was completed exactly on its due date."
          : "These dates do not move: they come from the calendar, not from when the work is done.",
        terminal: false,
        error: null,
      };
    }
    return {
      entries,
      ruleText,
      assumption: "",
      terminal: false,
      error: err instanceof Error ? err.message : "That schedule produced no dates.",
    };
  }

  return {
    entries,
    ruleText,
    assumption: completionAnchored
      ? "Each date after the first assumes the one before it was completed exactly on its due date. Completing late moves the rest later."
      : "These dates do not move: they come from the calendar, not from when the work is done.",
    terminal: false,
    error: null,
  };
}

/** `every`/`unit` in words for a summary line: `6 months`. */
export function describeInterval(every: number, unit: RecurrenceUnit): string {
  return every === 1 ? `1 ${unit}` : `${every} ${unit}s`;
}

export const SEED_EXPLANATIONS = [
  {
    kind: "baseline_exact" as const,
    label: "I know the exact date",
    plain:
      "Records a starting point for the schedule. It is not logged as a completion — History stays empty for it.",
  },
  {
    kind: "baseline_approx" as const,
    label: "Roughly — a month or a season",
    plain:
      "Same as above, with the uncertainty kept: the task may show up as already overdue, and the app will say “estimated” instead of counting days.",
  },
  {
    kind: "user_chosen" as const,
    label: "No idea — I'll pick a start date",
    plain: "The schedule starts from the date you pick. Nothing is claimed about the past.",
  },
  {
    kind: "start_now" as const,
    label: "No idea — start now",
    plain: "The schedule starts today.",
  },
  {
    kind: "install_date" as const,
    label: "Use the equipment's install date",
    plain: "Takes the anchor from the asset's recorded installation date.",
  },
  {
    kind: "ask_later" as const,
    label: "Ask me later",
    plain:
      "The plan is saved but paused, and no task is generated until you answer. It appears in a “needs setup” list.",
  },
] as const;

export type SeedExplanationKind = (typeof SEED_EXPLANATIONS)[number]["kind"];

/**
 * A stored rule back into form state, so editing a plan reopens the same question that created it.
 *
 * Fields the rule does not use keep their defaults — a user who switches kind while editing should
 * find sensible values rather than zeros.
 */
export function formStateFromRule(rule: RecurrenceRule): ScheduleFormState {
  const base = { ...DEFAULT_SCHEDULE_FORM };
  switch (rule.kind) {
    case "one_off":
      return { ...base, kind: "one_off" };
    case "interval_from_completion":
      return { ...base, kind: "interval_from_completion", every: rule.every, unit: rule.unit };
    case "fixed_monthly":
      return {
        ...base,
        kind: "fixed_monthly",
        months: [...rule.months],
        dayOfMonth: rule.dayOfMonth,
      };
    case "fixed_yearly":
      return { ...base, kind: "fixed_yearly", yearlyMonth: rule.month, yearlyDay: rule.day };
    case "fixed_interval":
      return {
        ...base,
        kind: "fixed_interval",
        every: rule.every,
        unit: rule.unit,
        anchorDate: rule.anchorDate,
      };
    case "seasonal_window":
      return {
        ...base,
        kind: "seasonal_window",
        windowStart: rule.windowStart,
        windowEnd: rule.windowEnd,
        dueOn: typeof rule.dueOn === "string" ? rule.dueOn : "after_start_days",
        afterStartDays: typeof rule.dueOn === "string" ? base.afterStartDays : rule.dueOn.afterStartDays,
      };
    // Condition plans are not editable through this form.
    case "condition":
      return base;
  }
}
