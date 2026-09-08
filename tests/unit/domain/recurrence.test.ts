/**
 * §9 P0 items 1–15 — recurrence and calendar correctness. (Items 16–17, the seeding matrix, need
 * a database and live at the bottom of this file.)
 *
 * Household zone `Europe/Helsinki` throughout; `now` always comes from a fake clock.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/domain/errors";
import {
  computeNextDue,
  describeRule,
  parseRecurrenceRule,
  recurrenceRuleSchema,
  type Anchor,
  type RecurrenceRule,
} from "@/domain/recurrence";
import { instantOf } from "@/domain/time";
import { fakeClock } from "../../helpers/clock";

const TZ = "Europe/Helsinki";

/** `now` as "this local date at noon" — a time of day that is never a DST edge anywhere. */
function at(localDate: string): number {
  return instantOf(localDate, "12:00", TZ);
}

function next(rule: RecurrenceRule, anchor: Anchor, today: string) {
  const result = computeNextDue(rule, anchor, at(today), TZ);
  if (result === null) throw new Error("expected a next due date");
  return result;
}

function completion(date: string): Anchor {
  return { date, source: "completion" };
}

describe("interval_from_completion", () => {
  const sixMonths: RecurrenceRule = {
    v: 1,
    kind: "interval_from_completion",
    every: 6,
    unit: "month",
  };

  // 1
  it("adds 6 months to the completion date", () => {
    expect(next(sixMonths, completion("2026-09-08"), "2026-09-08").dueDate).toBe("2027-03-08");
  });

  // 2
  it("re-anchors on a late completion (the cycle moves, on purpose)", () => {
    // Due was 2026-03-01; the work actually happened on 2026-08-20.
    expect(next(sixMonths, completion("2026-08-20"), "2026-08-20").dueDate).toBe("2027-02-20");
  });

  // 3
  it("re-anchors earlier on an early completion", () => {
    expect(next(sixMonths, completion("2026-05-10"), "2026-05-10").dueDate).toBe("2026-11-10");
  });

  // 4
  it("never rolls a backdated anchor forward — the next occurrence is already overdue", () => {
    const result = next(sixMonths, { date: "2024-04-15", source: "baseline_approx" }, "2026-09-08");
    expect(result.dueDate).toBe("2024-10-15");
    expect(result.dueDate < "2026-09-08").toBe(true);
    expect(result.missedSeriesDates).toEqual([]);
  });

  // 11
  it("six 1-month steps degrade the day of month; one 6-month step does not", () => {
    const monthly: RecurrenceRule = {
      v: 1,
      kind: "interval_from_completion",
      every: 1,
      unit: "month",
    };
    const steps: string[] = [];
    let date = "2026-08-31";
    for (let i = 0; i < 6; i++) {
      date = next(monthly, completion(date), date).dueDate;
      steps.push(date);
    }
    // The clamp at the end of September is permanent: the series never returns to the 31st.
    expect(steps).toEqual([
      "2026-09-30",
      "2026-10-30",
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
    // The single 6-month step clamps only once, from the original 31st.
    expect(next(sixMonths, completion("2026-08-31"), "2026-08-31").dueDate).toBe("2027-02-28");
    // Same endpoint here by coincidence of February; the *paths* differ, which is why a
    // completion-anchored rule must never be evaluated by iterating small steps.
    expect(steps[1]).not.toBe("2026-10-31");
  });

  it("supports day, week and year units", () => {
    const day: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 10, unit: "day" };
    const week: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 2, unit: "week" };
    const year: RecurrenceRule = { v: 1, kind: "interval_from_completion", every: 1, unit: "year" };
    expect(next(day, completion("2026-02-25"), "2026-02-25").dueDate).toBe("2026-03-07");
    expect(next(week, completion("2026-02-25"), "2026-02-25").dueDate).toBe("2026-03-11");
    expect(next(year, completion("2028-02-29"), "2028-02-29").dueDate).toBe("2029-02-28");
  });

  it("throws when the anchor is missing", () => {
    expect(() => computeNextDue(sixMonths, { date: null, source: "none" }, at("2026-09-08"), TZ))
      .toThrowError(ValidationError);
  });
});

