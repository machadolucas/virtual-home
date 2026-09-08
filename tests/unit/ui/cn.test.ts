import { describe, expect, it } from "vitest";
import { cn, focusRing, focusRingInset } from "@/ui/cn";

describe("cn", () => {
  it("joins strings and drops falsy values", () => {
    expect(cn("a", "b")).toBe("a b");
    expect(cn("a", null, undefined, false, "", "b")).toBe("a b");
    expect(cn()).toBe("");
  });

  it("normalises whitespace inside a single argument", () => {
    expect(cn("  a   b  ", "\tc\nd ")).toBe("a b c d");
  });

  it("flattens nested arrays, including conditional entries", () => {
    expect(cn(["a", ["b", ["c"]]])).toBe("a b c");
    expect(cn("base", [false && "off", "on"])).toBe("base on");
  });

  it("keeps object keys whose value is truthy", () => {
    expect(cn({ a: true, b: false, c: undefined, d: null, e: true })).toBe("a e");
  });

  it("preserves order so a later class can override an earlier one", () => {
    // The whole point of not using tailwind-merge: last one wins in the
    // stylesheet, and callers rely on their className being appended last.
    expect(cn("px-2", "px-4")).toBe("px-2 px-4");
  });

  it("accepts numbers (grid spans, z indices built from variables)", () => {
    expect(cn("col-span", 2)).toBe("col-span 2");
  });

  it("mixes every supported shape at once", () => {
    expect(cn("a", ["b", { c: true, d: false }], undefined, [[["e"]]])).toBe("a b c e");
  });

  it("exports focus helpers that never remove the indicator", () => {
    for (const helper of [focusRing, focusRingInset]) {
      expect(helper).toContain("focus-visible:outline-2");
      expect(helper).toContain("focus-visible:outline-ring");
      expect(helper).not.toContain("outline-none");
    }
  });
});
