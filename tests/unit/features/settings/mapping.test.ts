/**
 * Grouping HA area/floor -> location mappings.
 *
 * The behaviour worth locking down: a **suggestion is not a mapping**, and the row that needs a
 * decision sorts to the top rather than being tidied away under "confirmed". §7.3 says a human
 * accepts every mapping, and a table that buries the undecided rows quietly defeats that.
 */
import { describe, expect, it } from "vitest";
import {
  BUCKET_ORDER,
  bucketOf,
  compareMappingRows,
  groupMappings,
  matchReasonText,
  type MappingRow,
} from "@/features/settings/mapping";

function row(overrides: Partial<MappingRow> = {}): MappingRow {
  return {
    id: null,
    haKind: "area",
    haId: "area_a",
    haName: "Kitchen",
    haFloorId: null,
    haFloorName: null,
    deviceCount: 0,
    locationId: null,
    locationName: null,
    source: null,
    confidence: null,
    matchReason: null,
    decidedAtMs: null,
    ...overrides,
  };
}

describe("bucketOf", () => {
  it("calls a row with no mapping undecided", () => {
    expect(bucketOf(row())).toBe("undecided");
  });

  it("calls a row whose mapping row exists but points nowhere undecided", () => {
    // Defensive: `location_id` is NOT NULL, but the query left-joins, so null is reachable.
    expect(bucketOf(row({ id: "m1", source: "confirmed", locationId: null }))).toBe("undecided");
  });

  it("keeps suggested, confirmed and rejected apart", () => {
    expect(bucketOf(row({ id: "m", source: "suggested", locationId: "l" }))).toBe("suggested");
    expect(bucketOf(row({ id: "m", source: "confirmed", locationId: "l" }))).toBe("confirmed");
    expect(bucketOf(row({ id: "m", source: "rejected", locationId: "l" }))).toBe("rejected");
  });
});

describe("groupMappings", () => {
  it("puts the rows that need a decision first", () => {
    const groups = groupMappings([
      row({ haId: "a1", id: "m1", source: "confirmed", locationId: "l1", haName: "Sauna" }),
      row({ haId: "a2", haName: "Kitchen" }),
      row({ haId: "a3", id: "m3", source: "suggested", locationId: "l3", haName: "Garage" }),
      row({ haId: "a4", id: "m4", source: "rejected", locationId: "l4", haName: "Hall" }),
    ]);
    expect(groups.map((group) => group.bucket)).toEqual([
      "suggested",
      "undecided",
      "confirmed",
      "rejected",
    ]);
  });

  it("omits an empty bucket rather than showing a heading with nothing under it", () => {
    const groups = groupMappings([row({ haId: "a1" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bucket).toBe("undecided");
  });

  it("returns nothing for no rows", () => {
    expect(groupMappings([])).toEqual([]);
  });

  it("keeps the declared bucket order stable", () => {
    expect([...BUCKET_ORDER]).toEqual(["suggested", "undecided", "confirmed", "rejected"]);
  });
});

describe("compareMappingRows", () => {
  it("puts floors before areas, because a floor frames its areas", () => {
    const floor = row({ haKind: "floor", haName: "Ground" });
    const area = row({ haKind: "area", haName: "Aaa" });
    expect(compareMappingRows(floor, area)).toBeLessThan(0);
    expect(compareMappingRows(area, floor)).toBeGreaterThan(0);
  });

  it("sorts busy areas above empty ones, because those are the ones worth deciding", () => {
    const busy = row({ haName: "Zebra", deviceCount: 30 });
    const empty = row({ haName: "Aardvark", deviceCount: 0 });
    expect(compareMappingRows(busy, empty)).toBeLessThan(0);
  });

  it("falls back to the name when the device counts tie", () => {
    const a = row({ haName: "Attic", deviceCount: 3 });
    const b = row({ haName: "Basement", deviceCount: 3 });
    expect(compareMappingRows(a, b)).toBeLessThan(0);
  });
});

describe("matchReasonText", () => {
  it("explains the reasons the suggester can emit", () => {
    expect(matchReasonText(row({ matchReason: "name_exact" }))).toContain("exactly");
    expect(matchReasonText(row({ matchReason: "manual" }))).toContain("hand");
    expect(matchReasonText(row({ matchReason: null }))).toContain("No suggestion");
  });

  it("shows an unfamiliar reason verbatim rather than swallowing it", () => {
    expect(matchReasonText(row({ matchReason: "name_fuzzy:0.86" }))).toBe("name_fuzzy:0.86");
  });
});
