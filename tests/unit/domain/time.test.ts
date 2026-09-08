/**
 * §9 P0 items 18–25 — DST and instant computation.
 *
 * Helsinki is the household zone: EET (+02) in winter, EEST (+03) in summer, DST starting
 * 2027-03-28 at 03:00 local and ending 2027-10-31 at 04:00 local.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/domain/errors";
import {
  addDaysLocal,
  addMonthsClamped,
  compareLocalDate,
  daysBetweenLocal,
  instantOf,
  isValidLocalDate,
  isWithinLocalTimeWindow,
  isoWeekdayOf,
  lastDayOfMonth,
  localDateOf,
  localDateTimeOf,
  localTimeOf,
  monthsBetweenLocal,
  systemClock,
} from "@/domain/time";
import { fakeClock } from "../../helpers/clock";

const TZ = "Europe/Helsinki";
const DELIVERY = "09:00";

describe("instantOf", () => {
  // 18
  it("maps 09:00 local to 07:00Z in EET", () => {
    expect(instantOf("2027-03-21", DELIVERY, TZ)).toBe(Date.parse("2027-03-21T07:00:00Z"));
  });

  // 19
  it("preserves the wall clock across spring forward", () => {
    expect(instantOf("2027-03-28", DELIVERY, TZ)).toBe(Date.parse("2027-03-28T06:00:00Z"));
  });

  // 20
  it("preserves the wall clock across fall back", () => {
    expect(instantOf("2027-10-31", DELIVERY, TZ)).toBe(Date.parse("2027-10-31T07:00:00Z"));
  });

  // 23
  it("resolves a nonexistent local time to the first valid instant (03:30 -> 04:00)", () => {
    const at = instantOf("2027-03-28", "03:30", TZ);
    expect(localTimeOf(at, TZ)).toBe("04:00");
    expect(localDateOf(at, TZ)).toBe("2027-03-28");
    // 04:00 EEST == 01:00Z, the transition instant itself.
    expect(at).toBe(Date.parse("2027-03-28T01:00:00Z"));
  });

  // 24
  it("resolves an ambiguous local time to the earlier (DST) occurrence", () => {
    const at = instantOf("2027-10-31", "03:30", TZ);
    expect(at).toBe(Date.parse("2027-10-31T00:30:00Z")); // 03:30 EEST, not 03:30 EET
    expect(localTimeOf(at, TZ)).toBe("03:30");
    // The later occurrence exists and is one hour after the one we return.
    expect(localTimeOf(at + 3_600_000, TZ)).toBe("03:30");
  });

  it("rejects malformed dates and times", () => {
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        return err instanceof ValidationError ? err.code : "not-a-ValidationError";
      }
      return "no-throw";
    };
    expect(codeOf(() => instantOf("2027-02-30", DELIVERY, TZ))).toBe("invalid_local_date");
    expect(codeOf(() => instantOf("2027-03-21", "9:00", TZ))).toBe("invalid_local_time");
    expect(codeOf(() => instantOf("2027-03-21", "24:00", TZ))).toBe("invalid_local_time");
  });

  it("works in a zone without DST and in a half-hour zone", () => {
    expect(instantOf("2027-06-01", "09:00", "UTC")).toBe(Date.parse("2027-06-01T09:00:00Z"));
    expect(instantOf("2027-06-01", "09:00", "Asia/Kolkata")).toBe(
      Date.parse("2027-06-01T03:30:00Z"),
    );
  });
});

describe("weekly slot series", () => {
  const slot = (anchor: string, n: number): number =>
    instantOf(addDaysLocal(anchor, 7 * n), DELIVERY, TZ);

  // 21
  it("keeps 09:00 local across spring forward, with a 6 d 23 h gap", () => {
    const t0 = slot("2027-03-21", 0);
    const t1 = slot("2027-03-21", 1);
    const t2 = slot("2027-03-21", 2);
    expect(t0).toBe(Date.parse("2027-03-21T07:00:00Z"));
    expect(t1).toBe(Date.parse("2027-03-28T06:00:00Z"));
    expect(t2).toBe(Date.parse("2027-04-04T06:00:00Z"));
    expect(t1 - t0).toBe(6 * 86_400_000 + 23 * 3_600_000);
    expect(t2 - t1).toBe(7 * 86_400_000);
    for (const t of [t0, t1, t2]) expect(localTimeOf(t, TZ)).toBe(DELIVERY);
  });

  // 22
  it("keeps 09:00 local across fall back, with a 7 d 1 h gap", () => {
    const t0 = slot("2027-10-24", 0);
    const t1 = slot("2027-10-24", 1);
    const t2 = slot("2027-10-24", 2);
    expect(t0).toBe(Date.parse("2027-10-24T06:00:00Z"));
    expect(t1).toBe(Date.parse("2027-10-31T07:00:00Z"));
    expect(t2).toBe(Date.parse("2027-11-07T07:00:00Z"));
    expect(t1 - t0).toBe(7 * 86_400_000 + 3_600_000);
    expect(t2 - t1).toBe(7 * 86_400_000);
    for (const t of [t0, t1, t2]) expect(localTimeOf(t, TZ)).toBe(DELIVERY);
  });

  // 25 — property test: never `+ 7 * 86_400_000`.
  it("delivers at exactly 09:00 local for 400 consecutive due dates", () => {
    let date = "2026-12-15";
    for (let n = 0; n < 400; n++) {
      const at = instantOf(date, DELIVERY, TZ);
      expect(localTimeOf(at, TZ)).toBe(DELIVERY);
      expect(localDateOf(at, TZ)).toBe(date);
      date = addDaysLocal(date, 1);
    }
  });

  it("naive millisecond addition would have drifted (documents why we recompute)", () => {
    const t0 = instantOf("2027-03-21", DELIVERY, TZ);
    const naive = t0 + 7 * 86_400_000;
    expect(localTimeOf(naive, TZ)).toBe("10:00");
    expect(localTimeOf(instantOf("2027-03-28", DELIVERY, TZ), TZ)).toBe("09:00");
  });
});

describe("local date arithmetic", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDaysLocal("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDaysLocal("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysLocal("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("clamps the day of month when adding months", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsClamped("2026-03-15", -3)).toBe("2025-12-15");
    expect(addMonthsClamped("2026-01-31", 12)).toBe("2027-01-31");
  });

  it("compares, measures and validates", () => {
    expect(compareLocalDate("2026-01-01", "2026-01-02")).toBe(-1);
    expect(compareLocalDate("2026-01-02", "2026-01-02")).toBe(0);
    expect(compareLocalDate("2026-01-03", "2026-01-02")).toBe(1);
    expect(daysBetweenLocal("2026-01-31", "2026-03-01")).toBe(29);
    expect(monthsBetweenLocal("2026-01-31", "2027-04-01")).toBe(15);
    expect(lastDayOfMonth(2028, 2)).toBe(29);
    expect(lastDayOfMonth(2026, 2)).toBe(28);
    expect(isValidLocalDate("2026-02-29")).toBe(false);
    expect(isValidLocalDate("2028-02-29")).toBe(true);
    expect(isValidLocalDate("2028-2-29")).toBe(false);
    expect(isoWeekdayOf("2027-01-02")).toBe(6); // Saturday
    expect(isoWeekdayOf("2027-01-03")).toBe(7); // Sunday
  });

  it("day arithmetic is unaffected by the DST day being 23 hours long", () => {
    expect(addDaysLocal("2027-03-27", 1)).toBe("2027-03-28");
    expect(daysBetweenLocal("2027-03-21", "2027-04-04")).toBe(14);
  });
});

describe("wall-clock readers and the send window", () => {
  it("reads local date, time and the combined key", () => {
    const at = Date.parse("2027-03-28T06:00:00Z");
    expect(localDateOf(at, TZ)).toBe("2027-03-28");
    expect(localTimeOf(at, TZ)).toBe("09:00");
    expect(localDateTimeOf(at, TZ)).toBe("2027-03-28T09:00");
  });

  it("handles a window that wraps midnight", () => {
    expect(isWithinLocalTimeWindow("09:00", "08:00", "21:30")).toBe(true);
    expect(isWithinLocalTimeWindow("03:00", "08:00", "21:30")).toBe(false);
    expect(isWithinLocalTimeWindow("23:30", "22:00", "06:00")).toBe(true);
    expect(isWithinLocalTimeWindow("05:00", "22:00", "06:00")).toBe(true);
    expect(isWithinLocalTimeWindow("12:00", "22:00", "06:00")).toBe(false);
  });
});

describe("clocks", () => {
  it("the fake clock steps, jumps and resolves local wall times", () => {
    const clock = fakeClock("2027-01-04T07:00:00Z");
    expect(clock.now()).toBe(Date.parse("2027-01-04T07:00:00Z"));
    clock.advance(86_400_000);
    expect(localDateOf(clock.now(), TZ)).toBe("2027-01-05");
    clock.set("2027-02-03T10:00:00Z");
    expect(localTimeOf(clock.now(), TZ)).toBe("12:00");
    clock.advanceToLocal("2027-03-28T09:00", TZ);
    expect(clock.now()).toBe(Date.parse("2027-03-28T06:00:00Z"));
  });

  it("the system clock reads Date.now", () => {
    const before = Date.now();
    const at = systemClock.now();
    expect(at).toBeGreaterThanOrEqual(before);
  });
});
