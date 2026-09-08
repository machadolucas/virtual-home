import { redirect } from "next/navigation";

/**
 * There is no landing page: the app opens on what needs doing today. Kept as a
 * redirect rather than a rewrite so the address bar shows the real section and
 * bookmarks/HA notification links resolve to the same URL as the navigation.
 */
export default function RootPage() {
  redirect("/today");
}
