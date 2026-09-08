/**
 * The 3D background's pure layer: the schema that guards the column (which deliberately has no
 * CHECK), the style the canvas host paints, and the fallback for a stored value that no longer
 * parses.
 *
 * `src/house/model/background.ts` is imported by the viewer, by the settings page and by the server
 * action, so these tests also pin the thing that keeps that possible: it stays pure, with no three,
 * no DOM and no database.
 */
import { describe, expect, it } from "vitest";
import {
  backgroundStyle,
  houseBackgroundSchema,
  parseHouseBackground,
  presetIdOf,
  sameBackground,
  DEFAULT_GRADIENT_ANGLE_DEG,
  DEFAULT_HOUSE_BACKGROUND,
  HOUSE_BACKGROUND_PRESETS,
  type HouseBackground,
} from "@/house/model/background";

describe("houseBackgroundSchema", () => {
  it("accepts the three modes", () => {
    expect(houseBackgroundSchema.safeParse({ mode: "theme" }).success).toBe(true);
    expect(houseBackgroundSchema.safeParse({ mode: "solid", color: "#14161a" }).success).toBe(true);
    expect(
      houseBackgroundSchema.safeParse({ mode: "gradient", from: "#1b2430", to: "#0b0d10" }).success,
    ).toBe(true);
    expect(
      houseBackgroundSchema.safeParse({
        mode: "gradient",
        from: "#1b2430",
        to: "#0b0d10",
        angleDeg: 90,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(houseBackgroundSchema.safeParse({ mode: "texture", url: "/x.png" }).success).toBe(false);
    expect(houseBackgroundSchema.safeParse({ mode: "" }).success).toBe(false);
    expect(houseBackgroundSchema.safeParse({}).success).toBe(false);
  });

  it("rejects anything that is not a lowercase #rrggbb", () => {
    for (const color of ["#FFF", "#FFFFFF", "fff000", "#12345", "#1234567", "red", ""])
      expect(
        houseBackgroundSchema.safeParse({ mode: "solid", color }).success,
        `expected ${JSON.stringify(color)} to be rejected`,
      ).toBe(false);
    // Uppercase is rejected on purpose: one spelling per colour, so preset matching stays exact.
    expect(houseBackgroundSchema.safeParse({ mode: "solid", color: "#ABCDEF" }).success).toBe(false);
    // Surrounding whitespace is trimmed, the same way `updateDisplayColorInput` trims it.
    const trimmed = houseBackgroundSchema.safeParse({ mode: "solid", color: " #abcdef " });
    expect(trimmed.success).toBe(true);
    expect(trimmed.success && trimmed.data).toEqual({ mode: "solid", color: "#abcdef" });
  });

  it("rejects a colour missing from a gradient", () => {
    expect(houseBackgroundSchema.safeParse({ mode: "gradient", from: "#1b2430" }).success).toBe(
      false,
    );
    expect(
      houseBackgroundSchema.safeParse({ mode: "gradient", from: "#1b2430", to: "nope" }).success,
    ).toBe(false);
  });

  it("bounds angleDeg to one whole turn", () => {
    const gradient = { mode: "gradient", from: "#1b2430", to: "#0b0d10" };
    expect(houseBackgroundSchema.safeParse({ ...gradient, angleDeg: 0 }).success).toBe(true);
    expect(houseBackgroundSchema.safeParse({ ...gradient, angleDeg: 360 }).success).toBe(true);
    expect(houseBackgroundSchema.safeParse({ ...gradient, angleDeg: -1 }).success).toBe(false);
    expect(houseBackgroundSchema.safeParse({ ...gradient, angleDeg: 361 }).success).toBe(false);
    expect(houseBackgroundSchema.safeParse({ ...gradient, angleDeg: 45.5 }).success).toBe(false);
  });

  it("accepts every preset it ships", () => {
    for (const preset of HOUSE_BACKGROUND_PRESETS)
      expect(
        houseBackgroundSchema.safeParse(preset.value).success,
        `preset ${preset.id} must be storable`,
      ).toBe(true);
  });
});

describe("backgroundStyle", () => {
  it("paints nothing for the theme, so the bg-viewport token stays in charge", () => {
    expect(backgroundStyle({ mode: "theme" })).toEqual({});
  });

  it("paints a solid as backgroundColor", () => {
    expect(backgroundStyle({ mode: "solid", color: "#14161a" })).toEqual({
      backgroundColor: "#14161a",
    });
  });

  it("paints a gradient with both stops and the angle", () => {
    const style = backgroundStyle({
      mode: "gradient",
      from: "#1b2430",
      to: "#0b0d10",
      angleDeg: 45,
    });
    expect(style.backgroundImage).toBe("linear-gradient(45deg, #1b2430 0%, #0b0d10 100%)");
    // No backgroundColor: the token underneath shows through anywhere the gradient does not cover.
    expect(style.backgroundColor).toBeUndefined();
  });

  it("defaults a gradient to top-to-bottom", () => {
    const style = backgroundStyle({ mode: "gradient", from: "#aabbcc", to: "#112233" });
    expect(style.backgroundImage).toBe(
      `linear-gradient(${DEFAULT_GRADIENT_ANGLE_DEG}deg, #aabbcc 0%, #112233 100%)`,
    );
  });
});

describe("parseHouseBackground", () => {
  it("treats NULL as following the theme, and does not call that malformed", () => {
    expect(parseHouseBackground(null)).toEqual({
      background: DEFAULT_HOUSE_BACKGROUND,
      malformed: false,
    });
    expect(parseHouseBackground(undefined).malformed).toBe(false);
  });

  it("round-trips a stored JSON string", () => {
    const stored = JSON.stringify({ mode: "solid", color: "#14161a" });
    expect(parseHouseBackground(stored)).toEqual({
      background: { mode: "solid", color: "#14161a" },
      malformed: false,
    });
  });

  it("falls back to the theme and reports a malformed value", () => {
    for (const value of ["not json", "{}", '{"mode":"solid"}', '{"mode":"solid","color":"red"}', "[]"]) {
      const result = parseHouseBackground(value);
      expect(result.background, `value ${value}`).toEqual(DEFAULT_HOUSE_BACKGROUND);
      expect(result.malformed, `value ${value}`).toBe(true);
    }
  });
});

describe("sameBackground and presetIdOf", () => {
  it("ignores key order and treats a missing angle as the default", () => {
    const a: HouseBackground = { mode: "gradient", from: "#1b2430", to: "#0b0d10" };
    const b: HouseBackground = { mode: "gradient", to: "#0b0d10", from: "#1b2430", angleDeg: 180 };
    expect(sameBackground(a, b)).toBe(true);
  });

  it("separates the modes", () => {
    expect(sameBackground({ mode: "theme" }, { mode: "solid", color: "#14161a" })).toBe(false);
    expect(
      sameBackground({ mode: "solid", color: "#14161a" }, { mode: "solid", color: "#14161b" }),
    ).toBe(false);
  });

  it("names a preset, and returns null for a hand-picked colour", () => {
    expect(presetIdOf(DEFAULT_HOUSE_BACKGROUND)).toBe("theme");
    const preset = HOUSE_BACKGROUND_PRESETS[1];
    expect(preset).toBeDefined();
    expect(presetIdOf(preset!.value)).toBe(preset!.id);
    expect(presetIdOf({ mode: "solid", color: "#010203" })).toBeNull();
  });

  it("gives every preset a distinct id and an honest label", () => {
    const ids = HOUSE_BACKGROUND_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(HOUSE_BACKGROUND_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(HOUSE_BACKGROUND_PRESETS.length).toBeLessThanOrEqual(5);
    for (const preset of HOUSE_BACKGROUND_PRESETS) expect(preset.label.length).toBeGreaterThan(3);
  });
});
