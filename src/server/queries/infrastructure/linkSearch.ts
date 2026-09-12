import "server-only";
import { asc, desc, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { asset, completion, infraRoute, location, maintenanceOccurrence, part, project, serviceDocument, system, type ProjectLinkEntityKind } from "@/db/schema";
export function searchLinkCandidates(db: Db, kind: ProjectLinkEntityKind | "project", query: string, offset = 0) {
  const needle = `%${query.trim().slice(0, 200).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const cap = 26;
  let rows: { id: string; label: string }[];
  if (kind === "completion") rows = db.select({ id: completion.id, label: sql<string>`${completion.completedLocalDate} || ' · ' || ${maintenanceOccurrence.title} || CASE WHEN ${completion.voidedAtMs} IS NULL THEN '' ELSE ' · Voided' END` }).from(completion).innerJoin(maintenanceOccurrence, sql`${maintenanceOccurrence.id} = ${completion.occurrenceId}`).where(sql`(${maintenanceOccurrence.title} LIKE ${needle} ESCAPE '\\' OR ${completion.completedLocalDate} LIKE ${needle} ESCAPE '\\')`).orderBy(desc(completion.completedAtMs), asc(completion.id)).limit(cap).offset(offset).all();
  else if (kind === "service_document") rows = db.select({ id: serviceDocument.id, label: sql<string>`${serviceDocument.kind} || ' · ' || COALESCE(${serviceDocument.documentNo}, ${serviceDocument.issuedOn}, '')` }).from(serviceDocument).where(sql`(${serviceDocument.documentNo} LIKE ${needle} ESCAPE '\\' OR ${serviceDocument.kind} LIKE ${needle} ESCAPE '\\')`).orderBy(desc(serviceDocument.issuedOn), asc(serviceDocument.id)).limit(cap).offset(offset).all();
  else if (kind === "occurrence") rows = db.select({ id: maintenanceOccurrence.id, label: sql<string>`${maintenanceOccurrence.title} || ' · ' || ${maintenanceOccurrence.dueDate} || ' · ' || ${maintenanceOccurrence.status}` }).from(maintenanceOccurrence).where(sql`${maintenanceOccurrence.title} LIKE ${needle} ESCAPE '\\'`).orderBy(desc(maintenanceOccurrence.createdAtMs), asc(maintenanceOccurrence.id)).limit(cap).offset(offset).all();
  else {
    const table = { asset, location, system, part, infra_route: infraRoute, project }[kind];
    rows = db.select({ id: table.id, label: table.name }).from(table).where(sql`${table.name} LIKE ${needle} ESCAPE '\\'`).orderBy(asc(table.name), asc(table.id)).limit(cap).offset(offset).all();
  }
  return { candidates: rows.slice(0, 25), hasMore: rows.length > 25 };
}
