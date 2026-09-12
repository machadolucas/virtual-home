import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attachment, attachmentLink, serviceDocument } from "@/db/schema";
import { requireSessionPage } from "@/server/auth/session";
import { documentTargets } from "@/server/documents/service";
import { readDocumentText } from "@/server/documents/text";
import { DocumentPreview } from "@/features/documents/DocumentViewer";
import { DocumentDetails, DocumentRelationships } from "@/features/documents/DocumentDetails";
import { ServiceDocumentForm, ServiceDocumentDetails } from "@/features/documents/ServiceDocumentForm";
import { PageHeader, PageScroll } from "@/ui/shell";
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSessionPage("/documents");
  const { id } = await params; const db = getDb().db;
  const service = db.select().from(serviceDocument).where(eq(serviceDocument.id, id)).get();
  const fileId = service?.attachmentId ?? id;
  const file = db.select().from(attachment).where(eq(attachment.id, fileId)).get();
  if (!file && !service) notFound();
  const targets = documentTargets(db);
  const links = file ? db.select().from(attachmentLink).where(eq(attachmentLink.attachmentId,file.id)).all() : [];
  return <PageScroll><Link href="/documents" className="text-sm text-accent-text">← Documents</Link><PageHeader title={service?.documentNo || file?.caption || file?.originalFilename || service?.kind || "Document"} />
    {file && <div className="space-y-4"><DocumentPreview document={file} /><DocumentDetails file={file} targets={targets} textStatus={readDocumentText(db,file.id).status} />
      {links.length > 0 && <section><h2 className="font-medium">Linked records</h2><DocumentRelationships links={links.map(link => { const item = link.entityKind === "asset" ? targets.equipment.find(t=>t.id===link.entityId) : link.entityKind === "project" ? targets.projects.find(t=>t.id===link.entityId) : undefined; const base = ({asset:"equipment",project:"projects",occurrence:"tasks",service_document:"documents",completion:"history",location:"house"} as Record<string,string>)[link.entityKind]; return {id:link.id,role:link.role,name:item?.name ?? link.entityKind.replaceAll("_"," "),href:base ? base === "history" ? `/history?completion=${link.entityId}` : base === "house" ? `/house?location=${link.entityId}` : `/${base}/${link.entityId}` : null};})} /></section>}
    </div>}
    {service && <section className="mt-4"><h2 className="mb-3 font-medium">Service record</h2><ServiceDocumentDetails record={service} targets={targets} /></section>}
    {!service && file && <details className="mt-4"><summary className="cursor-pointer font-medium">Use in a service record</summary><ServiceDocumentForm attachmentId={file.id} targets={targets}/></details>}
  </PageScroll>;
}
