import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  attachment,
  attachmentLink,
  completion,
  infraRoute,
  location,
  maintenanceOccurrence,
  part,
  project,
  projectLink,
  serviceDocument,
  system,
  type ProjectLinkEntityKind,
} from "@/db/schema";

/**
 * Reading projects: the row, what it is linked to (with names, resolved per entity kind), its
 * before/after photos and documents, and the timeline of work actually recorded against it.
 *
 * The timeline is built from **linked completions** only. It is never inferred from dates or from
 * occurrences that happened to fall inside the project window (CLAUDE.md rule 6): a project's
 * history is what someone linked to it, not what looks plausible.
 */

export type ProjectRow = typeof project.$inferSelect;

export interface ProjectLinkView {
  id: string;
  entityKind: ProjectLinkEntityKind;
  entityId: string;
  role: string | null;
  /** The linked thing's own name, or `null` when the row it points at is gone (a dangling link). */
  label: string | null;
  /** Where the app can show it, when there is somewhere to go. */
  href: string | null;
}

export interface ProjectAttachmentView {
  attachmentId: string;
  role: string | null;
  seq: number;
  kind: string;
  mime: string;
  originalFilename: string;
  caption: string | null;
  byteSize: number;
}

export interface ProjectTimelineEntry {
  completionId: string;
  completedLocalDate: string;
  completedAtMs: number;
  title: string;
  outcome: string;
  notes: string | null;
  voided: boolean;
}

export interface ProjectDetail {
  project: ProjectRow;
  links: ProjectLinkView[];
  attachments: ProjectAttachmentView[];
  timeline: ProjectTimelineEntry[];
  /** Route ids linked to this project, for the "Show in house" filter. */
  routeIds: string[];
}

export interface ProjectSummary extends ProjectRow {
  linkCount: number;
  photoCount: number;
}

/** Newest first by start date, then by name, with idea-stage projects last. */
export function listProjects(db: Db): ProjectSummary[] {
  const rows = db.select().from(project).orderBy(asc(project.name)).all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const linkCounts = new Map<string, number>();
  for (const row of db
    .select({ projectId: projectLink.projectId })
    .from(projectLink)
    .where(inArray(projectLink.projectId, ids))
    .all())
    linkCounts.set(row.projectId, (linkCounts.get(row.projectId) ?? 0) + 1);

  const photoCounts = new Map<string, number>();
  for (const row of db
    .select({ entityId: attachmentLink.entityId })
    .from(attachmentLink)
    .where(and(eq(attachmentLink.entityKind, "project"), inArray(attachmentLink.entityId, ids)))
    .all())
    photoCounts.set(row.entityId, (photoCounts.get(row.entityId) ?? 0) + 1);

  return rows
    .map((row) => ({
      ...row,
      linkCount: linkCounts.get(row.id) ?? 0,
      photoCount: photoCounts.get(row.id) ?? 0,
    }))
    .sort((a, b) => {
      const byDate = (b.startedOn ?? "").localeCompare(a.startedOn ?? "");
      return byDate !== 0 ? byDate : a.name.localeCompare(b.name);
    });
}

export function readProject(db: Db, projectId: string): ProjectDetail | null {
  const row = db.select().from(project).where(eq(project.id, projectId)).get();
  if (!row) return null;

  const linkRows = db
    .select()
    .from(projectLink)
    .where(eq(projectLink.projectId, projectId))
    .all();

  const links = linkRows.map((link): ProjectLinkView => {
    const resolved = resolveLink(db, link.entityKind, link.entityId);
    return {
      id: link.id,
      entityKind: link.entityKind,
      entityId: link.entityId,
      role: link.role,
      label: resolved.label,
      href: resolved.href,
    };
  });

  const attachments = db
    .select({
      attachmentId: attachmentLink.attachmentId,
      role: attachmentLink.role,
      seq: attachmentLink.seq,
      kind: attachment.kind,
      mime: attachment.mime,
      originalFilename: attachment.originalFilename,
      caption: attachment.caption,
      byteSize: attachment.byteSize,
    })
    .from(attachmentLink)
    .innerJoin(attachment, eq(attachment.id, attachmentLink.attachmentId))
    .where(and(eq(attachmentLink.entityKind, "project"), eq(attachmentLink.entityId, projectId)))
    .orderBy(asc(attachmentLink.seq))
    .all();

  const completionIds = linkRows
    .filter((l) => l.entityKind === "completion")
    .map((l) => l.entityId);
  const timeline: ProjectTimelineEntry[] =
    completionIds.length === 0
      ? []
      : db
          .select({
            completionId: completion.id,
            completedLocalDate: completion.completedLocalDate,
            completedAtMs: completion.completedAtMs,
            outcome: completion.outcome,
            notes: completion.notes,
            voidedAtMs: completion.voidedAtMs,
            title: maintenanceOccurrence.title,
          })
          .from(completion)
          .innerJoin(
            maintenanceOccurrence,
            eq(maintenanceOccurrence.id, completion.occurrenceId),
          )
          .where(inArray(completion.id, completionIds))
          .orderBy(desc(completion.completedAtMs))
          .all()
          .map((c) => ({
            completionId: c.completionId,
            completedLocalDate: c.completedLocalDate,
            completedAtMs: c.completedAtMs,
            title: c.title,
            outcome: c.outcome,
            notes: c.notes,
            // A voided completion stays on the timeline, marked. Deleting it would be rewriting
            // history; hiding it would make the correction invisible.
            voided: c.voidedAtMs !== null,
          }));

  return {
    project: row,
    links,
    attachments,
    timeline,
    routeIds: linkRows.filter((l) => l.entityKind === "infra_route").map((l) => l.entityId),
  };
}

