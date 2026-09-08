/**
 * Form state ↔ `RecurrenceRule`, and the next-three-dates preview.
 *
 * The preview is the only place the app promises anything about future dates before a plan exists,
 * so the two behaviours the design leans on are asserted here directly:
 *
 *  - a completion-anchored rule **drifts** and the preview says so;
 *  - a calendar rule **does not**, and its dates come out exactly where the calendar puts them.
 */
import { describe, expect, it } from "vitest";
import type { RecurrenceRule } from "@/domain/recurrence";
import { instantOf } from "@/domain/time";
import {
  DEFAULT_SCHEDULE_FORM,
  formKindOf,
  formStateFromRule,
  previewDueDates,
  scheduleKindOf,
  toRecurrenceRule,
  type ScheduleFormState,
} from "@/features/maintenance/schedule";

const TZ = "Europe/Helsinki";
const NOW = instantOf("2026-09-08", "09:00", TZ);

function form(overrides: Partial<ScheduleFormState>): ScheduleFormState {
  return { ...DEFAULT_SCHEDULE_FORM, ...overrides };
}

describe("scheduleKindOf", () => {
  it("collapses the three calendar questions onto one stored kind", () => {
    expect(scheduleKindOf("fixed_monthly")).toBe("fixed_calendar");
    expect(scheduleKindOf("fixed_yearly")).toBe("fixed_calendar");
    expect(scheduleKindOf("fixed_interval")).toBe("fixed_calendar");
    expect(scheduleKindOf("interval_from_completion")).toBe("interval_from_completion");
    expect(scheduleKindOf("seasonal_window")).toBe("seasonal_window");
    expect(scheduleKindOf("one_off")).toBe("one_off");
  });
});

describe("toRecurrenceRule", () => {
  it("builds a completion-anchored interval", () => {
    const result = toRecurrenceRule(form({ kind: "interval_from_completion", every: 6, unit: "month" }));
    expect(result).toEqual({
      ok: true,
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
    });
  });

  it("sorts the months of a fixed-monthly rule", () => {
    const result = toRecurrenceRule(form({ kind: "fixed_monthly", months: [10, 4], dayOfMonth: 1 }));
    expect(result.ok && result.rule).toEqual({
      v: 1,
      kind: "fixed_monthly",
      months: [4, 10],
      dayOfMonth: 1,
    });
  });

  it("explains what is missing instead of producing a half-rule", () => {
    expect(toRecurrenceRule(form({ kind: "fixed_monthly", months: [] }))).toEqual({
      ok: false,
      error: "Pick at least one month.",
    });
    expect(toRecurrenceRule(form({ kind: "fixed_interval", anchorDate: "" }))).toEqual({
      ok: false,
      error: "Pick the date the interval is measured from.",
    });
    expect(toRecurrenceRule(form({ kind: "interval_from_completion", every: 0 }))).toEqual({
      ok: false,
      error: "The interval must be a whole number of at least 1.",
    });
  });

  it("rejects a date that does not exist every year, through the domain's own schema", () => {
    const result = toRecurrenceRule(form({ kind: "fixed_yearly", yearlyMonth: 2, yearlyDay: 29 }));
    expect(result.ok).toBe(false);
    // 'last' is the way to express "end of February".
    expect(toRecurrenceRule(form({ kind: "fixed_yearly", yearlyMonth: 2, yearlyDay: "last" })).ok).toBe(
      true,
    );
  });

  it("maps the seasonal “N days after it opens” choice onto the rule's object form", () => {
    const result = toRecurrenceRule(
      form({ kind: "seasonal_window", dueOn: "after_start_days", afterStartDays: 14 }),
    );
    expect(result.ok && result.rule).toMatchObject({
      kind: "seasonal_window",
      dueOn: { afterStartDays: 14 },
      timesPerYear: 1,
    });
  });
});

