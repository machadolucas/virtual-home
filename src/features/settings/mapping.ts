/**
 * Grouping HA area/floor -> app location mappings for the settings table, and deciding what the
 * table should say about each row.
 *
 * The rule from §7.3 that shapes this module: **a suggestion is never a mapping.** A mapping
 * decides where a new asset lands and how the 3D view groups rooms, so a human confirms it. The
 * table therefore has three visually distinct groups — needs a decision, confirmed, rejected — and
 * the first one is not sorted away at the bottom.
 *
 * Pure and React-free.
 */
import type { LocationMappingSource } from "@/db/schema";

/** One row of the mapping table, already joined by the query layer. */
export interface MappingRow {
  id: string | null;
  haKind: "area" | "floor";
  haId: string;
  haName: string;
  /** The HA floor this area sits on, for the two-level grouping. `null` for a floor row. */
  haFloorId: string | null;
  haFloorName: string | null;
  /** How many cached devices sit in this area — the "is this worth mapping" signal. */
  deviceCount: number;
  locationId: string | null;
  locationName: string | null;
  source: LocationMappingSource | null;
  confidence: number | null;
  matchReason: string | null;
  decidedAtMs: number | null;
}

export type MappingBucket = "undecided" | "suggested" | "confirmed" | "rejected";

/**
 * `undecided` and `suggested` are separate buckets because they need different words: one says
 * "nothing here yet, choose a room", the other says "we think this is the kitchen, is it?".
 */
export function bucketOf(row: MappingRow): MappingBucket {
  if (row.source === null || row.locationId === null) return "undecided";
  switch (row.source) {
    case "suggested":
      return "suggested";
    case "confirmed":
      return "confirmed";
    case "rejected":
      return "rejected";
  }
}

export const BUCKET_ORDER: readonly MappingBucket[] = [
  "suggested",
  "undecided",
  "confirmed",
  "rejected",
];

export const BUCKET_LABEL: Record<MappingBucket, string> = {
  suggested: "Needs a decision",
  undecided: "Not mapped",
  confirmed: "Confirmed",
  rejected: "Rejected",
};

export const BUCKET_BLURB: Record<MappingBucket, string> = {
  suggested:
    "The names matched exactly. Confirm to let new equipment from this area default to that location, or reject to keep them apart.",
  undecided:
    "No mapping and no suggestion. Equipment imported from these areas will have no location until you pick one.",
  confirmed: "In effect: new equipment from this area defaults to this location.",
  rejected: "Deliberately not mapped. Nothing will suggest this pairing again.",
};

export interface MappingGroup {
  bucket: MappingBucket;
  rows: MappingRow[];
}

/**
 * Group by decision state, then sort inside a group: floors first (they frame the areas), then by
 * device count descending, then by name. Device count first because an area with 30 devices is the
 * one worth deciding about, and an empty area is noise.
 */
export function groupMappings(rows: readonly MappingRow[]): MappingGroup[] {
  const byBucket = new Map<MappingBucket, MappingRow[]>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row]);
  }
  const out: MappingGroup[] = [];
  for (const bucket of BUCKET_ORDER) {
    const group = byBucket.get(bucket);
    if (!group || group.length === 0) continue;
    out.push({ bucket, rows: [...group].sort(compareMappingRows) });
  }
  return out;
}

export function compareMappingRows(a: MappingRow, b: MappingRow): number {
  if (a.haKind !== b.haKind) return a.haKind === "floor" ? -1 : 1;
  if (a.deviceCount !== b.deviceCount) return b.deviceCount - a.deviceCount;
  return a.haName.localeCompare(b.haName);
}

/**
 * A sentence for the "why" column. `name_exact` is the only reason the suggester currently emits
 * (fuzzy scoring is deliberately not implemented), so anything else is either a manual decision or
 * a reason a future version added, and both are shown verbatim rather than swallowed.
 */
export function matchReasonText(row: MappingRow): string {
  if (row.matchReason === null) return "No suggestion was made.";
  if (row.matchReason === "name_exact") return "The area name matches the location name exactly.";
  if (row.matchReason === "manual") return "Chosen by hand.";
  if (row.matchReason === "via_linked_asset")
    return "A device in this area is already linked to equipment in that location.";
  return row.matchReason;
}
