import { DocumentThumbnail } from "@/features/documents/DocumentViewer";
import Link from "next/link";
import { documentText } from "@/db/schema/documentText";
import { EXTRACTOR_VERSION } from "@/server/documents/text";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attachment, serviceDocument } from "@/db/schema";
import { requireSessionPage } from "@/server/auth/session";
import { PageHeader, PageScroll } from "@/ui/shell";
import { documentTargets } from "@/server/documents/service";
import { LibraryControls } from "@/features/documents/LibraryControls";
export default async function DocumentsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireSessionPage("/documents");
  const { q = "", page: rawPage } = await searchParams;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1") || 1);
  const db = getDb().db;
  const files = db.select().from(attachment).orderBy(desc(attachment.createdAtMs)).all();
  const services = db.select().from(serviceDocument).orderBy(desc(serviceDocument.createdAtMs)).all();
  const pattern = `%${q.replace(/[\\%_]/g, char => `\\${char}`)}%`;
  const textMatches = new Set(q ? db.select({id:documentText.attachmentId}).from(documentText).innerJoin(attachment,eq(attachment.id,documentText.attachmentId)).where(sql`${documentText.sha256} = ${attachment.sha256} AND ${documentText.extractorVersion} = ${EXTRACTOR_VERSION} AND ${documentText.status} IN ('ready','truncated') AND ${documentText.pagesJson} LIKE ${pattern} ESCAPE '\\'`).all().map(r=>r.id) : []);
  const rows = [ ...files.map(f => ({ id: f.id, name: f.caption || f.originalFilename, info: f.mime === "application/pdf" ? "PDF" : "Image", timestamp: f.createdAtMs })), ...services.map(d => ({ id: d.id, name: d.documentNo || d.kind.replaceAll("_", " "), info: [d.kind, d.issuedOn, d.notes].filter(Boolean).join(" · "), timestamp: d.createdAtMs })) ].filter(r => textMatches.has(r.id) || `${r.name} ${r.info}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())).sort((a, b) => b.timestamp - a.timestamp);
  return <PageScroll><PageHeader title="Documents" description="Manuals, photos, invoices and service records." /><LibraryControls targets={documentTargets(db)} />
    <form className="my-4 flex gap-2"><input name="q" aria-label="Search documents" defaultValue={q} placeholder="Search documents" className="min-h-11 flex-1 rounded-md border border-line bg-surface px-3" /><button className="rounded border border-line px-3">Search</button></form>
    {rows.length ? <ul className="divide-y divide-line rounded-lg border border-line">{rows.slice((page - 1) * 40, page * 40).map(r => <li key={r.id}><Link href={`/documents/${r.id}`} className="flow-root block p-3 hover:bg-surface-2">{files.find(f=>f.id===r.id) && <span className="float-left mr-3 block w-24"><DocumentThumbnail document={files.find(f=>f.id===r.id)!} /></span>}<span className="font-medium">{r.name}</span><p className="truncate text-sm text-ink-3">{r.info}</p></Link></li>)}</ul> : <p className="p-4 text-ink-2">{q ? "No matching documents." : "No documents yet. Upload a manual or photo, or create a service record above."}</p>}
    <nav aria-label="Document pages" className="mt-4 flex gap-4">{page > 1 && <Link href={`/documents?q=${encodeURIComponent(q)}&page=${page - 1}`}>Previous</Link>}<span>{rows.length} documents</span>{page * 40 < rows.length && <Link href={`/documents?q=${encodeURIComponent(q)}&page=${page + 1}`}>Next</Link>}</nav>
  </PageScroll>;
}
