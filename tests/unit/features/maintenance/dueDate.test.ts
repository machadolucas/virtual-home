/**
 * Due-date wording. These strings are the ones the household reads every day, and two of them
 * carry a rule rather than a preference:
 *
 *  - an approximate anchor must never produce an exact overdue count (§2.4);
 *  - `blocked` wins over `overdue` for the glyph, so a waiting task explains itself instead of
 *    just looking late.
 */
import { describe, expect, it } from "vitest";
import {
  dayOffset,
  describeDue,
  describePast,
  describeWindow,
  formatDate,
  formatDateShort,
  formatMinutes,
  occurrenceStatusKind,
} from "@/features/maintenance/dueDate";

const TODAY = "2026-09-08";

describe("formatDate", () => {
  it("uses one unambiguous format, not a locale default", () => {
    expect(formatDate("2026-09-08")).toBe("8 Sep 2026");
    expect(formatDate("2027-01-31")).toBe("31 Jan 2027");
  });

  it("drops the year only when it is the current one", () => {
    expect(formatDateShort("2026-09-20", TODAY)).toBe("20 Sep");
    expect(formatDateShort("2027-05-01", TODAY)).toBe("1 May 2027");
  });
});

describe("dayOffset", () => {
  it("is signed: negative in the past", () => {
    expect(dayOffset("2026-09-08", TODAY)).toBe(0);
    expect(dayOffset("2026-09-09", TODAY)).toBe(1);
    expect(dayOffset("2026-09-01", TODAY)).toBe(-7);
  });
});

describe("describeDue", () => {
  it("names today and tomorrow", () => {
    expect(describeDue("2026-09-08", TODAY)).toBe("Due today");
    expect(describeDue("2026-09-09", TODAY)).toBe("Due tomorrow");
  });

  it("counts days inside a month and falls back to the date beyond it", () => {
    expect(describeDue("2026-09-20", TODAY)).toBe("Due in 12 days");
    expect(describeDue("2026-11-15", TODAY)).toBe("Due 15 Nov 2026");
  });

  it("counts days overdue, singular and plural", () => {
    expect(describeDue("2026-09-07", TODAY)).toBe("Overdue by 1 day");
    expect(describeDue("2026-09-01", TODAY)).toBe("Overdue by 7 days");
  });

  it("rounds to months once being late stops being countable in days", () => {
    expect(describeDue("2026-06-08", TODAY)).toBe("Overdue by about 3 months");
  });

  it("never gives an exact overdue count for an approximate anchor", () => {
    // §2.4: the 47 in "overdue by 47 days" would not be a fact when the anchor was
    // "sometime in spring 2024".
    expect(describeDue("2026-07-23", TODAY, { approximate: true })).toBe("Estimated overdue");
    // Not overdue yet? Then the approximation changes nothing.
    expect(describeDue("2026-09-20", TODAY, { approximate: true })).toBe("Due in 12 days");
  });
});

describe("describePast", () => {
  it("reads as history, not as a schedule", () => {
    expect(describePast("2026-09-08", TODAY)).toBe("Today");
    expect(describePast("2026-09-07", TODAY)).toBe("Yesterday");
    expect(describePast("2026-08-29", TODAY)).toBe("10 days ago");
    expect(describePast("2026-03-08", TODAY)).toBe("about 6 months ago");
    expect(describePast("2023-01-04", TODAY)).toBe("4 Jan 2023");
  });
});

describe("occurrenceStatusKind", () => {
  const base = { status: "due" as const, blockedReason: null, serviceBookingId: null };

  it("marks a passed due date overdue", () => {
    expect(occurrenceStatusKind({ ...base, dueDate: "2026-09-07" }, TODAY)).toBe("overdue");
  });

  it("treats today as due, not overdue", () => {
    expect(occurrenceStatusKind({ ...base, dueDate: TODAY }, TODAY)).toBe("due");
  });

  it("lets blocked win over overdue, so the row can say why", () => {
    expect(
      occurrenceStatusKind(
        { ...base, dueDate: "2026-08-01", blockedReason: "waiting for filters" },
        TODAY,
      ),
    ).toBe("blocked");
  });

  it("treats a booking as blocked — a booking is not a completion", () => {
    expect(
      occurrenceStatusKind({ ...base, dueDate: "2026-08-01", serviceBookingId: "b1" }, TODAY),
    ).toBe("blocked");
  });

  it("reports a skipped task as unknown rather than ok", () => {
    // "We closed it without doing it" must not look like "nothing is due".
    expect(
      occurrenceStatusKind({ ...base, status: "skipped", dueDate: "2026-08-01" }, TODAY),
    ).toBe("unknown");
    expect(
      occurrenceStatusKind({ ...base, status: "completed", dueDate: "2026-08-01" }, TODAY),
    ).toBe("ok");
  });
});

describe("describeWindow", () => {
  it("returns null when the occurrence has no window", () => {
    expect(describeWindow(null, null, TODAY)).toBeNull();
    expect(describeWindow("2026-05-01", null, TODAY)).toBeNull();
  });

  it("says when a window has closed", () => {
    expect(describeWindow("2026-05-01", "2026-06-30", TODAY)).toEqual({
      label: "1 May 2026 – 30 Jun 2026",
      closed: true,
    });
    expect(describeWindow("2026-09-01", "2026-10-31", TODAY)?.closed).toBe(false);
  });
});

describe("formatMinutes", () => {
  it("never invents a zero", () => {
    expect(formatMinutes(null)).toBeNull();
    expect(formatMinutes(undefined)).toBeNull();
  });

  it("reads as a person would say it", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(135)).toBe("2 h 15 min");
  });
});
