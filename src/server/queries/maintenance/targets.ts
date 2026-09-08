import "server-only";
import { and, asc, eq, inArray, like, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { asset, assetPlacement, system } from "@/db/schema/assets";
import { location } from "@/db/schema/model";

/**
 * A plan's or occurrence's target, resolved to something a person can read and click.
 *
 * Exactly one of asset / system / location is set on a plan (`ck_plan_one_target`), so this is a
 * three-way switch rather than a join soup.
 */
export interface TaskTarget {
  kind: "asset" | "system" | "location";
  id: string;
  name: string;
  /** Where it sits, e.g. `Kitchen · Ground floor`. `null` when the target has no place. */
  context: string | null;
  /**
   * `/house?sel=…` for the house workspace.
   *
   * The workspace selects model nodes, not database rows, so the most specific *working* selection
   * is used: an asset with a placement is selected as `equipment:<placementId>`, a room-mapped
   * location as `room:<modelNodeId>`. Everything else falls back to the row's own id, which the
   * workspace ignores harmlessly rather than breaking the link.
   */
  locateHref: string;
  /** Systems have no single place in the model; the UI says so instead of pretending. */
  locatable: boolean;
}

export interface TargetRef {
  assetId: string | null;
  systemId: string | null;
  locationId: string | null;
}

interface LocationRow {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
  modelNodeId: string | null;
}

/** Location names from the row up to the property, e.g. `["Kitchen", "Ground floor"]`. */
function locationTrail(byId: Map<string, LocationRow>, startId: string): string[] {
  const trail: string[] = [];
  let cursor: string | null = startId;
  // Depth is capped at 8 by the location invariants; the counter guards a corrupt row anyway.
  for (let i = 0; cursor !== null && i < 8; i++) {
    const row: LocationRow | undefined = byId.get(cursor);
    if (!row) break;
    if (row.kind !== "property") trail.push(row.name);
    cursor = row.parentId;
  }
  return trail;
}

/**
 * Resolve many targets in a handful of queries rather than one per row — Today renders dozens of
 * rows and an N+1 here is the difference between instant and visibly slow.
 */
export function resolveTargets(db: Db, refs: readonly TargetRef[]): Map<string, TaskTarget> {
  const assetIds = unique(refs.map((r) => r.assetId));
  const systemIds = unique(refs.map((r) => r.systemId));
  const locationIds = unique(refs.map((r) => r.locationId));

  const assets =
    assetIds.length === 0
      ? []
      : db
          .select({
            id: asset.id,
            name: asset.name,
            locationId: asset.locationId,
            manufacturer: asset.manufacturer,
            modelName: asset.modelName,
            status: asset.status,
          })
          .from(asset)
          .where(inArray(asset.id, assetIds))
          .all();

  const systems =
    systemIds.length === 0
      ? []
      : db
          .select({ id: system.id, name: system.name, kind: system.kind })
          .from(system)
          .where(inArray(system.id, systemIds))
          .all();

  const placements =
    assetIds.length === 0
      ? []
      : db
          .select({ assetId: assetPlacement.assetId, id: assetPlacement.id })
          .from(assetPlacement)
          .where(
            and(inArray(assetPlacement.assetId, assetIds), eq(assetPlacement.placementKind, "body")),
          )
          .all();
  const placementByAsset = new Map(placements.map((row) => [row.assetId, row.id]));

  // Every location in the tree: the table is tiny (tens of rows) and one read makes the trail
  // walk free for any number of targets.
  const locations = db
    .select({
      id: location.id,
      name: location.name,
      kind: location.kind,
      parentId: location.parentId,
      modelNodeId: location.modelNodeId,
    })
    .from(location)
    .all();
  const locationById = new Map<string, LocationRow>(locations.map((row) => [row.id, row]));

  const out = new Map<string, TaskTarget>();

  for (const row of assets) {
    const trail = row.locationId === null ? [] : locationTrail(locationById, row.locationId);
    const placementId = placementByAsset.get(row.id);
    const model = [row.manufacturer, row.modelName].filter((part) => part !== null).join(" ");
    out.set(`asset:${row.id}`, {
      kind: "asset",
      id: row.id,
      name: row.name,
      context: [trail.join(" · "), model, row.status === "removed" ? "removed" : null]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" · ") || null,
      locateHref:
        placementId === undefined
          ? `/house?sel=asset:${row.id}`
          : `/house?sel=equipment:${placementId}`,
      locatable: placementId !== undefined,
    });
  }

  for (const row of systems) {
    out.set(`system:${row.id}`, {
      kind: "system",
      id: row.id,
      name: row.name,
      context: `${row.kind} system`,
      locateHref: "/house",
      // A system spans locations by definition, so there is no single thing to highlight.
      locatable: false,
    });
  }

  for (const id of locationIds) {
    const row = locationById.get(id);
    if (!row) continue;
    const trail = locationTrail(locationById, id);
    out.set(`location:${id}`, {
      kind: "location",
      id,
      name: row.name,
      context: trail.slice(1).join(" · ") || null,
      locateHref: `/house?sel=room:${row.modelNodeId ?? id}`,
      locatable: row.modelNodeId !== null,
    });
  }

  return out;
}

