import "server-only";
import { getDb, type Db, type DbHandle } from "@/db/client";
import { user } from "@/db/schema/auth";
import { loadHousehold, type DomainCtx, type HouseholdSettings } from "@/domain/occurrence";
import { localDateOf, systemClock, type LocalDate } from "@/domain/time";
import { asc } from "drizzle-orm";

/**
 * The context every maintenance query and action needs: the database handle, the household
 * settings (time zone above all), and "today" as a household-local date.
 *
 * One place, because getting the time zone from anywhere else is how a due date ends up a day out.
 */
export interface MaintenanceContext {
  handle: DbHandle;
  db: Db;
  settings: HouseholdSettings;
  tz: string;
  today: LocalDate;
  nowMs: number;
  /** The domain context for a web request made by `actorUserId`. */
  ctx: DomainCtx;
}

export function maintenanceContext(actorUserId: string | null): MaintenanceContext {
  const handle = getDb();
  const settings = loadHousehold(handle.db);
  const nowMs = systemClock.now();
  return {
    handle,
    db: handle.db,
    settings,
    tz: settings.timezone,
    today: localDateOf(nowMs, settings.timezone),
    nowMs,
    ctx: { clock: systemClock, tz: settings.timezone, actorUserId, actorKind: "user" },
  };
}

export interface HouseholdMember {
  id: string;
  name: string;
  username: string | null;
  displayColor: string | null;
}

/**
 * The household's members, for assignee pickers and avatars. Two accounts, no roles — so this is a
 * plain list and never a permission lookup.
 *
 * `displayColor` is read defensively: Better Auth's `user` table carries the column through an
 * `additionalFields` declaration, and a null there must not break the page.
 */
export function loadMembers(db: Db): HouseholdMember[] {
  return db
    .select({
      id: user.id,
      name: user.name,
      username: user.username,
      displayColor: user.displayColor,
    })
    .from(user)
    .orderBy(asc(user.name))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username ?? null,
      displayColor: row.displayColor ?? null,
    }));
}

/** The member who is not `viewerId`, when the household has exactly the usual two. */
export function partnerOf(members: readonly HouseholdMember[], viewerId: string): HouseholdMember | null {
  const others = members.filter((member) => member.id !== viewerId);
  return others.length === 1 ? others[0]! : null;
}

export function memberName(members: readonly HouseholdMember[], id: string | null): string | null {
  if (id === null) return null;
  return members.find((member) => member.id === id)?.name ?? null;
}