describe("fixed_monthly", () => {
  const aprilOctober: RecurrenceRule = {
    v: 1,
    kind: "fixed_monthly",
    months: [4, 10],
    dayOfMonth: 1,
  };

  // 5
  it("ignores the completion date — the series is the series", () => {
    const result = next(aprilOctober, completion("2026-04-01"), "2026-04-20");
    expect(result.dueDate).toBe("2026-10-01");
    expect(result.missedSeriesDates).toEqual([]);
  });

  // 6
  it("rolls past series dates that are already gone and reports them", () => {
    const result = next(aprilOctober, completion("2026-04-01"), "2026-12-05");
    expect(result.dueDate).toBe("2027-04-01");
    expect(result.missedSeriesDates).toEqual(["2026-10-01"]);
  });

  it("keeps a series date landing exactly on today", () => {
    expect(next(aprilOctober, completion("2026-04-01"), "2026-10-01").dueDate).toBe("2026-10-01");
  });

  // 7
  it("clamps day 31 without advancing or drifting the series", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_monthly",
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      dayOfMonth: 31,
    };
    expect(next(rule, completion("2026-01-31"), "2026-02-01").dueDate).toBe("2026-02-28");
    expect(next(rule, completion("2026-02-28"), "2026-03-01").dueDate).toBe("2026-03-31");
    expect(next(rule, completion("2026-03-31"), "2026-04-01").dueDate).toBe("2026-04-30");
  });

  // 8
  it("supports dayOfMonth 'last'", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_monthly",
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      dayOfMonth: "last",
    };
    expect(next(rule, completion("2026-01-31"), "2026-02-01").dueDate).toBe("2026-02-28");
    expect(next(rule, completion("2026-02-28"), "2026-03-01").dueDate).toBe("2026-03-31");
    expect(next(rule, completion("2026-03-31"), "2026-04-01").dueDate).toBe("2026-04-30");
  });

  it("falls back to today as the reference when there is no anchor", () => {
    const result = next(aprilOctober, { date: null, source: "user_chosen" }, "2026-05-04");
    expect(result.dueDate).toBe("2026-10-01");
  });
});

describe("fixed_interval", () => {
  // 9
  it("computes anchor + k×every each time, so month ends never drift", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_interval",
      anchorDate: "2026-01-31",
      every: 1,
      unit: "month",
    };
    expect(next(rule, completion("2026-01-31"), "2026-02-01").dueDate).toBe("2026-02-28");
    expect(next(rule, completion("2026-02-28"), "2026-03-01").dueDate).toBe("2026-03-31");
    expect(next(rule, completion("2026-03-31"), "2026-04-01").dueDate).toBe("2026-04-30");
    expect(next(rule, completion("2026-04-30"), "2026-05-01").dueDate).toBe("2026-05-31");
  });

  // 10 (second half)
  it("clamps a leap-day anchor one year on", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_interval",
      anchorDate: "2028-02-29",
      every: 1,
      unit: "year",
    };
    expect(next(rule, completion("2028-02-29"), "2028-03-01").dueDate).toBe("2029-02-28");
  });

  it("handles an anchor decades in the past and a future anchor", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_interval",
      anchorDate: "1996-01-15",
      every: 3,
      unit: "month",
    };
    expect(next(rule, { date: null, source: "none" }, "2026-09-08").dueDate).toBe("2026-10-15");
    const future: RecurrenceRule = {
      v: 1,
      kind: "fixed_interval",
      anchorDate: "2030-06-01",
      every: 1,
      unit: "month",
    };
    expect(next(future, { date: null, source: "none" }, "2026-09-08").dueDate).toBe("2030-06-01");
  });

  it("reports every skipped series date after a long gap", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "fixed_interval",
      anchorDate: "2026-01-01",
      every: 1,
      unit: "month",
    };
    const result = next(rule, completion("2026-01-01"), "2026-05-10");
    expect(result.dueDate).toBe("2026-06-01");
    expect(result.missedSeriesDates).toEqual(["2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"]);
  });
});