/** The key `resolveTargets` stores a ref under, or `null` when the ref names nothing. */
export function targetKey(ref: TargetRef): string | null {
  if (ref.assetId !== null) return `asset:${ref.assetId}`;
  if (ref.systemId !== null) return `system:${ref.systemId}`;
  if (ref.locationId !== null) return `location:${ref.locationId}`;
  return null;
}

export function targetOf(
  targets: Map<string, TaskTarget>,
  ref: TargetRef,
): TaskTarget | null {
  const key = targetKey(ref);
  return key === null ? null : (targets.get(key) ?? null);
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export interface TargetOption {
  value: string;
  label: string;
  hint: string;
}

/**
 * Search assets, systems and locations for the plan wizard's target picker. One flat list with a
 * `kind:id` value, because a plan targets exactly one of the three and a single combo box is
 * simpler to use than three tabs.
 */
export function searchTargets(db: Db, query: string, limit = 40): TargetOption[] {
  const term = `%${query.trim().toLowerCase()}%`;
  const matchAll = query.trim() === "";

  const assets = db
    .select({
      id: asset.id,
      name: asset.name,
      manufacturer: asset.manufacturer,
      modelName: asset.modelName,
      locationId: asset.locationId,
    })
    .from(asset)
    .where(
      matchAll
        ? eq(asset.status, "installed")
        : and(
            eq(asset.status, "installed"),
            or(like(asset.name, term), like(asset.modelName, term), like(asset.manufacturer, term)),
          ),
    )
    .orderBy(asc(asset.name))
    .limit(limit)
    .all();

  const systems = db
    .select({ id: system.id, name: system.name, kind: system.kind })
    .from(system)
    .where(matchAll ? eq(system.status, "active") : and(eq(system.status, "active"), like(system.name, term)))
    .orderBy(asc(system.name))
    .limit(limit)
    .all();

  const locations = db
    .select({
      id: location.id,
      name: location.name,
      kind: location.kind,
      parentId: location.parentId,
      modelNodeId: location.modelNodeId,
    })
    .from(location)
    .all();
  const locationById = new Map<string, LocationRow>(locations.map((row) => [row.id, row]));

  const out: TargetOption[] = [];
  for (const row of assets) {
    const trail = row.locationId === null ? [] : locationTrail(locationById, row.locationId);
    out.push({
      value: `asset:${row.id}`,
      label: row.name,
      hint: [trail.join(" · "), [row.manufacturer, row.modelName].filter(Boolean).join(" ")]
        .filter((part) => part.length > 0)
        .join(" — "),
    });
  }
  for (const row of systems) {
    out.push({ value: `system:${row.id}`, label: row.name, hint: `${row.kind} system` });
  }
  for (const row of locations) {
    if (row.kind === "property") continue;
    if (!matchAll && !row.name.toLowerCase().includes(query.trim().toLowerCase())) continue;
    out.push({
      value: `location:${row.id}`,
      label: row.name,
      hint: locationTrail(locationById, row.id).slice(1).join(" · ") || row.kind,
    });
  }
  return out.slice(0, limit);
}

/** `"asset:abc"` → a `TargetRef`. Returns `null` for anything malformed. */
export function parseTargetValue(value: string): TargetRef | null {
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (id.length === 0) return null;
  if (kind === "asset") return { assetId: id, systemId: null, locationId: null };
  if (kind === "system") return { assetId: null, systemId: id, locationId: null };
  if (kind === "location") return { assetId: null, systemId: null, locationId: id };
  return null;
}
