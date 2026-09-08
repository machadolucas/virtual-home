/**
 * Filtering and searching the supplies list.
 *
 * The search has to find a filter by the *shelf* it is on and by the *equipment* it fits, because
 * those are the two things somebody standing in the garage actually knows. And it has to ignore
 * diacritics, because half the room names in this house have them.
 */
import { describe, expect, it } from "vitest";
import {
  applySupplyFilter,
  filterCounts,
  isExpiringSoon,
  matchesQuery,
  normaliseQuery,
  type FilterableSupply,
} from "@/features/inventory/filter";

const TODAY = "2026-09-08";
const HORIZON_END = "2026-11-07";

function supply(overrides: Partial<FilterableSupply> = {}): FilterableSupply {
  return {
    partId: "p1",
    name: "HEPA filter F7",
    spec: "200×200×46 mm",
    manufacturer: "Parmair",
    productCode: "MAC-F7-200",
    storagePlaceName: "Garage shelf B · Autotalli",
    compatibleAssetNames: ["Ilmanvaihtokone"],
    isKit: false,
    suggest: false,
    onHandMilli: 2000,
    earliestExpiry: null,
    ...overrides,
  };
}

describe("normaliseQuery", () => {
  it("strips diacritics and case", () => {
    expect(normaliseQuery("Ilmanvaihtökone")).toBe("ilmanvaihtokone");
    expect(normaliseQuery("  Sähkö  ")).toBe("sahko");
  });
});

describe("matchesQuery", () => {
  it("matches an empty query", () => {
    expect(matchesQuery(supply(), "")).toBe(true);
    expect(matchesQuery(supply(), "   ")).toBe(true);
  });

  it("finds an item by name, code, manufacturer or specification", () => {
    expect(matchesQuery(supply(), "hepa")).toBe(true);
    expect(matchesQuery(supply(), "mac-f7")).toBe(true);
    expect(matchesQuery(supply(), "parmair")).toBe(true);
    expect(matchesQuery(supply(), "46 mm")).toBe(true);
  });

  it("finds an item by the shelf it is on", () => {
    expect(matchesQuery(supply(), "garage")).toBe(true);
    expect(matchesQuery(supply(), "autotalli")).toBe(true);
  });

  it("finds an item by the equipment it fits", () => {
    expect(matchesQuery(supply(), "ilmanvaihtokone")).toBe(true);
    // And with the diacritic the user actually typed.
    expect(matchesQuery(supply({ compatibleAssetNames: ["Ilmanvaihtökone"] }), "ilmanvaihtokone")).toBe(
      true,
    );
  });

  it("requires every term, so two words narrow rather than widen", () => {
    expect(matchesQuery(supply(), "hepa garage")).toBe(true);
    expect(matchesQuery(supply(), "hepa basement")).toBe(false);
  });

  it("does not match something absent", () => {
    expect(matchesQuery(supply(), "softener salt")).toBe(false);
  });

  it("copes with an item that has nothing but a name", () => {
    const bare = supply({
      spec: null,
      manufacturer: null,
      productCode: null,
      storagePlaceName: null,
      compatibleAssetNames: [],
    });
    expect(matchesQuery(bare, "hepa")).toBe(true);
    expect(matchesQuery(bare, "garage")).toBe(false);
  });
});

describe("isExpiringSoon", () => {
  it("is false when nothing expires", () => {
    expect(isExpiringSoon(null, TODAY, HORIZON_END)).toBe(false);
  });

  it("includes a date inside the horizon", () => {
    expect(isExpiringSoon("2026-10-01", TODAY, HORIZON_END)).toBe(true);
  });

  it("includes a date already past, because that is exactly the row you want", () => {
    expect(isExpiringSoon("2025-01-01", TODAY, HORIZON_END)).toBe(true);
  });

  it("excludes a date beyond the horizon", () => {
    expect(isExpiringSoon("2027-01-01", TODAY, HORIZON_END)).toBe(false);
  });

  it("compares LocalDates as strings, with no timezone arithmetic", () => {
    expect(isExpiringSoon(HORIZON_END, TODAY, HORIZON_END)).toBe(true);
  });
});

describe("applySupplyFilter", () => {
  const rows: FilterableSupply[] = [
    supply({ partId: "low", name: "Softener salt", suggest: true, compatibleAssetNames: [] }),
    supply({ partId: "kit", name: "Filter kit", isKit: true, compatibleAssetNames: [] }),
    supply({
      partId: "expiring",
      name: "Silicone sealant",
      earliestExpiry: "2026-10-01",
      compatibleAssetNames: [],
    }),
    supply({ partId: "fine", name: "HEPA filter F7" }),
  ];
  const options = { query: "", today: TODAY, expiryHorizonEnd: HORIZON_END };

  it("shows only rows worth buying under `low`", () => {
    expect(applySupplyFilter(rows, { ...options, filter: "low" }).map((r) => r.partId)).toEqual([
      "low",
    ]);
  });

  it("shows only expiring rows under `expiring`", () => {
    expect(
      applySupplyFilter(rows, { ...options, filter: "expiring" }).map((r) => r.partId),
    ).toEqual(["expiring"]);
  });

  it("shows only kits under `kits`", () => {
    expect(applySupplyFilter(rows, { ...options, filter: "kits" }).map((r) => r.partId)).toEqual([
      "kit",
    ]);
  });

  it("shows everything under `all`", () => {
    expect(applySupplyFilter(rows, { ...options, filter: "all" })).toHaveLength(4);
  });

  it("applies the search on top of the filter", () => {
    expect(
      applySupplyFilter(rows, { ...options, filter: "all", query: "hepa" }).map((r) => r.partId),
    ).toEqual(["fine"]);
    expect(applySupplyFilter(rows, { ...options, filter: "low", query: "hepa" })).toEqual([]);
  });
});

describe("filterCounts", () => {
  it("counts each filter over the unfiltered rows", () => {
    const counts = filterCounts(
      [
        supply({ partId: "a", suggest: true }),
        supply({ partId: "b", isKit: true }),
        supply({ partId: "c", earliestExpiry: "2026-09-09" }),
        supply({ partId: "d" }),
      ],
      TODAY,
      HORIZON_END,
    );
    expect(counts).toEqual({ low: 1, expiring: 1, kits: 1, all: 4 });
  });

  it("counts a row in every bucket it belongs to", () => {
    const counts = filterCounts(
      [supply({ partId: "a", suggest: true, isKit: true, earliestExpiry: "2026-09-09" })],
      TODAY,
      HORIZON_END,
    );
    expect(counts).toEqual({ low: 1, expiring: 1, kits: 1, all: 1 });
  });
});
