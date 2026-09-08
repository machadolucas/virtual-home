/**
 * Unit formatting for milli quantities.
 *
 * The invariant these tests protect: the number a person types and the number the ledger stores
 * round-trip, and a whole amount never grows a decimal tail. `2000` reading as `"2.000 pcs"` looks
 * like a precision claim nobody made.
 */
import { describe, expect, it } from "vitest";
import {
  MILLI,
  formatMilli,
  formatQuantity,
  formatSignedQuantity,
  isWholeUnit,
  parseQuantityToMilli,
  stockDisplay,
} from "@/features/inventory/units";

describe("formatMilli", () => {
  it("prints a whole amount with no decimal tail", () => {
    expect(formatMilli(2000, "pcs")).toBe("2");
    expect(formatMilli(1000, "l")).toBe("1");
    expect(formatMilli(0, "kg")).toBe("0");
  });

  it("keeps the thousandths a fractional amount actually has", () => {
    expect(formatMilli(750, "l")).toBe("0.75");
    expect(formatMilli(1500, "kg")).toBe("1.5");
    expect(formatMilli(1, "l")).toBe("0.001");
  });

  it("prints negatives, because a negative balance is a real state", () => {
    expect(formatMilli(-2000, "pcs")).toBe("-2");
    expect(formatMilli(-500, "l")).toBe("-0.5");
  });

  it("rounds units that have no meaningful fraction", () => {
    // A fractional millilitre is noise: `ml` is already the small unit.
    expect(formatMilli(2500, "ml")).toBe("3");
    expect(formatMilli(1200, "g")).toBe("1");
  });
});

describe("formatQuantity", () => {
  it("appends the unit", () => {
    expect(formatQuantity(2000, "pcs")).toBe("2 pcs");
    expect(formatQuantity(750, "l")).toBe("0.75 l");
  });

  it("counts a kit in kits, singular and plural", () => {
    expect(formatQuantity(1000, "pcs", true)).toBe("1 kit");
    expect(formatQuantity(2000, "pcs", true)).toBe("2 kits");
    expect(formatQuantity(0, "pcs", true)).toBe("0 kits");
    // One kit short is still "1 kit", with the sign carried by the caller.
    expect(formatQuantity(-1000, "pcs", true)).toBe("-1 kit");
  });

  it("uses the kit wording even when the part's unit is not pcs", () => {
    expect(formatQuantity(2000, "l", true)).toBe("2 kits");
  });
});

describe("formatSignedQuantity", () => {
  it("uses a real minus sign, not a hyphen", () => {
    expect(formatSignedQuantity(-2000, "pcs")).toBe("−2 pcs");
    expect(formatSignedQuantity(2000, "pcs")).toBe("+2 pcs");
  });
});

describe("parseQuantityToMilli", () => {
  it("round-trips whole and fractional amounts", () => {
    expect(parseQuantityToMilli("2")).toBe(2000);
    expect(parseQuantityToMilli("0.75")).toBe(750);
    expect(parseQuantityToMilli("1.5")).toBe(1500);
  });

  it("accepts a comma, because a Finnish keyboard produces one", () => {
    expect(parseQuantityToMilli("0,75")).toBe(750);
    expect(parseQuantityToMilli("1,5")).toBe(1500);
  });

  it("returns null for an empty or unparseable field rather than guessing zero", () => {
    expect(parseQuantityToMilli("")).toBeNull();
    expect(parseQuantityToMilli("   ")).toBeNull();
    expect(parseQuantityToMilli("two")).toBeNull();
    expect(parseQuantityToMilli("1.2.3")).toBeNull();
    expect(parseQuantityToMilli("1e3")).toBeNull();
  });

  it("rounds to the nearest thousandth rather than storing a float", () => {
    expect(parseQuantityToMilli("0.3333")).toBe(333);
    expect(Number.isInteger(parseQuantityToMilli("0.1") as number)).toBe(true);
  });

  it("survives the round trip for every fraction a unit can show", () => {
    for (const raw of ["0", "0.5", "0.001", "12.345", "-3.25"]) {
      const milli = parseQuantityToMilli(raw);
      expect(milli).not.toBeNull();
      expect(parseQuantityToMilli(formatMilli(milli as number, "l"))).toBe(milli);
    }
  });
});

describe("isWholeUnit", () => {
  it("is the discrete-part invariant", () => {
    expect(isWholeUnit(2000)).toBe(true);
    expect(isWholeUnit(0)).toBe(true);
    expect(isWholeUnit(-1000)).toBe(true);
    expect(isWholeUnit(1500)).toBe(false);
    expect(isWholeUnit(1)).toBe(false);
  });

  it("agrees with the ledger's own multiple-of-1000 rule", () => {
    expect(MILLI).toBe(1000);
  });
});

describe("stockDisplay", () => {
  it("calls a negative balance negative rather than clamping it to zero", () => {
    const display = stockDisplay(-1000, "pcs", false, 2000);
    expect(display.tone).toBe("negative");
    expect(display.label).toBe("-1 pcs");
  });

  it("distinguishes empty from low", () => {
    expect(stockDisplay(0, "pcs", false, 2000).tone).toBe("empty");
    expect(stockDisplay(1000, "pcs", false, 2000).tone).toBe("low");
    expect(stockDisplay(2000, "pcs", false, 2000).tone).toBe("ok");
  });

  it("is never low when no threshold is set", () => {
    expect(stockDisplay(1000, "pcs", false, null).tone).toBe("ok");
  });
});
