/**
 * The renovation-date filter, as a pure predicate.
 *
 * These are the assertions that matter for honesty: a run that was taken out in 2019 must not be
 * drawn as if it were still there, a plan must not be drawn as an installation on a date it did not
 * exist, and an **unrecorded** date must never be filled in with a guess in either direction.
 */
import { describe, expect, it } from "vitest";
import { isRunVisibleOn, runVisibilityReason } from "@/features/projects/renovationDate";

describe("isRunVisibleOn — no date filter", () => {
  it("draws the house as it is, plus what is planned", () => {
    expect(isRunVisibleOn({ lifecycle: "installed" }, null)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "planned" }, null)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "removed", removedAt: "2019-05-01" }, null)).toBe(false);
  });

  it("ignores the dates entirely: they only matter against a filter", () => {
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: "2099-01-01" }, null)).toBe(true);
  });
});

describe("isRunVisibleOn — as of a date", () => {
  const asOf = "2020-06-15";

  it("hides a run installed after the viewed date", () => {
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: "2021-01-01" }, asOf)).toBe(false);
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: "2019-01-01" }, asOf)).toBe(true);
  });

  it("shows a removed run that was still there on the viewed date", () => {
    expect(
      isRunVisibleOn({ lifecycle: "removed", installedAt: "2010-01-01", removedAt: "2021-01-01" }, asOf),
    ).toBe(true);
    expect(
      isRunVisibleOn({ lifecycle: "removed", installedAt: "2010-01-01", removedAt: "2019-01-01" }, asOf),
    ).toBe(false);
  });

  it("counts the boundary days as present", () => {
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: asOf }, asOf)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "removed", removedAt: asOf }, asOf)).toBe(true);
  });

  it("shows a plan only once its own installation date has been reached", () => {
    expect(isRunVisibleOn({ lifecycle: "planned", installedAt: "2020-01-01" }, asOf)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "planned", installedAt: "2021-01-01" }, asOf)).toBe(false);
    expect(isRunVisibleOn({ lifecycle: "planned" }, asOf)).toBe(false);
  });
});

describe("isRunVisibleOn — missing dates are never guessed", () => {
  const asOf = "2020-06-15";

  it("keeps an installed run with no install date: it exists, and nothing says it is newer", () => {
    expect(isRunVisibleOn({ lifecycle: "installed" }, asOf)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: null }, asOf)).toBe(true);
  });

  it("hides a removed run with no removal date: it cannot be placed on a timeline", () => {
    expect(isRunVisibleOn({ lifecycle: "removed" }, asOf)).toBe(false);
    expect(isRunVisibleOn({ lifecycle: "removed", removedAt: null }, asOf)).toBe(false);
  });

  it("treats a malformed date as no date at all rather than comparing garbage", () => {
    expect(isRunVisibleOn({ lifecycle: "installed", installedAt: "yesterday" }, asOf)).toBe(true);
    expect(isRunVisibleOn({ lifecycle: "removed", removedAt: "05/2019" }, asOf)).toBe(false);
    // A malformed filter is no filter.
    expect(isRunVisibleOn({ lifecycle: "removed", removedAt: "2019-01-01" }, "soon")).toBe(false);
    expect(isRunVisibleOn({ lifecycle: "planned" }, "soon")).toBe(true);
  });
});

describe("runVisibilityReason", () => {
  it("says why a run is hidden, in words the 3D view cannot carry", () => {
    expect(runVisibilityReason({ lifecycle: "removed" }, null)).toContain("renovation date");
    expect(runVisibilityReason({ lifecycle: "planned" }, null)).toContain("not installed");
    expect(
      runVisibilityReason({ lifecycle: "installed", installedAt: "2021-01-01" }, "2020-06-15"),
    ).toContain("2021-01-01");
    expect(runVisibilityReason({ lifecycle: "removed" }, "2020-06-15")).toContain("unrecorded");
    expect(
      runVisibilityReason({ lifecycle: "installed", installedAt: "2010-01-01" }, "2020-06-15"),
    ).toContain("2020-06-15");
  });
});
