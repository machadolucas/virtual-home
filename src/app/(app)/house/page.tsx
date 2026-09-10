import type { Metadata } from "next";
import { HouseWorkspace } from "@/house";
import { requireSessionPage } from "@/server/auth/session";
import { pageContext, readHouseBackground } from "@/server/queries/settings/household";
import { getCurrentPackage } from "@/server/house-model/package";
import { readDaylightHaEntities } from "@/server/queries/ha/daylight";
import { Workspace } from "@/ui/shell";

export const metadata: Metadata = { title: "House" };

/**
 * The 3D workspace's page. A server component: it establishes the session (CLAUDE.md rule 2) and
 * resolves which package is installed, then hands the client shell just the `modelId`. Every byte
 * of the package itself travels through the authenticated `/api/house-model/...` handlers — never
 * from `public/`, and never inlined into the HTML.
 *
 * `Workspace` fills the shell's non-scrolling `<main>` exactly, so the canvas owns the viewport
 * and the page itself never scrolls.
 *
 * The 3D background travels with the `modelId` for one reason: it decides the very first pixel the
 * canvas host paints, and a default painted for one frame before the stored value arrives is a
 * visible flash on every navigation to this page.
 */
export default async function HousePage() {
  await requireSessionPage("/house");

  // A missing or unreadable package is a setup state the client renders, not an error page.
  const pkg = await getCurrentPackage().catch(() => null);
  const { db } = pageContext();
  const background = readHouseBackground(db);
  const daylightHaEntities = readDaylightHaEntities(db);

  return (
    <Workspace>
      <HouseWorkspace modelId={pkg?.modelId ?? null} background={background} daylightHaEntities={daylightHaEntities} />
    </Workspace>
  );
}
