import type { Metadata } from "next";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, Panel, StatusBadge } from "@/ui";
import { PageHeader } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { readSystemHealth, type FileSize } from "@/server/queries/settings/system";
import { packageStatus } from "@/server/house-model/package";
import { formatAge, formatBytes, isoOf, memorySparkline } from "@/features/settings/format";
import type { MetricSample } from "@/features/settings/format";
import { loadEnv } from "@/env";
import { AlertsPanel } from "./AlertsPanel";

export const metadata: Metadata = { title: "System" };

/**
 * `/settings/system` — is the machine behind all of this healthy?
 *
 * Every figure here is measured or absent. There is no "healthy" derived from the absence of a
 * problem: the worker is alive if and only if its heartbeat is recent, and a missing `backup_run`
 * row renders as "no backup recorded", which *is* the alert rather than a blank.
 */
export default async function SystemSettingsPage() {
  await requireSessionPage("/settings/system");
  const { db, nowMs } = pageContext();
  const env = loadEnv();
  const health = readSystemHealth(db, nowMs);
  const model = await packageStatus();

  const notifyFailed = health.notifyStateCounts.failed + health.notifyStateCounts.abandoned;

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="System"
        description="Whether the machine behind all of this is healthy: the background worker, storage, backups, memory and anything that failed. Nothing here is a reassuring tick it cannot justify."
      />

      <Panel title="Background worker">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Detail
            term="Heartbeat"
            value={
              health.integration === null
                ? "Never"
                : (formatAge(health.integration.heartbeatAtMs, nowMs) ?? "Never")
            }
          >
            {health.integration === null
              ? "The worker has never written a status row, so it has not run against this database."
              : `Expected every ${Math.round(health.heartbeatPeriodMs / 1000)} s. More than three periods late counts as down.`}
          </Detail>
          <Detail term="State" value={health.workerAlive ? "Running" : "Not running"}>
            {health.workerAlive
              ? "The scheduler, the notification outbox and the Home Assistant socket all live in this process."
              : "Nothing is being scheduled or sent. Tasks still exist and the app still works; reminders simply do not go out."}
          </Detail>
          <Detail
            term="Home Assistant"
            value={health.integration === null ? "No report" : health.integration.state}
          >
            {health.workerAlive
              ? undefined
              : "This is the last thing the worker said before it stopped, not a live reading."}
          </Detail>
          <Detail
            term="Last registry sync"
            value={
              health.lastSyncRun === null
                ? "Never"
                : (formatAge(health.lastSyncRun.startedAtMs, nowMs) ?? "Never")
            }
          >
            {health.lastSyncRun === null
              ? undefined
              : `${health.lastSyncRun.status}: ${health.lastSyncRun.devicesSeen} devices, ${health.lastSyncRun.entitiesSeen} entities, ${health.lastSyncRun.renamesDetected} rename(s), ${health.lastSyncRun.removalsDetected} removal(s).`}
          </Detail>
        </dl>
        {health.lastSyncRun?.error == null ? null : (
          <p className="mt-3 break-words border-t border-line pt-3 font-mono text-xs leading-5 text-overdue">
            {health.lastSyncRun.error}
          </p>
        )}
      </Panel>

      <Panel title="Storage">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
          <Detail term="Database" value={sizeLabel(health.storage.dbBytes)}>
            {health.storage.dbPath}
          </Detail>
          <Detail term="Write-ahead log" value={sizeLabel(health.storage.walBytes)}>
            {health.storage.walBytes.kind === "unreadable"
              ? "The file is there but could not be measured, which is a permissions problem rather than an absent WAL."
              : "A WAL that keeps growing means checkpoints are not keeping up — worth knowing, and invisible any other way."}
          </Detail>
          <Detail
            term="Attachments"
            value={
              health.storage.attachmentsBytes === null
                ? "Cannot read"
                : formatBytes(health.storage.attachmentsBytes)
            }
          >
            Photos and manuals, on disk at mode 700 and served only through an authenticated route.
          </Detail>
        </dl>
      </Panel>

      <Panel title="Backups">
        {health.lastBackup === null ? (
          <p className="max-w-prose text-sm leading-6 text-ink-2">
            <strong className="font-semibold text-overdue">No backup has ever been recorded.</strong>{" "}
            That is not a gap in this page — it is the alert. The backup script writes a row every
            time it runs, so a missing row means it has never run against this database.
          </p>
        ) : (
          <>
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
              <Detail
                term="Last backup"
                value={formatAge(health.lastBackup.createdAtMs, nowMs) ?? "unknown"}
              >
                {isoOf(health.lastBackup.createdAtMs) ?? undefined}
              </Detail>
              <Detail term="Size" value={formatBytes(health.lastBackup.bytes)} />
              <Detail term="Outcome" value={health.lastBackup.ok ? "Succeeded" : "Failed"}>
                {health.lastBackup.error ?? undefined}
              </Detail>
              {/* Reported separately, and never in place of the run above: the most recent attempt
                  and the most recent success are two different facts, and letting the second stand
                  in for the first put a tick over newer failures. */}
              <Detail
                term="Last successful backup"
                value={
                  health.lastSuccessfulBackup === null
                    ? "None recorded"
                    : (formatAge(health.lastSuccessfulBackup.createdAtMs, nowMs) ?? "unknown")
                }
              >
                {health.lastSuccessfulBackup === null
                  ? "Every recorded run failed. There is no snapshot to restore from."
                  : health.lastSuccessfulBackup.id === health.lastBackup.id
                    ? "The most recent run is also the most recent success."
                    : `The most recent run did not succeed; this is the newest one that did (${isoOf(health.lastSuccessfulBackup.createdAtMs) ?? "date unknown"}).`}
              </Detail>
            </dl>
            <ul className="mt-4 flex list-none flex-col divide-y divide-line border-t border-line pt-2">
              {health.recentBackups.map((backup) => (
                <li
                  key={backup.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs"
                >
                  <Badge tone={backup.ok ? "ok" : "overdue"} size="sm">
                    {backup.ok ? "ok" : "failed"}
                  </Badge>
                  <span className="text-ink-2">{backup.label}</span>
                  <span className="vh-tnum text-ink-3">{formatBytes(backup.bytes)}</span>
                  <span className="vh-tnum ml-auto text-ink-3">
                    {formatAge(backup.createdAtMs, nowMs)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-5 text-ink-3">
              Retention in effect: {env.VH_BACKUP_RETAIN_DAILY} daily and{" "}
              {env.VH_BACKUP_RETAIN_WEEKLY} weekly, plus the pre-migration and pre-update snapshots,
              which are kept forever.
            </p>
          </>
        )}
      </Panel>

      <Panel
        title="Memory"
        subtitle="Resident set size over the last 24 hours, sampled by each process."
      >
        <div className="flex flex-col gap-5">
          <Sparkline
            label="Web process"
            samples={health.webMetrics}
            intervalMs={env.VH_METRICS_INTERVAL_MS}
          />
          <Sparkline
            label="Worker process"
            samples={health.workerMetrics}
            intervalMs={env.VH_METRICS_INTERVAL_MS}
          />
        </div>
        <p className="mt-3 max-w-prose text-xs leading-5 text-ink-3">
          The baseline is zero, not the minimum: a chart that starts at the minimum turns two per
          cent of noise into a mountain range. A sawtooth means restarts; a steady ramp over days
          means something is not being released.
        </p>
      </Panel>

      <Panel title="Notifications">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
          <Detail term="Waiting to send" value={String(health.notifyStateCounts.queued)} />
          <Detail term="Sent" value={String(health.notifyStateCounts.sent)}>
            We record that a send was attempted and accepted — never that it was delivered. No phone
            tells us the difference truthfully.
          </Detail>
          <Detail term="Failed or given up" value={String(notifyFailed)}>
            {notifyFailed === 0
              ? "Nothing has failed."
              : `The ${health.notifyFailures.length === 1 ? "one" : `most recent ${health.notifyFailures.length}`} below carry the error Home Assistant returned, and say whether the sender gave up.`}
          </Detail>
        </dl>
        {health.notifyFailures.length === 0 ? null : (
          <ul className="mt-4 flex list-none flex-col divide-y divide-line border-t border-line pt-2">
            {health.notifyFailures.map((failure) => (
              <li key={failure.id} className="flex flex-col gap-0.5 py-2">
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {/* The state is its own badge: "failed" is retryable, "abandoned" means the
                      sender stopped trying, and one badge for both hid that difference. */}
                  <Badge tone="overdue" size="sm">
                    {failure.state === "abandoned" ? "gave up" : "failed"}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    {failure.kind}
                  </Badge>
                  <span className="font-mono text-ink-2">{failure.notifyService}</span>
                  <span className="vh-tnum text-ink-3">
                    {failure.attemptCount} attempt(s)
                  </span>
                  <span className="vh-tnum ml-auto text-ink-3">
                    {formatAge(failure.createdAtMs, nowMs)}
                  </span>
                </span>
                {failure.lastError === null ? null : (
                  <span className="break-words font-mono text-xs leading-5 text-overdue">
                    {failure.lastError}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="House model">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Detail term="Model id" value={model.modelId ?? "none installed"} />
          <Detail term="Fingerprint" value={model.fingerprint ?? "—"}>
            {model.fingerprint === null
              ? "Without a package the house workspace has nothing to draw. Everything else works."
              : "The content hash of the installed package. Exports carry it, so a dataset stays interpretable."}
          </Detail>
          <Detail
            term="Geometry files present"
            value={
              model.assets.length === 0
                ? "—"
                : `${model.assets.filter((asset) => asset.present).length} of ${model.assets.length}`
            }
          />
          <Detail
            term="Image processing"
            value="sharp — resize, rotate, HEIC to JPEG"
          >
            Uploaded photos get a web-sized copy and a thumbnail; the original is kept untouched.
          </Detail>
        </dl>
      </Panel>

      <Panel
        title="Alerts"
        subtitle="In-app warnings. Acknowledging one means you have seen it, not that it is fixed."
      >
        <AlertsPanel
          alerts={health.alerts.map((alert) => ({
            id: alert.id,
            kind: alert.kind,
            severity: alert.severity,
            title: alert.title,
            body: alert.body,
            firstSeenAtMs: alert.firstSeenAtMs,
            lastSeenAtMs: alert.lastSeenAtMs,
            seenCount: alert.seenCount,
            acknowledgedAtMs: alert.acknowledgedAtMs,
            acknowledgedByName: alert.acknowledgedByName,
          }))}
          nowMs={nowMs}
        />
      </Panel>

      <p className="text-xs leading-5 text-ink-3">
        A coarse, household-data-free version of some of this is available unauthenticated at{" "}
        <code className="font-mono">/api/health</code>, for a monitor that should not need a
        session.
      </p>
    </>
  );
}

/**
 * A plain inline SVG polyline. No charting library and no animation: the UX rules forbid
 * decorative charts, and this is one of the few places where a shape says something a number
 * cannot.
 */
function Sparkline({
  label,
  samples,
  intervalMs,
}: {
  label: string;
  samples: readonly MetricSample[];
  intervalMs: number;
}) {
  const width = 640;
  const height = 56;
  const line = memorySparkline(samples, width, height);

  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        {line === null ? (
          <StatusBadge kind="unknown" size="sm" />
        ) : (
          <>
            <span className="vh-tnum text-sm text-ink-2">{formatBytes(line.lastBytes)}</span>
            <span className="vh-tnum text-xs text-ink-3">
              peak {formatBytes(line.peakBytes)} · {line.sampleCount} samples
            </span>
          </>
        )}
      </figcaption>
      {line === null ? (
        <p className="text-xs leading-5 text-ink-3">
          Fewer than two samples in the last 24 hours, so there is no trend to draw. One point is
          not a trend, and a flat line would imply a stability nobody observed. Samples are taken
          every {Math.round(intervalMs / 1000)} s while the process runs.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <svg
            role="img"
            aria-label={`${label} resident memory over the last 24 hours, currently ${formatBytes(line.lastBytes)}, peak ${formatBytes(line.peakBytes)}`}
            viewBox={`0 0 ${width} ${height}`}
            width="100%"
            height={height}
            preserveAspectRatio="none"
            className="block rounded-sm border border-line bg-surface-2"
          >
            <polyline
              points={line.points}
              fill="none"
              stroke="var(--vh-accent)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
    </figure>
  );
}

/**
 * "Cannot read" and "None" are different claims, so `FileSize` is rendered as three outcomes
 * rather than a size and a fallback.
 */
function sizeLabel(size: FileSize): string {
  switch (size.kind) {
    case "bytes":
      return formatBytes(size.bytes);
    case "absent":
      return "None";
    case "unreadable":
      return "Cannot read";
  }
}

function Detail({
  term,
  value,
  children,
}: {
  term: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">{term}</dt>
      <dd className="vh-tnum min-w-0 break-words text-sm text-ink">{value}</dd>
      {children === undefined ? null : (
        <dd className="max-w-prose text-xs leading-5 text-ink-3">{children}</dd>
      )}
    </div>
  );
}
