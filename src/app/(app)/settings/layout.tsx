import { requireSessionPage } from "@/server/auth/session";
import { PageScroll } from "@/ui/shell";
import { SettingsNav } from "./SettingsNav";

/**
 * Settings is a two-column area inside the ordinary (scrolling) page layout.
 * Each page renders its own `PageHeader`, so the heading names the page rather
 * than the section.
 */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  await requireSessionPage("/settings");

  return (
    <PageScroll>
      <div className="flex flex-col gap-5 md:flex-row md:gap-8">
        <SettingsNav className="md:w-48 md:shrink-0 lg:w-56" />
        <div className="flex min-w-0 flex-1 flex-col gap-5">{children}</div>
      </div>
    </PageScroll>
  );
}
