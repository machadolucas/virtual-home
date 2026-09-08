"use client";

import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Badge, Button } from "@/ui";
import { formatAge } from "@/features/settings/format";
import { useAction } from "@/features/settings/actionClient";
import { acknowledgeAlert } from "@/server/actions/settings/household";

export interface AlertView {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  body: string | null;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  seenCount: number;
  acknowledgedAtMs: number | null;
  acknowledgedByName: string | null;
}

/**
 * In-app alerts, with acknowledgement.
 *
 * Acknowledging means "I have seen this", not "this is fixed". `resolved_at_ms` stays null, so the
 * alert keeps deduplicating and the worker will not raise a second copy — and the alert only
 * disappears when the condition that caused it goes away. A human ticking a box does not make a
 * battery full.
 */
export function AlertsPanel({ alerts, nowMs }: { alerts: readonly AlertView[]; nowMs: number }) {
  if (alerts.length === 0) {
    return (
      <p className="max-w-prose text-sm leading-6 text-ink-2">
        Nothing unresolved. An alert appears here when stock goes negative, a Home Assistant link
        breaks, a battery reading goes stale, a notification device disappears, or a model import
        needs a decision.
      </p>
    );
  }

  return (
    <ul className="flex list-none flex-col divide-y divide-line">
      {alerts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} nowMs={nowMs} />
      ))}
    </ul>
  );
}

function AlertRow({ alert, nowMs }: { alert: AlertView; nowMs: number }) {
  const router = useRouter();
  const call = useAction(acknowledgeAlert, {
    successTitle: "Acknowledged",
    onSuccess: () => router.refresh(),
  });

  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            alert.severity === "error"
              ? "overdue"
              : alert.severity === "warning"
                ? "due"
                : "neutral"
          }
          size="sm"
        >
          {alert.severity}
        </Badge>
        <span className="text-sm font-semibold text-ink">{alert.title}</span>
        <span className="font-mono text-xs text-ink-3">{alert.kind}</span>
        {alert.seenCount > 1 ? (
          <span className="vh-tnum text-xs text-ink-3">seen {alert.seenCount} times</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {alert.acknowledgedAtMs === null ? (
            <Button
              variant="secondary"
              size="sm"
              loading={call.pending}
              icon={<Check aria-hidden="true" />}
              onClick={() => call.run({ alertId: alert.id })}
            >
              I have seen this
            </Button>
          ) : (
            <span className="text-xs text-ink-3">
              seen by {alert.acknowledgedByName ?? "somebody"}{" "}
              {formatAge(alert.acknowledgedAtMs, nowMs)}
            </span>
          )}
        </span>
      </div>
      {alert.body === null ? null : (
        <p className="max-w-prose text-sm leading-6 text-ink-2">{alert.body}</p>
      )}
      <p className="vh-tnum text-xs text-ink-3">
        First {formatAge(alert.firstSeenAtMs, nowMs)}, most recently{" "}
        {formatAge(alert.lastSeenAtMs, nowMs)}.
      </p>
    </li>
  );
}
