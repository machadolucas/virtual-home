import { requireSessionPage } from "@/server/auth/session";
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

  return (
    <AppShell
      user={{
        name,
        username: readString(session.user, "username"),
        displayColor: readString(session.user, "displayColor"),
      }}
      connection="unknown"
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
