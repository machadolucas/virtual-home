import "server-only";
/**
 * `GET /api/search?q=…` — the header search's index.
 *
 * Deliberately not a search engine: one `LIKE` per table over the columns a household member
 * would actually type, each capped, each result carrying the href that opens the thing. SQLite's
 * FTS5 would be the answer at a hundred thousand rows; at this size it would be a second copy of
 * the data to keep in sync for no measurable gain.
 *
 * Two rules from CLAUDE.md shape it:
 *  - **Rule 2**: `authed()` wraps the handler, so an unauthenticated caller gets 401 and never a
 *    hint about what exists in the house.
 *  - **Nothing is invented.** A group with no matches is absent, and a group that hit the cap says
 *    so with `hasMore` rather than implying it showed everything. It does not claim a total: that
 *    would need a second count query per table to be true, and "there are more" is the only part
 *    the reader can act on.
 */
import { asc, like, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@/db/client";
import { asset, location, maintenancePlan, maintenanceOccurrence, completion, part, procedure, project, serviceProvider } from "@/db/schema";

/** Per-group cap. Eight is what the header surface can show without becoming a page of its own. */
const PER_GROUP = 8;
const MIN_QUERY = 2;

export type SearchGroupKind =
  | "equipment"
  | "supplies"
  | "rooms"
  | "projects"
  | "procedures"
  | "plans"
  | "tasks"
  | "history"
  | "providers"
  | "documents";

export interface SearchHit {
  id: string;
  label: string;
  secondary: string | null;
  href: string;
}

export interface SearchGroup {
  kind: SearchGroupKind;
  label: string;
  hits: SearchHit[];
  /** True when the cap cut the list, so the UI can say "narrow it" instead of "that is all". */
  hasMore: boolean;
}

/** `LIKE` with the wildcards applied and the user's own `%`/`_` neutralised. */
function contains(column: Parameters<typeof like>[0], query: string): SQL {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return sql`${column} LIKE ${`%${escaped}%`} ESCAPE '\\'`;
}

export function searchRecords(db: Db, query: string, options: { limit?: number; offset?: number; kind?: string } = {}): SearchGroup[] {
  query = query.trim().slice(0, 200);
  if (query.length < MIN_QUERY) return [];
  const limit = Math.min(50, Math.max(1, options.limit ?? PER_GROUP));
  const offset = Math.max(0, options.offset ?? 0);
  const groups: SearchGroup[] = [];

  const push = (kind: SearchGroupKind, label: string, hits: SearchHit[]): void => {
    if (hits.length === 0 || (options.kind && kind !== options.kind)) return;
    // One row over the cap was fetched purely to answer "is there more".
    groups.push({ kind, label, hits: hits.slice(0, limit), hasMore: hits.length > limit });
  };

  // Equipment: the nameplate fields, because "which humidifier was it" is usually answered by a
  // model number rather than by the name someone typed a year ago.
  push(
    "equipment",
    "Equipment",
    db
      .select({
        id: asset.id,
        name: asset.name,
        manufacturer: asset.manufacturer,
        modelName: asset.modelName,
        locationName: location.name,
      })
      .from(asset)
      .leftJoin(location, sql`${location.id} = ${asset.locationId}`)
      .where(
        or(
          contains(asset.name, query),
          contains(asset.manufacturer, query),
          contains(asset.modelName, query),
          contains(asset.serialNumber, query),
          contains(asset.productCode, query),
        ),
      )
      .orderBy(asc(asset.name))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({
        id: row.id,
        label: row.name,
        secondary:
          [row.manufacturer, row.modelName].filter(Boolean).join(" ") || row.locationName || null,
        href: `/equipment/${row.id}`,
      })),
  );

  push(
    "supplies",
    "Supplies",
    db
      .select({
        id: part.id,
        name: part.name,
        manufacturer: part.manufacturer,
        productCode: part.productCode,
        spec: part.spec,
      })
      .from(part)
      .where(
        or(
          contains(part.name, query),
          contains(part.manufacturer, query),
          contains(part.productCode, query),
          contains(part.ean, query),
          contains(part.spec, query),
        ),
      )
      .orderBy(asc(part.name))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({
        id: row.id,
        label: row.name,
        secondary: [row.manufacturer, row.productCode, row.spec].filter(Boolean).join(" ") || null,
        href: `/supplies/${row.id}`,
      })),
  );

  // Rooms and zones jump into the 3D workspace with the thing already selected — `?sel=kind:id`
  // is the workspace's own URL contract (`src/house/store/urlSync.ts`).
  push(
    "rooms",
    "Rooms and zones",
    db
      .select({
        id: location.id,
        name: location.name,
        kind: location.kind,
        modelNodeId: location.modelNodeId,
      })
      .from(location)
      .where(contains(location.name, query))
      .orderBy(asc(location.name))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({
        id: row.id,
        label: row.name,
        secondary: row.kind,
        href:
          row.modelNodeId && row.kind === "room"
            ? `/house?sel=room:${encodeURIComponent(row.modelNodeId)}`
            : row.modelNodeId
              ? `/house?sel=element:${encodeURIComponent(row.modelNodeId)}`
              : "/house",
      })),
  );

  push(
    "projects",
    "Projects",
    db
      .select({ id: project.id, name: project.name, status: project.status })
      .from(project)
      .where(contains(project.name, query))
      .orderBy(asc(project.name))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({
        id: row.id,
        label: row.name,
        secondary: row.status,
        href: `/projects/${row.id}`,
      })),
  );

  push(
    "procedures",
    "Procedures",
    db
      .select({ id: procedure.id, title: procedure.title })
      .from(procedure)
      .where(contains(procedure.title, query))
      .orderBy(asc(procedure.title))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({ id: row.id, label: row.title, secondary: null, href: `/procedures/${row.id}` })),
  );

  push(
    "plans",
    "Maintenance plans",
    db
      .select({ id: maintenancePlan.id, title: maintenancePlan.title })
      .from(maintenancePlan)
      .where(contains(maintenancePlan.title, query))
      .orderBy(asc(maintenancePlan.title))
      .limit(limit + 1)
      .offset(offset)
      .all()
      .map((row) => ({ id: row.id, label: row.title, secondary: null, href: `/plans/${row.id}` })),
  );

  push("tasks", "Tasks", db.select({ id: maintenanceOccurrence.id, title: maintenanceOccurrence.title, date: maintenanceOccurrence.dueDate, status: maintenanceOccurrence.status }).from(maintenanceOccurrence).where(contains(maintenanceOccurrence.title, query)).orderBy(asc(maintenanceOccurrence.title), asc(maintenanceOccurrence.id)).limit(limit + 1).offset(offset).all().map((r) => ({ id: r.id, label: r.title, secondary: `${r.date} · ${r.status}`, href: `/tasks/${r.id}` })));
  push("history", "Completed work", db.select({ id: completion.id, occurrenceId: completion.occurrenceId, title: maintenanceOccurrence.title, date: completion.completedLocalDate, voided: completion.voidedAtMs }).from(completion).innerJoin(maintenanceOccurrence, sql`${maintenanceOccurrence.id} = ${completion.occurrenceId}`).where(or(contains(maintenanceOccurrence.title, query), contains(completion.notes, query))).orderBy(asc(completion.completedLocalDate), asc(completion.id)).limit(limit + 1).offset(offset).all().map((r) => ({ id: r.id, label: r.title, secondary: `${r.date}${r.voided !== null ? " · Voided" : ""}`, href: `/history?completion=${encodeURIComponent(r.id)}` })));
  push("providers", "Providers", db.select().from(serviceProvider).where(or(contains(serviceProvider.name, query), contains(serviceProvider.trade, query), contains(serviceProvider.contactName, query))).orderBy(asc(serviceProvider.name), asc(serviceProvider.id)).limit(limit + 1).offset(offset).all().map((r) => ({ id: r.id, label: r.name, secondary: [r.trade, r.archivedAtMs !== null ? "Archived" : null].filter(Boolean).join(" · ") || null, href: `/providers/${r.id}` })));
  const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const docs = db.all<{ id: string; label: string; secondary: string | null }>(sql`
    SELECT id, label, secondary FROM (
      SELECT a.id, COALESCE(NULLIF(a.caption,''),a.original_filename) AS label, a.mime AS secondary
      FROM attachment a LEFT JOIN document_text dt ON dt.attachment_id=a.id AND dt.sha256=a.sha256
      WHERE a.caption LIKE ${pattern} ESCAPE '\\' OR a.original_filename LIKE ${pattern} ESCAPE '\\'
        OR (dt.status IN ('ready','truncated') AND dt.pages_json LIKE ${pattern} ESCAPE '\\')
      UNION ALL
      SELECT s.id, COALESCE(NULLIF(s.document_no,''),s.kind) AS label, s.kind AS secondary
      FROM service_document s WHERE s.document_no LIKE ${pattern} ESCAPE '\\' OR s.kind LIKE ${pattern} ESCAPE '\\' OR s.notes LIKE ${pattern} ESCAPE '\\'
    ) ORDER BY label, id LIMIT ${limit + 1} OFFSET ${offset}
  `);
  push("documents", "Documents", docs.map(r => ({ ...r, href: `/documents/${r.id}` })));

  return groups;
}
