"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download, FileSearch } from "lucide-react";
import { Badge, Button, Dialog } from "@/ui";
import { formatBytes } from "@/features/settings/format";
import { useAction } from "@/features/settings/actionClient";
import { installModelPackage, validateIncomingPackage } from "@/server/actions/settings/model";

export interface IncomingView {
  name: string;
  looksLikePackage: boolean;
  fileCount: number;
  bytes: number;
}

/**
 * Install a package from `model-incoming`, with a dry run first.
 *
 * The dry run matters because a model import is the one operation here that can open a
 * reconciliation: if the new package's fingerprint differs and semantic ids have moved, rows that
 * point at the old ones are flagged rather than silently rewritten. Seeing the validation report
 * before committing is the difference between a deliberate import and a surprise.
 */
export function InstallPackage({ incoming }: { incoming: readonly IncomingView[] }) {
  if (incoming.length === 0) {
    return (
      <p className="max-w-prose text-sm leading-6 text-ink-2">
        Nothing is waiting to be imported. Drop an exported package directory into the incoming
        folder shown below and reload this page.
      </p>
    );
  }

  return (
    <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
      {incoming.map((entry) => (
        <IncomingRow key={entry.name} entry={entry} />
      ))}
    </ul>
  );
}

function IncomingRow({ entry }: { entry: IncomingView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const validate = useAction(validateIncomingPackage, {
    successTitle: "Package read",
  });
  const install = useAction(installModelPackage, {
    successTitle: "Package installed",
    successDescription: (data) =>
      data.alreadyInstalled
        ? "That exact package was already installed; it is now the current one."
        : `Fingerprint ${data.fingerprint.slice(0, 12)} is now current.`,
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const report = validate.data;

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-ink">{entry.name}</span>
        {entry.looksLikePackage ? (
          <Badge tone="neutral" size="sm">
            has model.json
          </Badge>
        ) : (
          <Badge tone="overdue" size="sm">
            no model.json
          </Badge>
        )}
        <span className="vh-tnum text-xs text-ink-3">
          {entry.fileCount} file(s), {formatBytes(entry.bytes)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={validate.pending}
            icon={<FileSearch aria-hidden="true" />}
            onClick={() => validate.run({ directoryName: entry.name })}
          >
            Check it
          </Button>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            trigger={
              <Button
                variant="primary"
                size="sm"
                disabled={!entry.looksLikePackage}
                icon={<Download aria-hidden="true" />}
              >
                Install
              </Button>
            }
            title={`Install ${entry.name}?`}
            description="The package is copied in and becomes the current one. Nothing that points at the previous package is rewritten."
            footer={
              <>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={install.pending}>
                  Cancel
                </Button>
                <Button
                  loading={install.pending}
                  onClick={() =>
                    install.run({
                      directoryName: entry.name,
                      idempotencyKey: install.idempotencyKey,
                    })
                  }
                >
                  Install it
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3 text-sm leading-6 text-ink-2">
              <p>
                The package is immutable input: it is validated, copied to a directory named after
                its content fingerprint, and pointed at. The old one stays on disk.
              </p>
              <p>
                If the fingerprint differs from the current one, rows that reference semantic ids
                the new package no longer has are <strong className="font-semibold">flagged</strong>{" "}
                rather than changed. They stay fully usable — the task list does not care about
                geometry — and only the 3D view shows them as unplaced until somebody decides what
                they should point at.
              </p>
              {install.error === null ? null : (
                <p role="alert" className="text-sm font-medium text-overdue">
                  {install.error}
                </p>
              )}
            </div>
          </Dialog>
        </span>
      </div>

      {validate.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-overdue">
          {validate.error}
        </p>
      )}

      {report === null ? null : (
        <div className="rounded-md border border-line bg-surface-2 p-3">
          <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
            <Row term="Model id" value={report.modelId} />
            <Row term="Schema version" value={report.schemaVersion} />
            <Row term="Generated" value={report.generated ?? "not stated"} />
            <Row term="Assets" value={`${report.assetCount}`} />
          </dl>
          {report.diagnostics.length === 0 ? (
            <p className="mt-2 text-xs text-ok">No problems found.</p>
          ) : (
            <ul className="mt-2 flex list-none flex-col gap-1">
              {report.diagnostics.map((diagnostic, index) => (
                <li key={index} className="flex items-start gap-2 text-xs leading-5">
                  <Badge
                    tone={diagnostic.severity === "error" ? "overdue" : "neutral"}
                    size="sm"
                  >
                    {diagnostic.severity}
                  </Badge>
                  <span className="min-w-0 text-ink-2">
                    <span className="font-mono">{diagnostic.code}</span> — {diagnostic.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function Row({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-ink-3">{term}</dt>
      <dd className="vh-tnum min-w-0 break-words font-mono text-ink-2">{value}</dd>
    </div>
  );
}