/**
 * A link's own name and where to show it. `project_link` is polymorphic (SQLite cannot declare it),
 * so a row can dangle; that resolves to `label: null` and the UI shows it as broken rather than
 * pretending the link is fine.
 */
function resolveLink(
  db: Db,
  kind: ProjectLinkEntityKind,
  id: string,
): { label: string | null; href: string | null } {
  switch (kind) {
    case "asset": {
      const row = db.select({ name: asset.name }).from(asset).where(eq(asset.id, id)).get();
      return { label: row?.name ?? null, href: row ? `/equipment/${id}` : null };
    }
    case "location": {
      const row = db.select({ name: location.name, modelNodeId: location.modelNodeId, kind: location.kind }).from(location).where(eq(location.id, id)).get();
      return { label: row?.name ?? null, href: row?.modelNodeId ? `/house?sel=${row.kind === "room" ? "room" : "element"}:${encodeURIComponent(row.modelNodeId)}` : row ? "/house" : null };
    }
    case "system": {
      const row = db.select({ name: system.name }).from(system).where(eq(system.id, id)).get();
      return { label: row?.name ?? null, href: row ? `/equipment/systems` : null };
    }
    case "occurrence": {
      const row = db
        .select({ title: maintenanceOccurrence.title })
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, id))
        .get();
      return { label: row?.title ?? null, href: row ? `/tasks/${id}` : null };
    }
    case "completion": {
      const row = db
        .select({ date: completion.completedLocalDate, title: maintenanceOccurrence.title, occurrenceId: completion.occurrenceId })
        .from(completion)
        .innerJoin(maintenanceOccurrence, eq(maintenanceOccurrence.id, completion.occurrenceId))
        .where(eq(completion.id, id))
        .get();
      return { label: row ? `${row.date} · ${row.title}` : null, href: row ? `/history?completion=${encodeURIComponent(id)}` : null };
    }
    case "service_document": {
      const row = db
        .select({ kind: serviceDocument.kind, documentNo: serviceDocument.documentNo })
        .from(serviceDocument)
        .where(eq(serviceDocument.id, id))
        .get();
      return { label: row ? `${row.kind}${row.documentNo ? ` ${row.documentNo}` : ""}` : null, href: row ? `/documents/${id}` : null };
    }
    case "part": {
      const row = db.select({ name: part.name }).from(part).where(eq(part.id, id)).get();
      return { label: row?.name ?? null, href: row ? `/supplies/${id}` : null };
    }
    case "infra_route": {
      const row = db
        .select({ name: infraRoute.name })
        .from(infraRoute)
        .where(eq(infraRoute.id, id))
        .get();
      return { label: row?.name ?? null, href: row ? `/house?route=${id}` : null };
    }
  }
}

/**
 * Whether the thing a link points at exists. Called before every insert, because SQLite cannot
 * declare a polymorphic FK and a dangling link is a lie the UI would otherwise repeat.
 */
export function linkTargetExists(db: Db, kind: ProjectLinkEntityKind, id: string): boolean {
  switch (kind) {
    case "asset":
      return !!db.select({ id: asset.id }).from(asset).where(eq(asset.id, id)).get();
    case "location":
      return !!db.select({ id: location.id }).from(location).where(eq(location.id, id)).get();
    case "system":
      return !!db.select({ id: system.id }).from(system).where(eq(system.id, id)).get();
    case "occurrence":
      return !!db
        .select({ id: maintenanceOccurrence.id })
        .from(maintenanceOccurrence)
        .where(eq(maintenanceOccurrence.id, id))
        .get();
    case "completion":
      return !!db.select({ id: completion.id }).from(completion).where(eq(completion.id, id)).get();
    case "service_document":
      return !!db
        .select({ id: serviceDocument.id })
        .from(serviceDocument)
        .where(eq(serviceDocument.id, id))
        .get();
    case "part":
      return !!db.select({ id: part.id }).from(part).where(eq(part.id, id)).get();
    case "infra_route":
      return !!db.select({ id: infraRoute.id }).from(infraRoute).where(eq(infraRoute.id, id)).get();
  }
}

/**
 * Pickable targets for the link form, for the kinds where a name exists and the list is small
 * enough for one household. Tasks, completions and service documents are deliberately absent:
 * there can be thousands, and they are linked from their own screens where the context is right.
 *
 * Reads names only, never the whole rows.
 */
export interface LinkCandidate {
  id: string;
  label: string;
}

export function linkCandidates(db: Db): Partial<Record<ProjectLinkEntityKind, LinkCandidate[]>> {
  const byName = (rows: LinkCandidate[]): LinkCandidate[] =>
    rows.sort((a, b) => a.label.localeCompare(b.label));

  return {
    asset: byName(
      db
        .select({ id: asset.id, label: asset.name })
        .from(asset)
        .all()
        .map((r) => ({ id: r.id, label: r.label })),
    ),
    location: byName(
      db
        .select({ id: location.id, label: location.name })
        .from(location)
        .all()
        .map((r) => ({ id: r.id, label: r.label })),
    ),
    system: byName(
      db
        .select({ id: system.id, label: system.name })
        .from(system)
        .all()
        .map((r) => ({ id: r.id, label: r.label })),
    ),
    part: byName(
      db
        .select({ id: part.id, label: part.name })
        .from(part)
        .all()
        .map((r) => ({ id: r.id, label: r.label })),
    ),
    infra_route: byName(
      db
        .select({ id: infraRoute.id, label: infraRoute.name })
        .from(infraRoute)
        .all()
        .map((r) => ({ id: r.id, label: r.label })),
    ),
  };
}
