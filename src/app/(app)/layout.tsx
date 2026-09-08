import { getDb } from "@/db/client";
import { nowMs } from "@/db/ids";
import { requireSessionPage } from "@/server/auth/session";
import { loadMaintenanceHealth } from "@/server/queries/maintenance/status";
import { AppShell } from "@/ui/shell";

/**
 * The authorization boundary for every page in this group (CLAUDE.md rule 2):
 * `requireSessionPage` redirects to `/login?next=…` when there is no session.
 * `src/proxy.ts` only guesses from cookie presence and is not relied on here.
 *
 * `next` is `/today` rather than the current path because a layout cannot see
 * the pathname; each page that needs a precise return target calls
 * `requireSessionPage` itself with its own path.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireSessionPage("/today");

  // Better Auth's inferred user type varies with the enabled plugins, so read
  // the display fields defensively instead of asserting a shape.
  const name =
    readString(session.user, "name") ??
    readString(session.user, "username") ??
    "Household member";

  // The Today banner's own loader, whose `connection` field is `connectionStateOf` — the one
  // mapping `/settings/home-assistant` also renders. So the header pill, the banner and the
  // settings page cannot disagree about the same `integration_status` row.
  const { connection } = loadMaintenanceHealth(getDb().db, nowMs());

  return (
    <AppShell
      user={{
        name,
        username: readString(session.user, "username"),
        displayColor: readString(session.user, "displayColor"),
      }}
      connection={connection}
    >
      {children}
    </AppShell>
  );
}

function readString(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
