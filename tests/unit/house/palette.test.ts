/**
 * The viewer's chrome palette: reading the live tokens, and behaving under SSR and in a test where
 * there is no stylesheet to read.
 *
 * The property under test is the one that matters for the defect: nothing in the scene's chrome is
 * a baked-in light-scene colour any more, and nothing throws when the tokens are unreadable.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getViewerPalette,
  onPaletteChange,
  parseHex,
  readViewerPalette,
  refreshViewerPalette,
  resetViewerPalette,
  setViewerPalette,
  subscribeToPalette,
  PALETTE_FALLBACK,
} from "@/house/scene/palette";

afterEach(() => {
  resetViewerPalette();
});

describe("parseHex", () => {
  it("reads #rrggbb and #rgb", () => {
    expect(parseHex("#2f5fd0")).toBe(0x2f5fd0);
    expect(parseHex("  #2f5fd0 ")).toBe(0x2f5fd0);
    expect(parseHex("#ABC")).toBe(0xaabbcc);
  });

  it("returns null rather than guessing", () => {
    for (const value of ["", "  ", "2f5fd0", "#12", "#12345", "rgb(0,0,0)", "oklch(0.5 0.1 240)"])
      expect(parseHex(value), value).toBeNull();
  });
});

describe("readViewerPalette", () => {
  it("falls back to the shipped values with no document (SSR, unit tests)", () => {
    // Vitest runs in Node here: there is no `document`, which is exactly the SSR case.
    expect(typeof document).toBe("undefined");
    expect(readViewerPalette()).toEqual(PALETTE_FALLBACK);
  });

  it("covers every marker state class", () => {
    const palette = readViewerPalette();
    for (const key of Object.keys(PALETTE_FALLBACK.marker))
      expect(palette.marker[key as keyof typeof palette.marker], key).toBeTypeOf("number");
  });
});

describe("the current palette", () => {
  it("starts at the fallback and keeps a stable identity until something changes", () => {
    expect(getViewerPalette()).toEqual(PALETTE_FALLBACK);
    const first = getViewerPalette();
    expect(refreshViewerPalette()).toBe(false); // nothing to read, nothing moved
    expect(getViewerPalette()).toBe(first);
  });

  it("reports whether a change actually happened, so one change costs one invalidate", () => {
    const dark = { ...PALETTE_FALLBACK, selectEmissive: 0x3b6fe0 };
    expect(setViewerPalette(dark)).toBe(true);
    expect(getViewerPalette().selectEmissive).toBe(0x3b6fe0);
    // The same values again is not a change, even as a different object.
    expect(setViewerPalette({ ...dark })).toBe(false);
  });

  it("notices a marker colour moving on its own", () => {
    const next = {
      ...PALETTE_FALLBACK,
      marker: { ...PALETTE_FALLBACK.marker, stale: 0x8fa8ba },
    };
    expect(setViewerPalette(next)).toBe(true);
    expect(setViewerPalette({ ...next, marker: { ...next.marker } })).toBe(false);
  });

  it("notifies subscribers exactly once per real change", () => {
    let calls = 0;
    const unsubscribe = onPaletteChange(() => {
      calls += 1;
    });
    setViewerPalette({ ...PALETTE_FALLBACK, snap: 0x123456 });
    setViewerPalette({ ...PALETTE_FALLBACK, snap: 0x123456 });
    unsubscribe();
    setViewerPalette({ ...PALETTE_FALLBACK, snap: 0x654321 });
    expect(calls).toBe(1);
  });
});

describe("subscribeToPalette", () => {
  it("is a no-op without a window, and its teardown is safe to call", () => {
    const unsubscribe = subscribeToPalette(() => {
      throw new Error("must not be called without a window");
    });
    expect(() => unsubscribe()).not.toThrow();
  });
});
