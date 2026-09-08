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
import { getDb } from "@/db/client";
import { asset, location, maintenancePlan, part, procedure, project } from "@/db/schema";
import { authed } from "@/server/api/handler";
import { NO_STORE } from "@/server/house-model/http";

/** Per-group cap. Eight is what the header surface can show without becoming a page of its own. */
const PER_GROUP = 8;
const MIN_QUERY = 2;

export type SearchGroupKind =
  | "equipment"
  | "supplies"
  | "rooms"
  | "projects"
  | "procedures"
  | "plans";

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

export const GET = authed(async (_session, req) => {
  const query = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (query.length < MIN_QUERY) {
    return Response.json({ query, groups: [] satisfies SearchGroup[] }, { headers: NO_STORE });
  }

  const db = getDb().db;
  const groups: SearchGroup[] = [];

  const push = (kind: SearchGroupKind, label: string, hits: SearchHit[]): void => {
    if (hits.length === 0) return;
    // One row over the cap was fetched purely to answer "is there more".
    groups.push({ kind, label, hits: hits.slice(0, PER_GROUP), hasMore: hits.length > PER_GROUP });
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
      .limit(PER_GROUP + 1)
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
      .limit(PER_GROUP + 1)
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
      .limit(PER_GROUP + 1)
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
      .limit(PER_GROUP + 1)
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
      .limit(PER_GROUP + 1)
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
      .limit(PER_GROUP + 1)
      .all()
      .map((row) => ({ id: row.id, label: row.title, secondary: null, href: `/plans/${row.id}` })),
  );

  return Response.json({ query, groups }, { headers: NO_STORE });
});