describe("formStateFromRule / formKindOf", () => {
  it("round-trips every editable kind", () => {
    const rules: RecurrenceRule[] = [
      { v: 1, kind: "interval_from_completion", every: 3, unit: "month" },
      { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: "last" },
      { v: 1, kind: "fixed_yearly", month: 11, day: 15 },
      { v: 1, kind: "fixed_interval", anchorDate: "2026-01-31", every: 3, unit: "month" },
      {
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 5, day: 1 },
        windowEnd: { month: 6, day: 30 },
        dueOn: "window_end",
        timesPerYear: 1,
      },
      { v: 1, kind: "one_off" },
    ];

    for (const rule of rules) {
      const state = formStateFromRule(rule);
      const back = toRecurrenceRule(state);
      expect(back.ok, JSON.stringify(rule)).toBe(true);
      if (back.ok) expect(back.rule).toEqual(rule);
    }
  });

  it("refuses to offer the form for a condition-driven plan", () => {
    expect(formKindOf({ v: 1, kind: "condition" })).toBeNull();
  });
});

describe("previewDueDates", () => {
  it("drifts for a completion-anchored rule, and says that it assumes on-time completion", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
      anchorDate: "2026-09-08",
      nowMs: NOW,
      tz: TZ,
    });
    expect(preview.entries.map((entry) => entry.dueDate)).toEqual([
      "2027-03-08",
      "2027-09-08",
      "2028-03-08",
    ]);
    expect(preview.assumption).toContain("completed exactly on its due date");
    expect(preview.ruleText).toBe("Every 6 months after completion");
  });

  it("asks for a starting point rather than guessing one", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "interval_from_completion", every: 6, unit: "month" },
      anchorDate: null,
      nowMs: NOW,
      tz: TZ,
    });
    expect(preview.entries).toHaveLength(0);
    expect(preview.assumption).toContain("needs a starting point");
    expect(preview.error).toBeNull();
  });

  it("does not drift for a fixed-monthly rule", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 },
      anchorDate: "2026-04-01",
      nowMs: NOW,
      tz: TZ,
    });
    expect(preview.entries.map((entry) => entry.dueDate)).toEqual([
      "2026-10-01",
      "2027-04-01",
      "2027-10-01",
    ]);
    expect(preview.assumption).toContain("do not move");
  });

  it("keeps the 31st on the 31st for a fixed interval, clamping only where it must", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "fixed_interval", anchorDate: "2026-01-31", every: 1, unit: "month" },
      anchorDate: "2026-01-31",
      nowMs: instantOf("2026-02-01", "09:00", TZ),
      tz: TZ,
    });
    // February clamps to the 28th, and March goes straight back to the 31st — no 28→28→28 drift.
    expect(preview.entries.map((entry) => entry.dueDate)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("carries the window with a seasonal preview", () => {
    const preview = previewDueDates({
      rule: {
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 5, day: 1 },
        windowEnd: { month: 6, day: 30 },
        dueOn: "window_start",
        timesPerYear: 1,
      },
      anchorDate: "2026-05-01",
      nowMs: NOW,
      tz: TZ,
    });
    expect(preview.entries[0]).toEqual({
      dueDate: "2027-05-01",
      windowStartDate: "2027-05-01",
      windowEndDate: "2027-06-30",
      missedSeriesDates: [],
    });
    // The domain's seasonal lookahead reaches two years past today, so a third preview date is
    // not always available — which is reported as "no more dates", never as an error.
    expect(preview.entries.length).toBeGreaterThanOrEqual(2);
    expect(preview.error).toBeNull();
  });

  it("reports a one-off as terminal instead of inventing repeats", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "one_off" },
      anchorDate: "2026-09-08",
      nowMs: NOW,
      tz: TZ,
    });
    expect(preview.terminal).toBe(true);
    expect(preview.entries).toHaveLength(0);
  });

  it("surfaces the dates a late calendar rule rolled over, never as completions", () => {
    const preview = previewDueDates({
      rule: { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 },
      anchorDate: "2026-04-01",
      nowMs: instantOf("2026-12-05", "09:00", TZ),
      tz: TZ,
    });
    expect(preview.entries[0]?.dueDate).toBe("2027-04-01");
    expect(preview.entries[0]?.missedSeriesDates).toEqual(["2026-10-01"]);
  });
});