describe("fixed_yearly", () => {
  it("returns the next 15 November", () => {
    const rule: RecurrenceRule = { v: 1, kind: "fixed_yearly", month: 11, day: 15 };
    expect(next(rule, completion("2026-11-15"), "2026-11-20").dueDate).toBe("2027-11-15");
  });

  // 10 (first half)
  it("rejects a 29 February rule at validation time", () => {
    expect(recurrenceRuleSchema.safeParse({ v: 1, kind: "fixed_yearly", month: 2, day: 29 }).success)
      .toBe(false);
    expect(recurrenceRuleSchema.safeParse({ v: 1, kind: "fixed_yearly", month: 2, day: 28 }).success)
      .toBe(true);
    expect(
      recurrenceRuleSchema.safeParse({ v: 1, kind: "fixed_yearly", month: 2, day: "last" }).success,
    ).toBe(true);
  });
});

describe("seasonal_window", () => {
  const mayJune: RecurrenceRule = {
    v: 1,
    kind: "seasonal_window",
    windowStart: { month: 5, day: 1 },
    windowEnd: { month: 6, day: 30 },
    dueOn: "window_start",
    timesPerYear: 1,
  };

  // 12
  it("returns next year's window with both window dates set", () => {
    const result = next(mayJune, completion("2026-05-01"), "2026-06-12");
    expect(result.dueDate).toBe("2027-05-01");
    expect(result.windowStartDate).toBe("2027-05-01");
    expect(result.windowEndDate).toBe("2027-06-30");
    expect(result.missedSeriesDates).toEqual([]);
  });

  // 13
  it("a very late completion still satisfies that year and yields the following one", () => {
    const result = next(mayJune, completion("2027-05-01"), "2027-08-02");
    expect(result.dueDate).toBe("2028-05-01");
    expect(result.windowEndDate).toBe("2028-06-30");
  });

  it("does not skip a window that is still open (rolls on end, not on due)", () => {
    // Anchor 2026-05-01, today inside the 2027 window but past its due date.
    const result = next(mayJune, completion("2026-05-01"), "2027-06-20");
    expect(result.dueDate).toBe("2027-05-01");
    expect(result.windowEndDate).toBe("2027-06-30");
    expect(result.missedSeriesDates).toEqual([]);
  });

  it("records a window that closed entirely unattended", () => {
    const result = next(mayJune, completion("2026-05-01"), "2027-09-01");
    expect(result.dueDate).toBe("2028-05-01");
    expect(result.missedSeriesDates).toEqual(["2027-05-01"]);
  });

  // 14
  it("handles a window that spans New Year (15 Nov – 15 Feb)", () => {
    const rule: RecurrenceRule = {
      v: 1,
      kind: "seasonal_window",
      windowStart: { month: 11, day: 15 },
      windowEnd: { month: 2, day: 15 },
      dueOn: "window_start",
      timesPerYear: 1,
    };
    const result = next(rule, completion("2026-11-15"), "2027-03-01");
    expect(result.dueDate).toBe("2027-11-15");
    expect(result.windowStartDate).toBe("2027-11-15");
    expect(result.windowEndDate).toBe("2028-02-15");
    expect(result.missedSeriesDates).toEqual([]);
  });

  it("supports dueOn window_end and afterStartDays", () => {
    const end: RecurrenceRule = { ...mayJune, dueOn: "window_end" };
    expect(next(end, completion("2026-05-01"), "2026-06-12").dueDate).toBe("2027-06-30");
    const after: RecurrenceRule = { ...mayJune, dueOn: { afterStartDays: 14 } };
    const result = next(after, completion("2026-05-01"), "2026-06-12");
    expect(result.dueDate).toBe("2027-05-15");
    expect(result.windowStartDate).toBe("2027-05-01");
  });

  it("uses yesterday as the reference when there is no anchor", () => {
    const result = next(mayJune, { date: null, source: "user_chosen" }, "2026-05-01");
    // Yesterday (30 Apr) < 1 May, so this year's window is the candidate and it is open today.
    expect(result.dueDate).toBe("2026-05-01");
  });
});

describe("one_off and condition", () => {
  it("generate no further occurrence", () => {
    expect(computeNextDue({ v: 1, kind: "one_off" }, completion("2026-09-08"), at("2026-09-08"), TZ))
      .toBeNull();
    expect(
      computeNextDue({ v: 1, kind: "condition" }, { date: null, source: "none" }, at("2026-09-08"), TZ),
    ).toBeNull();
  });
});

