import { requireSessionPage } from "@/server/auth/session";
import { PageScroll, PageHeader } from "@/ui/shell";
import { NotificationsPageContent } from "@/features/notifications/Notifications";
export const metadata = { title: "Notifications" };
export default async function NotificationsPage() {
  await requireSessionPage("/notifications");
  return <PageScroll><PageHeader title="Notifications" description="Household alerts and problems that need attention." /><NotificationsPageContent /></PageScroll>;
}
