import { describe, expect, it } from "vitest";
import { assertBookingAssociation, bookingWindow } from "@/domain/booking";
import { instantOf, localTimeOf } from "@/domain/time";
const tz = "Europe/Helsinki";
describe("booking appointment windows", () => {
  it("keeps appointment wall times when rescheduling across daylight saving", () => {
    const window = bookingWindow({ date: "2026-10-26", previousStartMs: instantOf("2026-10-23", "09:30", tz), previousEndMs: instantOf("2026-10-23", "11:00", tz) }, tz);
    expect(window.scheduledStartMs).toBe(instantOf("2026-10-26", "09:30", tz));
    expect(localTimeOf(window.scheduledEndMs!, tz)).toBe("11:00");
  });
  it("clears both instants when no date is agreed", () => {
    expect(bookingWindow({ date: null, previousStartMs: 123, previousEndMs: 456 }, tz)).toEqual({ scheduledStartMs: null, scheduledEndMs: null });
  });
  it("rejects backwards times, end without start and times without date", () => {
    expect(() => bookingWindow({ date: "2026-09-13", startTime: "11:00", endTime: "09:00" }, tz)).toThrow("End time");
    expect(() => bookingWindow({ date: "2026-09-13", endTime: "09:00" }, tz)).toThrow("start time");
    expect(() => bookingWindow({ date: null, startTime: "09:00" }, tz)).toThrow("Choose a date");
  });
  it("refuses a different task or a replaced booking", () => {
    expect(() => assertBookingAssociation("task-a", "task-b", "booking", "booking")).toThrow();
    expect(() => assertBookingAssociation("task-a", "task-a", "new-booking", "booking")).toThrow();
    expect(() => assertBookingAssociation("task-a", "task-a", "booking", "booking")).not.toThrow();
  });
});
