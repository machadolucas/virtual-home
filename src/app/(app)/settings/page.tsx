import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { cn, focusRing, Panel } from "@/ui";
import { PageHeader, SETTINGS_NAV } from "@/ui/shell";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsIndexPage() {
  await requireSessionPage("/settings");

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Everything that configures this installation. There are no roles: both household members can change all of it, and every change is attributed."
      />

      <Panel flush>
        <ul className="flex list-none flex-col">
          {SETTINGS_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.href} className="border-b border-line last:border-b-0">
                <Link
                  href={item.href}
                  className={cn(
                    "flex min-h-14 items-center gap-3 px-4 py-3 transition-colors duration-100",
                    "hover:bg-surface-2",
                    focusRing,
                  )}
                >
                  <span
                    aria-hidden="true"
                    className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-ink-3 [&_svg]:size-4"
                  >
                    <Icon />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-semibold text-ink">{item.label}</span>
                    <span className="text-xs leading-5 text-ink-3">{item.blurb}</span>
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className="ml-auto size-4 shrink-0 text-ink-3"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </Panel>

      <p className="text-xs leading-5 text-ink-3">
        Password recovery, user creation and session revocation from outside the browser all live
        in the server-side CLI (<code className="font-mono">pnpm vh-admin</code>), which needs SSH
        access to the machine. That is deliberate: there is no self-service reset, because there is
        no mail transport to send one through.
      </p>
    </>
  );
}
