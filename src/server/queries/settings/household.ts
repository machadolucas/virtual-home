import "server-only";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db/client";
import { HOUSEHOLD_SETTING_ID, householdSetting } from "@/db/schema";
import { NotFoundError } from "@/domain/errors";
import type { DomainContext } from "@/domain/inventory";
import { localDateOf, systemClock, type LocalDate } from "@/domain/time";
import { parseHouseBackground, type HouseBackground } from "@/house/model/background";
import { log } from "@/server/log";
import type { Session } from "@/server/auth/session";

export type HouseholdRow = typeof householdSetting.$inferSelect;

/**
 * The whole singleton row, for the settings form. `@/domain/occurrence`'s `loadHousehold` returns
 * a curated subset for the scheduler; the settings page needs every column it is allowed to edit,
 * including the ones the scheduler does not read.
 */
export function readHouseholdRow(tx: Db): HouseholdRow {
  const row = tx
    .select()
    .from(householdSetting)
    .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
    .get();
  if (!row) throw new NotFoundError("household_setting", HOUSEHOLD_SETTING_ID);
  return row;
}

/**
 * The 3D view's background.
 *
 * NULL means "follow the theme". So does a value the schema no longer accepts — a hand-edited or
 * half-written row must not break the House page, and the theme is always a correct answer. It is
 * logged once per process so it is still visible in the log rather than silently swallowed.
 */
export function readHouseBackground(tx: Db): HouseBackground {
  const row = readHouseholdRow(tx);
  const { background, malformed } = parseHouseBackground(row.houseBackgroundJson);
  if (malformed && !warnedAboutBackground) {
    warnedAboutBackground = true;
    log.warn(
      { value: row.houseBackgroundJson },
      "household_setting.house_background_json is not a valid background; following the theme",
    );
  }
  return background;
}

/** One warning per process, not per render: this is a stuck value, not an event. */
let warnedAboutBackground = false;

/** The household time zone, without pulling in the rest of the row. */
export function householdTimezone(tx: Db): string {
  return readHouseholdRow(tx).timezone;
}

/**
 * The `DomainContext` every inventory/asset write needs, built from the request's session.
 *
 * `actorKind` is always `'user'` here: these modules are only ever reached from a server action or
 * a route handler that already required a session. The worker builds its own context.
 */
export function userContext(session: Session, tx: Db): DomainContext {
  return {
    clock: systemClock,
    tz: householdTimezone(tx),
    actorUserId: session.user.id,
    actorKind: "user",
  };
}

/** Today as a household-local date. Never `new Date().toISOString().slice(0,10)`. */
export function householdToday(tx: Db, nowMs = Date.now()): LocalDate {
  return localDateOf(nowMs, householdTimezone(tx));
}

export interface PageContext {
  db: Db;
  household: HouseholdRow;
  today: LocalDate;
  /**
   * The instant this render started.
   *
   * Read once here rather than at each call site: a server component that calls `Date.now()` in
   * its body is an impure render (the lint rule that catches this is right — two reads inside one
   * render can disagree), and every "is this reading stale" comparison on the page should be
   * against the same instant anyway.
   */
  nowMs: number;
}

/** Convenience for pages: one read-only handle plus the household context and one clock read. */
export function pageContext(): PageContext {
  const { db } = getDb();
  const household = readHouseholdRow(db);
  const nowMs = Date.now();
  return { db, household, today: localDateOf(nowMs, household.timezone), nowMs };
}
