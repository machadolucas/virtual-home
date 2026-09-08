import { AlertTriangle, Info } from "lucide-react";
import Link from "next/link";
import { ConnectionPill, Panel, buttonClasses } from "@/ui";
import { formatInstant } from "@/features/maintenance/dueDate";
import type { MaintenanceHealth } from "@/server/queries/maintenance/status";

/**
 * The banner that says whether the machinery behind this page is running.
 *
 * It is deliberately **not** green-unless-proven: `unknown` renders as unknown, because "we have no
 * status row" is not "everything is fine" (`docs/ux.md` §5, CLAUDE.md rule 8). When everything is
 * healthy the banner collapses to a single quiet line, so a working system does not shout.
 */
export function HealthBanner({ health, tz }: { health: MaintenanceHealth; tz: string }) {
  if (health.kind === "ok") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
        <ConnectionPill state={health.connection} />
        <span>
          {health.detail}
          {health.lastTickFinishedMs === null
            ? " The reminder tick has not run yet."
            : ` Last reminder check ${formatInstant(health.lastTickFinishedMs, tz)}.`}
        </span>
      </p>
    );
  }

  const severe = health.kind === "worker_down" || health.kind === "ha_auth_failed";

  return (
    <Panel
      className={severe ? "border-overdue/45" : "border-due/45"}
      title={
        <span className="flex items-center gap-2">
          {severe ? (
            <AlertTriangle aria-hidden="true" className="size-4 text-overdue" />
          ) : (
            <Info aria-hidden="true" className="size-4 text-due" />
          )}
          {health.title}
        </span>
      }
      actions={<ConnectionPill state={health.connection} />}
    >
      <p className="text-sm text-ink-2">{health.detail}</p>
      {health.consequence !== null ? (
        <p className="mt-2 text-sm text-ink">{health.consequence}</p>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-3 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt>Worker heartbeat</dt>
          <dd className="vh-tnum text-ink-2">
            {health.heartbeatAtMs === null ? "never" : formatInstant(health.heartbeatAtMs, tz)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt>Home Assistant last OK</dt>
          <dd className="vh-tnum text-ink-2">
            {health.lastOkAtMs === null ? "never" : formatInstant(health.lastOkAtMs, tz)}
          </dd>
        </div>
        {health.lastError !== null ? (
          <div className="flex gap-2 sm:col-span-2">
            <dt>Last error</dt>
            <dd className="font-mono text-ink-2">{health.lastError}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3">
        <Link href="/settings/system" className={buttonClasses({ variant: "secondary", size: "sm" })}>
          Open system settings
        </Link>
      </div>
    </Panel>
  );
}
