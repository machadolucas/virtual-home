/**
 * The History row types, in a module the browser is allowed to import.
 *
 * `src/server/queries/maintenance/history.ts` is `server-only`, so the filter control cannot take
 * this list from there — a value import would drag better-sqlite3 into the client bundle and fail
 * the build. The query module imports these instead, which keeps one definition rather than two.
 */
export const HISTORY_TYPES = ["completions", "voided", "skipped", "cancelled", "bookings"] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

/** What the History page shows when nothing is asked for: what was done, what was not, and visits. */
export const DEFAULT_HISTORY_TYPES: HistoryType[] = ["completions", "skipped", "bookings"];

export const HISTORY_TYPE_LABEL: Record<HistoryType, string> = {
  completions: "Completions",
  voided: "Voided completions",
  skipped: "Skipped",
  cancelled: "Cancelled",
  bookings: "Bookings",
};