describe("validation", () => {
  // 15 — `fixed_weekly` is deliberately not implemented in this version.
  it("rejects fixed_weekly rather than half-supporting it", () => {
    const parsed = recurrenceRuleSchema.safeParse({
      v: 1,
      kind: "fixed_weekly",
      weekdays: [6],
      everyNWeeks: 2,
      anchorDate: "2027-01-02",
    });
    expect(parsed.success).toBe(false);
    expect(() =>
      parseRecurrenceRule('{"v":1,"kind":"fixed_weekly","weekdays":[6],"anchorDate":"2027-01-02"}'),
    ).toThrowError(ValidationError);
  });

  it("rejects the documented bad inputs", () => {
    const bad: unknown[] = [
      { v: 1, kind: "interval_from_completion", every: 0, unit: "month" },
      { v: 1, kind: "interval_from_completion", every: 1, unit: "fortnight" },
      { v: 1, kind: "fixed_monthly", months: [], dayOfMonth: 1 },
      { v: 1, kind: "fixed_monthly", months: [1, 1], dayOfMonth: 1 },
      { v: 1, kind: "fixed_monthly", months: [13], dayOfMonth: 1 },
      { v: 1, kind: "fixed_monthly", months: [1], dayOfMonth: 32 },
      { v: 1, kind: "fixed_interval", anchorDate: "2026-02-30", every: 1, unit: "month" },
      {
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 2, day: 30 },
        windowEnd: { month: 6, day: 30 },
        dueOn: "window_start",
        timesPerYear: 1,
      },
      {
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 5, day: 1 },
        windowEnd: { month: 6, day: 30 },
        dueOn: "window_start",
        timesPerYear: 2,
      },
      { v: 2, kind: "one_off" },
    ];
    for (const rule of bad) expect(recurrenceRuleSchema.safeParse(rule).success).toBe(false);
  });

  it("accepts a February 'last' seasonal window", () => {
    expect(
      recurrenceRuleSchema.safeParse({
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 11, day: 15 },
        windowEnd: { month: 2, day: "last" },
        dueOn: "window_start",
        timesPerYear: 1,
      }).success,
    ).toBe(true);
  });

  it("parseRecurrenceRule rejects non-JSON and unknown kinds", () => {
    expect(() => parseRecurrenceRule("not json")).toThrowError(ValidationError);
    expect(() => parseRecurrenceRule('{"v":1,"kind":"whenever"}')).toThrowError(ValidationError);
    expect(parseRecurrenceRule('{"v":1,"kind":"one_off"}')).toEqual({ v: 1, kind: "one_off" });
  });
});

describe("describeRule", () => {
  it("produces the wording the UI shows", () => {
    expect(describeRule({ v: 1, kind: "interval_from_completion", every: 6, unit: "month" })).toBe(
      "Every 6 months after completion",
    );
    expect(describeRule({ v: 1, kind: "interval_from_completion", every: 1, unit: "year" })).toBe(
      "Every year after completion",
    );
    expect(describeRule({ v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 })).toBe(
      "Every April and October on the 1st",
    );
    expect(
      describeRule({
        v: 1,
        kind: "fixed_monthly",
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        dayOfMonth: "last",
      }),
    ).toBe("Every month on the last day");
    expect(describeRule({ v: 1, kind: "fixed_yearly", month: 11, day: 15 })).toBe(
      "Every year on 15 November",
    );
    expect(
      describeRule({ v: 1, kind: "fixed_interval", anchorDate: "2026-01-31", every: 3, unit: "month" }),
    ).toBe("Every 3 months from 2026-01-31");
    expect(
      describeRule({
        v: 1,
        kind: "seasonal_window",
        windowStart: { month: 5, day: 1 },
        windowEnd: { month: 6, day: 30 },
        dueOn: "window_start",
        timesPerYear: 1,
      }),
    ).toBe("Once a year between 1 May and 30 June");
    expect(describeRule({ v: 1, kind: "one_off" })).toBe("One-off");
    expect(describeRule({ v: 1, kind: "condition" })).toBe("When a condition triggers");
  });
});

describe("now is always injected", () => {
  it("uses the fake clock's instant, not the system clock", () => {
    const clock = fakeClock("2026-12-05T10:00:00Z");
    const rule: RecurrenceRule = { v: 1, kind: "fixed_monthly", months: [4, 10], dayOfMonth: 1 };
    const result = computeNextDue(rule, completion("2026-04-01"), clock.now(), TZ);
    expect(result?.dueDate).toBe("2027-04-01");
  });
});
