import "server-only";
import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { user } from "@/db/schema";
import { loadEnv } from "@/env";
import { log } from "@/server/log";

export interface LoginHint {
  username: string;
  name: string;
  displayColor: string | null;
}

/** Two accounts on a LAN app; a third would mean something went wrong. */
const MAX_HINTS = 4;

/**
 * The household members offered as avatar buttons on the login page.
 *
 * This is deliberate user enumeration, gated by `VH_SHOW_ACCOUNT_HINTS`: with
 * exactly two accounts on a private hostname, hiding the names buys nothing
 * and costs a `marja` typed on an iPhone keyboard every single day
 * (docs/design-notes/auth-security-operations.md §3.7).
 *
 * Called from an unauthenticated page, so it must never fail the render: a
 * missing table (fresh checkout, migrations not run) or any other read error
 * yields an empty list and the plain username field.
 */
export async function listLoginHints(): Promise<LoginHint[]> {
  if (!loadEnv().VH_SHOW_ACCOUNT_HINTS) return [];
  try {
    const rows = getDb()
      .db.select({
        username: user.username,
        displayUsername: user.displayUsername,
        name: user.name,
        displayColor: user.displayColor,
      })
      .from(user)
      .orderBy(asc(user.createdAt))
      .limit(MAX_HINTS)
      .all();

    return rows.flatMap((row) => {
      const username = row.username ?? row.displayUsername;
      if (!username) return [];
      return [
        {
          username,
          name: row.name.trim() || username,
          displayColor: row.displayColor,
        },
      ];
    });
  } catch (error) {
    // Includes "no such table: user" before the first migration.
    log.debug({ err: error }, "login hints unavailable");
    return [];
  }
}
