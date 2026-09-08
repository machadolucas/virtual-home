"use client";
import type { Diagnostic } from "@/house/model/crossref";
import type { PackageIssue } from "@/house/store/slices/model";

export interface SetupStateProps {
  phase: string;
  modelId: string | null;
  fingerprint: string | null;
  diagnostics: readonly Diagnostic[];
  issues: readonly PackageIssue[];
  missingAssetIds: readonly string[];
  failedAssetIds: readonly string[];
  fatal: { code: string; message: string; details?: string[] } | null;
  onRetry?: () => void;
}

const SEVERITY_ORDER = ["high", "medium", "low", "info"] as const;

/**
 * What the user sees instead of a blank canvas: which diagnostic, which asset, which id.
 *
 * It also lists the package's own `issues[]`, because "the garage position is inferred to ±0.5 m"
 * is something the household needs to know before recording an equipment position there.
 */
export function SetupState(props: SetupStateProps) {
  const errors = props.diagnostics.filter((d) => d.severity === "error");
  const warnings = props.diagnostics.filter((d) => d.severity === "warning");
  const notes = props.diagnostics.filter((d) => d.severity === "info");
  const grouped = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: props.issues.filter((i) => i.severity === severity),
  })).filter((g) => g.items.length > 0);

  const notInstalled = props.modelId === null && errors.length === 0 && !props.fatal;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto rounded-lg border border-line bg-surface p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-ink">
          {notInstalled ? "No house model installed" : "The house model needs attention"}
        </h2>
        <p className="text-sm text-ink-2">
          {notInstalled
            ? "Import a model package with pnpm vh-admin model-import <dir>, then reload this page."
            : "The 3D view stays off until the package validates. Nothing else on this page is affected."}
        </p>
        {props.modelId ? (
          <p className="text-xs text-ink-3">
            {props.modelId}
            {props.fingerprint ? ` · package ${props.fingerprint}` : ""} · {props.phase}
          </p>
        ) : null}
      </header>

      {props.fatal ? (
        <section className="rounded-md border border-overdue/45 bg-overdue-soft p-4">
          <h3 className="text-sm font-semibold text-overdue">{props.fatal.code}</h3>
          <p className="mt-1 text-sm text-overdue">{props.fatal.message}</p>
          {props.fatal.details?.length ? (
            <ul className="mt-2 list-inside list-disc space-y-0.5 font-mono text-xs text-overdue">
              {props.fatal.details.slice(0, 40).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {props.missingAssetIds.length || props.failedAssetIds.length ? (
        <section className="rounded-md border border-due/45 bg-due-soft p-4">
          <h3 className="text-sm font-semibold text-due">Assets</h3>
          <ul className="mt-1 space-y-0.5 text-sm text-due">
            {props.missingAssetIds.map((id) => (
              <li key={`missing-${id}`}>
                <span className="font-mono">{id}</span> — file missing on the server
              </li>
            ))}
            {props.failedAssetIds.map((id) => (
              <li key={`failed-${id}`}>
                <span className="font-mono">{id}</span> — failed to load in the browser
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DiagnosticList title="Errors" tone="error" items={errors} />
      <DiagnosticList title="Warnings" tone="warning" items={warnings} />
      <DiagnosticList title="Notes" tone="info" items={notes} />

      {grouped.length ? (
        <section>
          <h3 className="text-sm font-semibold text-ink">
            Known issues recorded by the model producer
          </h3>
          <div className="mt-2 space-y-3">
            {grouped.map((group) => (
              <div key={group.severity}>
                <h4 className="text-xs font-medium uppercase tracking-wide text-ink-3">
                  {group.severity} ({group.items.length})
                </h4>
                <ul className="mt-1 space-y-1 text-sm text-ink-2">
                  {group.items.map((issue) => (
                    <li key={issue.id}>
                      <span className="font-mono text-xs text-ink-3">{issue.id}</span>{" "}
                      {issue.description}
                      {issue.affects.length ? (
                        <span className="text-ink-3"> — affects {issue.affects.join(", ")}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {props.onRetry ? (
        <button
          type="button"
          onClick={props.onRetry}
          className="self-start min-h-9 rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-surface-3"
        >
          Check again
        </button>
      ) : null}
    </div>
  );
}

function DiagnosticList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: "error" | "warning" | "info";
  items: readonly Diagnostic[];
}) {
  if (items.length === 0) return null;
  const toneClass =
    tone === "error"
      ? "border-overdue/45 bg-overdue-soft text-overdue"
      : tone === "warning"
        ? "border-due/45 bg-due-soft text-due"
        : "border-line bg-surface-2 text-ink-2";
  return (
    <section className={`rounded-md border p-4 ${toneClass}`}>
      <h3 className="text-sm font-semibold">
        {title} ({items.length})
      </h3>
      <ul className="mt-1 space-y-0.5 text-sm">
        {items.slice(0, 60).map((d, i) => (
          <li key={`${d.code}-${i}`}>
            <span className="font-mono text-xs opacity-70">{d.code}</span> {d.message}
          </li>
        ))}
      </ul>
      {items.length > 60 ? <p className="mt-1 text-xs opacity-70">… and {items.length - 60} more</p> : null}
    </section>
  );
}
