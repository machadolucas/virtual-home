/**
 * "Was this run there on that date?" — the pure predicate behind the workspace's renovation-date
 * filter (`layer.renovationDate`).
 *
 * The filter answers a question about the *past*, so it cannot be a lifecycle test alone:
 *
 *  - with no date set the workspace shows the house as it is **plus what is planned**: installed
 *    and planned runs are drawn, removed ones are not;
 *  - with a date set it shows the house as it was on that date: a run installed later is not there
 *    yet, a run removed earlier is gone, and a plan only appears once its own installation date
 *    has been reached.
 *
 * Dates are household calendar dates (`YYYY-MM-DD`), which compare correctly as strings — so this
 * module needs no clock and no time zone (CLAUDE.md rule 4 applies to instants, not to these).
 *
 * Missing dates are the interesting case, and the rule is deliberately asymmetric:
 *
 *  - an **installed** run with no `installedAt` stays visible. It exists now; we have no evidence
 *    it postdates the viewed date, and hiding it would invent a fact.
 *  - a **removed** run with no `removedAt` is hidden as soon as a date filter is on. We know it is
 *    gone and nothing tells us when, so we cannot claim it was there on any particular day.
 *  - a **planned** run with no `installedAt` is hidden as soon as a date filter is on, for the
 *    same reason: a plan with no date was never in place on a specific day.
 */
import type { RouteLifecycle } from "@/house/model/types";

/** The three fields the predicate reads; `Route` and a database row both satisfy it. */
export interface DatedRun {
  lifecycle: RouteLifecycle;
  /** LocalDate `YYYY-MM-DD`, or absent when unrecorded. */
  installedAt?: string | null;
  removedAt?: string | null;
}

/** `YYYY-MM-DD`, the only shape the comparisons below are valid for. */
export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const on = (value: string | null | undefined): string | null =>
  typeof value === "string" && LOCAL_DATE_RE.test(value) ? value : null;

/**
 * Whether a run should be drawn when the filter is set to `asOf` (`null` = no filter: now, plus
 * plans).
 *
 * Boundary days count as present: a run installed on the viewed day is drawn, and so is one
 * removed on it — part of that day it was there, and the alternative flickers a run out of
 * existence a day early.
 */
export function isRunVisibleOn(run: DatedRun, asOf: string | null): boolean {
  const installedAt = on(run.installedAt);
  const removedAt = on(run.removedAt);

  if (asOf === null || !LOCAL_DATE_RE.test(asOf)) {
    // No filter: the current house plus what is planned for it.
    return run.lifecycle !== "removed";
  }

  // Not installed yet at the viewed date, whatever the lifecycle says today.
  if (installedAt !== null && installedAt > asOf) return false;

  switch (run.lifecycle) {
    case "installed":
      return true;
    case "planned":
      // Only a dated plan can be "in place" on a specific day.
      return installedAt !== null;
    case "removed":
      // Unknown removal date: we cannot claim it was there on this day.
      return removedAt !== null && removedAt >= asOf;
  }
}

/**
 * The words that go with the style. A dash pattern says "uncertain"; this says why the run is (or
 * is not) on screen, which is the part a screenshot of the 3D view cannot carry.
 */
export function runVisibilityReason(run: DatedRun, asOf: string | null): string {
  const visible = isRunVisibleOn(run, asOf);
  if (asOf === null) {
    if (run.lifecycle === "removed") return "Removed — hidden until you set a renovation date.";
    if (run.lifecycle === "planned") return "Planned — drawn, but not installed.";
    return "Installed — drawn as the house is now.";
  }
  if (visible) return `Present on ${asOf}.`;
  const installedAt = on(run.installedAt);
  const removedAt = on(run.removedAt);
  if (installedAt !== null && installedAt > asOf) return `Not installed until ${installedAt}.`;
  if (run.lifecycle === "removed")
    return removedAt === null
      ? "Removed on an unrecorded date, so it cannot be placed on a timeline."
      : `Removed on ${removedAt}.`;
  return "Planned with no installation date, so it was not in place on any particular day.";
}
