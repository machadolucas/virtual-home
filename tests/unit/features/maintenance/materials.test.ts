/**
 * Material pre-fill and the short-line diff.
 *
 * This arithmetic decides whether the completion form asks the §5.3 question. Getting it wrong in
 * either direction is bad: too eager and the user is interrogated about stock that is fine, too
 * lax and the server refuses a form that looked ready.
 */
import { describe, expect, it } from "vitest";
import {
  describeSource,
  describeStock,
  diffMaterials,
  formatQty,
  missingRequired,
  parseQty,
  prefillMaterials,
  qtyStep,
  resolutionsComplete,
  shortLines,
  type MaterialLine,
} from "@/features/maintenance/materials";

function line(overrides: Partial<MaterialLine> & { partId: string }): MaterialLine {
  return {
    partName: `Part ${overrides.partId}`,
    spec: null,
    unit: "pcs",
    trackingMode: "discrete",
    expectedQtyMilli: 2000,
    isRequired: true,
    source: "plan",
    availableMilli: 5000,
    ...overrides,
  };
}

describe("prefillMaterials", () => {
  it("starts from what is expected — never from zero", () => {
    const lines = [line({ partId: "filter", expectedQtyMilli: 2000 }), line({ partId: "seal", expectedQtyMilli: 1000 })];
    expect(prefillMaterials(lines)).toEqual([
      { partId: "filter", actualQtyMilli: 2000 },
      { partId: "seal", actualQtyMilli: 1000 },
    ]);
  });
});

describe("diffMaterials", () => {
  it("reports the delta against what was expected", () => {
    const lines = [line({ partId: "filter", expectedQtyMilli: 2000 })];
    const rows = diffMaterials(lines, [{ partId: "filter", actualQtyMilli: 3000 }]);
    expect(rows[0]).toMatchObject({
      expectedQtyMilli: 2000,
      actualQtyMilli: 3000,
      deltaMilli: 1000,
      isShort: false,
      shortfallMilli: 0,
    });
  });

  it("records zero used as a real answer, not as a missing value", () => {
    const lines = [line({ partId: "filter", expectedQtyMilli: 2000 })];
    const rows = diffMaterials(lines, [{ partId: "filter", actualQtyMilli: 0 }]);
    expect(rows[0]).toMatchObject({ actualQtyMilli: 0, deltaMilli: -2000, isShort: false });
  });

  it("computes the shortfall against the ledger, not against the expectation", () => {
    const lines = [line({ partId: "filter", expectedQtyMilli: 2000, availableMilli: 1000 })];
    const rows = diffMaterials(lines, [{ partId: "filter", actualQtyMilli: 2000 }]);
    expect(rows[0]).toMatchObject({ availableMilli: 1000, shortfallMilli: 1000, isShort: true });
  });

  it("does not call a line short when less was used than the shelf holds", () => {
    const lines = [line({ partId: "filter", expectedQtyMilli: 4000, availableMilli: 1000 })];
    const rows = diffMaterials(lines, [{ partId: "filter", actualQtyMilli: 1000 }]);
    expect(rows[0]?.isShort).toBe(false);
  });

  it("keeps a part the user added that nothing expected", () => {
    const rows = diffMaterials([], [{ partId: "surprise", actualQtyMilli: 1000 }]);
    expect(rows[0]).toMatchObject({
      partId: "surprise",
      expectedQtyMilli: 0,
      availableMilli: 0,
      shortfallMilli: 1000,
      isShort: true,
    });
  });

  it("only exposes a resolution on a line that is actually short", () => {
    const lines = [line({ partId: "filter", availableMilli: 5000 })];
    const rows = diffMaterials(lines, [
      { partId: "filter", actualQtyMilli: 2000, resolutionIfShort: "adjust_up" },
    ]);
    expect(rows[0]?.resolutionIfShort).toBeNull();
  });
});

describe("shortLines and resolutionsComplete", () => {
  const lines = [
    line({ partId: "filter", expectedQtyMilli: 2000, availableMilli: 1000 }),
    line({ partId: "seal", expectedQtyMilli: 1000, availableMilli: 4000 }),
  ];

  it("a form with enough stock everywhere is submittable untouched", () => {
    const rows = diffMaterials(
      [line({ partId: "seal", expectedQtyMilli: 1000, availableMilli: 4000 })],
      [{ partId: "seal", actualQtyMilli: 1000 }],
    );
    expect(shortLines(rows)).toHaveLength(0);
    expect(resolutionsComplete(rows)).toBe(true);
  });

  it("a short line without a choice blocks; with a choice it does not", () => {
    const without = diffMaterials(lines, [
      { partId: "filter", actualQtyMilli: 2000 },
      { partId: "seal", actualQtyMilli: 1000 },
    ]);
    expect(shortLines(without).map((row) => row.partId)).toEqual(["filter"]);
    expect(resolutionsComplete(without)).toBe(false);

    const withChoice = diffMaterials(lines, [
      { partId: "filter", actualQtyMilli: 2000, resolutionIfShort: "consume_available" },
      { partId: "seal", actualQtyMilli: 1000 },
    ]);
    expect(resolutionsComplete(withChoice)).toBe(true);
  });
});

describe("missingRequired", () => {
  it("flags a required line that was zeroed out, and ignores an optional one", () => {
    const lines = [
      line({ partId: "filter", isRequired: true }),
      line({ partId: "extra", isRequired: false }),
    ];
    const missing = missingRequired(lines, [
      { partId: "filter", actualQtyMilli: 0 },
      { partId: "extra", actualQtyMilli: 0 },
    ]);
    expect(missing.map((row) => row.partId)).toEqual(["filter"]);
  });
});

describe("quantity formatting", () => {
  it("renders thousandths as whole units", () => {
    expect(formatQty(2000, "pcs")).toBe("2 pcs");
    expect(formatQty(0, "pcs")).toBe("0 pcs");
    expect(formatQty(1500, "l")).toBe("1.5 l");
    expect(formatQty(1250, "kg")).toBe("1.25 kg");
  });

  it("parses back into thousandths, and refuses anything that is not a quantity", () => {
    expect(parseQty("2")).toBe(2000);
    expect(parseQty("1.5")).toBe(1500);
    expect(parseQty("1,5")).toBe(1500);
    expect(parseQty("0")).toBe(0);
    expect(parseQty("")).toBeNull();
    expect(parseQty("-1")).toBeNull();
    expect(parseQty("two")).toBeNull();
    // Four decimals would be sub-thousandth precision the schema cannot hold.
    expect(parseQty("1.2345")).toBeNull();
  });

  it("steps by whole units for a discrete part", () => {
    expect(qtyStep("discrete")).toBe(1);
    expect(qtyStep("measured")).toBe(0.001);
  });
});

describe("provenance wording", () => {
  it("explains why a line is pre-filled", () => {
    expect(describeSource("plan")).toBe("From this plan");
    expect(describeSource("asset_consumable")).toBe("What this unit consumes");
    expect(describeSource("condition_rule")).toBe("Default part for this alert");
  });

  it("states the balance without claiming it is enough", () => {
    expect(describeStock(line({ partId: "a", expectedQtyMilli: 2000, availableMilli: 1000 }))).toEqual({
      text: "1 pcs in stock",
      sufficient: false,
    });
  });
});
