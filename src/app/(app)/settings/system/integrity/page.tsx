import Link from "next/link";
import { requireSessionPage } from "@/server/auth/session";
import { integrityReport } from "@/server/queries/settings/integrity";
import { Panel } from "@/ui";
import { PageHeader } from "@/ui/shell";
import { RepairButton } from "./RepairButton";
export const metadata = { title: "Storage integrity" };
export default async function IntegrityPage() {
  await requireSessionPage("/settings/system/integrity");
  const report = integrityReport();
  return <><PageHeader title="Storage integrity" description="Check missing attachments and broken links. Quarantine is reversible; no record is deleted automatically." />
    {report.storageError && <p role="alert" className="text-overdue">{report.storageError}</p>}
    <Panel title="Missing attachment files">{report.missing.length ? <ul>{report.missing.map((r) => <li key={r.id} className="py-2"><Link href={`/documents/${r.id}`}>{r.name}</Link><p className="text-xs text-ink-3">Check the storage volume or restore the missing original or generated copy from backup. The attachment record is preserved.</p></li>)}</ul> : <p>{report.storageError ? "File availability could not be verified." : "All registered attachment files are present."}</p>}</Panel>
    <Panel title="Unreferenced files">{report.orphanFiles.length ? <ul>{report.orphanFiles.map((file) => <li key={file} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2"><span className="break-all text-sm">{file}</span><RepairButton file={file} /></li>)}</ul> : <p>No unreferenced files found.</p>}</Panel>
    <Panel title="Broken project links">{report.dangling.length ? <ul>{report.dangling.map((r) => <li key={r.id}><Link href={`/projects/${r.projectId}`}>Open project to replace or remove its missing {r.entityKind} link</Link></li>)}</ul> : <p>All project links have a target.</p>}</Panel>
    <Panel title="Quarantine">{report.quarantine.length ? <ul>{report.quarantine.map((r) => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2"><span className="break-all text-sm">{r.originalPath}</span>{r.restoredAtMs !== null && !r.hasQuarantineCopy ? <span>Restored</span> : <RepairButton restoreId={r.id} cleanup={r.restoredAtMs !== null} />}</li>)}</ul> : <p>No files have been quarantined.</p>}</Panel>
  </>;
}
