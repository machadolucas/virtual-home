import type { Metadata } from "next";
import { Boxes } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel } from "@/ui";
import { PageHeader } from "@/ui/shell";
import { pageContext } from "@/server/queries/settings/household";
import { readModelSettings } from "@/server/queries/settings/model";
import { formatBytes } from "@/features/settings/format";
import { InstallPackage } from "./ModelClient";
import { ReconciliationPanel } from "./ReconciliationPanel";

export const metadata: Metadata = { title: "House model" };

/**
 * `/settings/model` — the installed house-model package, and importing a new one.
 *
 * The package is immutable input (CLAUDE.md rule 7). Runtime data references its semantic ids and
 * metre coordinates; nothing here edits geometry, and importing a new revision never silently
 * rewrites a row that points at the old one. What it can do is open a **reconciliation**, which a
 * person then works through item by item.
 *
 * The reconciliation panel is where that happens: `src/server/house-model/revision.ts` records one
 * decision per row (`remap` / `keep` / `archive`) and applies them all in one transaction, which is
 * the only step that moves the current revision. (`src/house/model/reconcile.ts` is a separate
 * *report* generator for the viewer, unrelated to these rows.)
 */
export default async function ModelSettingsPage() {
  await requireSessionPage("/settings/model");
  const { db } = pageContext();
  const settings = await readModelSettings(db);
  const { status } = settings;

  const missingAssets = status.assets.filter((asset) => !asset.present);
  const errors = status.diagnostics.filter((entry) => entry.severity === "error");
  const warnings = status.diagnostics.filter((entry) => entry.severity !== "error");

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="House model"
        description="The imported package the house workspace draws. It is immutable input: runtime data points at its semantic identifiers and metre coordinates, and never edits its geometry."
      />

      {!status.installed ? (
        <EmptyState
          icon={<Boxes />}
          title="No package installed"
          description="Without a model, the house workspace has nothing to draw. Everything else — tasks, supplies, history — works perfectly well without it."
          bullets={[
            "Drop an exported package directory into the incoming folder below.",
            "Check it first: the validation report names every problem before anything is copied.",
            "Install it, and it becomes the current package under its content fingerprint.",
          ]}
          note={`Incoming folder: ${settings.incomingDir}`}
        />
      ) : (
        <Panel title="Current package">
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <Detail term="Model id" value={status.modelId ?? "unknown"} mono />
            <Detail term="Name" value={status.name ?? "not stated"} />
            <Detail term="Fingerprint" value={status.fingerprint ?? "unknown"} mono>
              The sha256 of the package’s canonicalised contents. A different fingerprint is a
              different package, even if the model id is the same.
            </Detail>
            <Detail term="Schema version" value={status.schemaVersion ?? "unknown"} />
            <Detail term="Generated" value={status.generated ?? "not stated"}>
              When the exporter produced it — not when it was imported here.
            </Detail>
            <Detail
              term="Geometry files"
              value={`${status.assets.length - missingAssets.length} of ${status.assets.length} present`}
            >
              {missingAssets.length === 0
                ? "Every file the manifest names is on disk."
                : `Missing: ${missingAssets.map((asset) => asset.path).join(", ")}. The workspace will render what it can and say what it could not.`}
            </Detail>
          </dl>
        </Panel>
      )}

      {status.assets.length === 0 ? null : (
        <Panel flush title="What it contains" subtitle="One row per geometry file in the manifest.">
          <div className="w-full overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Geometry files in the current package</caption>
              <thead>
                <tr className="border-b border-line">
                  <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                    Id
                  </th>
                  <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                    Kind
                  </th>
                  <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                    File
                  </th>
                  <th
                    scope="col"
                    className="bg-surface-2 px-3 py-2 text-right text-xs font-medium text-ink-3"
                  >
                    Size
                  </th>
                  <th scope="col" className="bg-surface-2 px-3 py-2 text-xs font-medium text-ink-3">
                    Loaded by default
                  </th>
                </tr>
              </thead>
              <tbody>
                {status.assets.map((asset) => (
                  <tr key={asset.id} className="border-b border-line/70 last:border-b-0">
                    <td className="px-3 py-2 font-mono text-xs text-ink">{asset.id}</td>
                    <td className="px-3 py-2 text-ink-2">{asset.kind}</td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-3">
                      {asset.path}
                      {asset.present ? null : (
                        <Badge tone="overdue" size="sm" className="ml-2">
                          missing
                        </Badge>
                      )}
                    </td>
                    <td className="vh-tnum px-3 py-2 text-right text-ink-2">
                      {asset.bytes === null ? "—" : formatBytes(asset.bytes)}
                    </td>
                    <td className="px-3 py-2 text-ink-3">{asset.loadByDefault ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {status.diagnostics.length === 0 && status.issues.length === 0 ? null : (
        <Panel
          title="What the package says about itself"
          subtitle="Issues the exporter reported, plus anything the validator found on import."
        >
          {errors.length > 0 ? (
            <ul className="flex list-none flex-col gap-2">
              {errors.map((entry, index) => (
                <li key={`e${index}`} className="flex items-start gap-2 text-sm leading-6">
                  <Badge tone="overdue" size="sm">
                    error
                  </Badge>
                  <span className="min-w-0 text-ink-2">
                    <span className="font-mono text-xs">{entry.code}</span> — {entry.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="mt-2 flex list-none flex-col gap-2">
              {warnings.map((entry, index) => (
                <li key={`w${index}`} className="flex items-start gap-2 text-sm leading-6">
                  <Badge tone="neutral" size="sm">
                    {entry.severity}
                  </Badge>
                  <span className="min-w-0 text-ink-2">
                    <span className="font-mono text-xs">{entry.code}</span> — {entry.message}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {status.issues.length === 0 ? null : (
            <ul className="mt-2 flex list-none flex-col gap-2 border-t border-line pt-3">
              {/* These are the exporter's own uncertainty notes ("this wall's thickness was
                  guessed"), on a low/medium/high scale — not validation errors. */}
              {status.issues.map((issue) => (
                <li key={issue.id} className="flex items-start gap-2 text-sm leading-6">
                  <Badge tone={issue.severity === "high" ? "due" : "neutral"} size="sm">
                    {issue.severity}
                  </Badge>
                  <span className="min-w-0 text-ink-2">
                    <span className="font-mono text-xs">{issue.id}</span> — {issue.description}
                    {issue.affects.length === 0
                      ? null
                      : ` (affects ${issue.affects.join(", ")})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Panel
        title="Import a package"
        subtitle={`Directories in ${settings.incomingDir}`}
      >
        <InstallPackage
          incoming={settings.incoming.map((entry) => ({
            name: entry.name,
            looksLikePackage: entry.looksLikePackage,
            fileCount: entry.fileCount,
            bytes: entry.bytes,
          }))}
        />
        <p className="mt-4 max-w-prose text-sm leading-6 text-ink-2">
          A package with a different fingerprint may open a reconciliation. Nothing is rewritten:
          rows whose semantic id the new package no longer has keep pointing at the old revision and
          are flagged, so a task list stays complete while the 3D view honestly shows those items as
          unplaced.
        </p>
      </Panel>

      {settings.revisions.length === 0 ? null : (
        <Panel flush title="Import history">
          <ul className="flex list-none flex-col">
            {settings.revisions.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <Badge
                  tone={revision.status === "current" ? "accent" : "neutral"}
                  size="sm"
                >
                  {revision.status}
                </Badge>
                <span className="font-mono text-xs text-ink">{revision.modelId}</span>
                <span className="font-mono text-xs text-ink-3">
                  {revision.contentHash.slice(0, 12)}
                </span>
                <span className="vh-tnum text-xs text-ink-3">
                  schema {revision.schemaVersion} · {revision.nodeCount} nodes
                </span>
                <span className="vh-tnum ml-auto text-xs text-ink-3">
                  imported {new Date(revision.importedAtMs).toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Reconciliation"
        subtitle="What to do about data that points at identifiers a new package no longer has."
      >
        <ReconciliationPanel
          plans={settings.reconciliations.map((plan) => ({
            id: plan.id,
            status: plan.status,
            fromLabel: plan.fromLabel,
            toLabel: plan.toLabel,
            createdAtMs: plan.createdAtMs,
            appliedAtMs: plan.appliedAtMs,
            total: plan.total,
            decided: plan.decided,
            undecided: plan.undecided,
            applicable: plan.applicable,
            summary: plan.summary,
            items: plan.items.map((item) => ({
              id: item.id,
              entityKind: item.entityKind,
              entityId: item.entityId,
              oldNodeId: item.oldNodeId,
              issue: item.issue,
              proposedAction: item.proposedAction,
              proposedNewNodeId: item.proposedNewNodeId,
              decision: item.decision,
              decidedNewNodeId: item.decidedNewNodeId,
              decidedByName: item.decidedByName,
              note: item.note,
              candidates: item.candidates,
            })),
          }))}
        />
      </Panel>
    </>
  );
}

function Detail({
  term,
  value,
  mono = false,
  children,
}: {
  term: string;
  value: string;
  mono?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">{term}</dt>
      <dd
        className={
          mono ? "min-w-0 break-words font-mono text-xs text-ink" : "text-sm text-ink"
        }
      >
        {value}
      </dd>
      {children === undefined ? null : (
        <dd className="max-w-prose text-xs leading-5 text-ink-3">{children}</dd>
      )}
    </div>
  );
}
