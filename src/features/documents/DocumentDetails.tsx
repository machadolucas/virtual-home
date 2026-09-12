"use client";
import Link from "next/link";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import { attachDocument, editDocument, retryDocumentText, detachDocument } from "@/server/actions/documents";
import type { attachment } from "@/db/schema/attachments";
import type { DocumentTargets } from "./LibraryControls";
export function DocumentDetails({ file, targets, textStatus }: { file: typeof attachment.$inferSelect; targets: DocumentTargets; textStatus: string }) {
  const router = useRouter(); const [editing, setEditing] = useState(false); const [query, setQuery] = useState("");
  const save = useAction(editDocument, { successTitle: "Document updated", onSuccess: () => { setEditing(false); router.refresh(); } });
  const link = useAction(attachDocument, { successTitle: "Document linked", onSuccess: () => router.refresh() });
  const retry = useAction(retryDocumentText, { successTitle: "Text extraction queued", onSuccess: () => router.refresh() });
  const options = [...targets.equipment.map(t => ({...t, kind:"asset" as const})), ...targets.projects.map(t => ({...t, kind:"project" as const}))].filter(t => t.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="space-y-3"><Button data-discard-editor={editing || undefined} onClick={() => setEditing(v => !v)}>{editing ? "Cancel editing" : "Edit document details"}</Button>{editing && <form data-unsaved className="grid gap-3" onSubmit={e => { e.preventDefault(); const values = new FormData(e.currentTarget); save.run({ id:file.id, expectedUpdatedAtMs:file.updatedAtMs, caption:String(values.get("caption") || "") || null, originalFilename:String(values.get("filename")) }); }}><label>Title<input name="caption" defaultValue={file.caption ?? ""} maxLength={500} className="block w-full rounded border border-line bg-surface p-2" /></label><label>Filename<input required name="filename" defaultValue={file.originalFilename} maxLength={240} className="block w-full rounded border border-line bg-surface p-2" /></label><Button type="submit" loading={save.pending}>Save changes</Button></form>}
    <details className="rounded border border-line p-3"><summary className="cursor-pointer font-medium">Link to equipment or project</summary><input aria-label="Find equipment or project" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search equipment or projects" className="my-2 w-full rounded border border-line bg-surface p-2" /><ul className="max-h-56 overflow-auto">{options.map(t => <li key={`${t.kind}:${t.id}`}><Button variant="ghost" disabled={link.pending} onClick={() => link.run({ attachmentId:file.id, entityKind:t.kind, entityId:t.id, role:"document" })}>{t.name} · {t.kind === "asset" ? "Equipment" : "Project"}</Button></li>)}</ul>{!options.length && <p>No matching equipment or projects.</p>}</details>
    {file.mime === "application/pdf" && <p className="text-sm text-ink-2">Text index: {({pending:"Waiting for background extraction",ready:"Searchable",scan:"Scanned pages need OCR for text search",encrypted:"Password-protected",failed:"Extraction failed",truncated:"Partially indexed (document limit)"} as Record<string,string>)[textStatus] ?? textStatus}. {textStatus === "failed" && <Button size="sm" loading={retry.pending} onClick={() => retry.run({id:file.id})}>Retry extraction</Button>}</p>}
    {(save.error || link.error || retry.error) && <p role="alert" className="text-overdue">{save.error ?? link.error ?? retry.error}</p>}
  </div>;
}

export function DocumentRelationships({ links }: { links: {id:string;name:string;href:string|null;role:string|null}[] }) {
  const router=useRouter();
  const remove=useAction(detachDocument,{successTitle:"Link removed. Document kept.",onSuccess:()=>router.refresh()});
  return <ul className="divide-y divide-line">{links.map(link=><li key={link.id} className="flex items-center gap-3 py-2"><span className="min-w-0 flex-1">{link.href ? <Link href={link.href as Route} className="text-accent-text underline">{link.name}</Link> : link.name}{link.role && <span className="ml-2 text-xs text-ink-3">{link.role}</span>}</span><Button size="sm" variant="ghost" disabled={remove.pending} onClick={()=>{if(window.confirm("Remove this link? The document itself will be kept."))remove.run({linkId:link.id});}}>Unlink</Button></li>)}{remove.error && <li role="alert" className="text-overdue">{remove.error}</li>}</ul>;
}
