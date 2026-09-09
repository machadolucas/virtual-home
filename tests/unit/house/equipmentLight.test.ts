import { describe, expect, it } from "vitest";
import {
  aimFromTarget,
  DEFAULT_LIGHT_COLOR_KELVIN,
  defaultLightAim,
  directionFromAim,
  isLightEntity,
  isSpotlightSymbol,
  lightAppearance,
  lightDirection,
  lightSourceOffset,
  lightSourcePosition,
} from "@/house/model/equipmentLight";

function expectDirection(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(3);
  for (let index = 0; index < 3; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index]!, 9);
  }
}

describe("Home Assistant light appearance", () => {
  it("recognizes the entity domain rather than inferring a light from equipment category", () => {
    expect(isLightEntity("light.kitchen_pendant")).toBe(true);
    expect(isLightEntity("switch.kitchen_pendant")).toBe(false);
    expect(isLightEntity("light.")).toBe(false);

    expect(lightAppearance({ entityId: "switch.lamp", state: "on" })).toBeNull();
    const uncoloured = lightAppearance({ entityId: "light.lamp", state: "on" });
    const explicitWarm = lightAppearance({
      entityId: "light.lamp",
      state: "on",
      colorTempKelvin: DEFAULT_LIGHT_COLOR_KELVIN,
    });
    expect(uncoloured).toEqual(explicitWarm);
    expect(uncoloured?.color[0]).toBe(1);
    expect(uncoloured?.color[2]).toBeLessThan(uncoloured?.color[1] ?? 0);
  });

  it.each(["off", "unknown", "unavailable"])("does not emit for %s", (state) => {
    expect(lightAppearance({ entityId: "light.desk", state })).toBeNull();
  });

  it("does not emit from disconnected or stale input", () => {
    expect(lightAppearance({ entityId: "light.desk", state: "on", live: false })).toBeNull();
  });

  it("clamps HA brightness to a normalized intensity", () => {
    expect(lightAppearance({ entityId: "light.desk", state: "on", brightness: 0 })?.intensity).toBe(0);
    expect(lightAppearance({ entityId: "light.desk", state: "on", brightness: 128 })?.intensity).toBeCloseTo(
      128 / 255,
      9,
    );
    expect(lightAppearance({ entityId: "light.desk", state: "on", brightness: 999 })?.intensity).toBe(1);
  });

  it("normalizes RGB and gives it precedence over other HA color representations", () => {
    expect(
      lightAppearance({
        entityId: "light.desk",
        state: "on",
        rgbColor: [255, 128, -5],
        hsColor: [120, 100],
        colorTempKelvin: 2_000,
      })?.color,
    ).toEqual([1, 128 / 255, 0]);
  });

  it("converts hue and saturation to normalized RGB", () => {
    expect(
      lightAppearance({ entityId: "light.desk", state: "on", hsColor: [120, 100] })?.color,
    ).toEqual([0, 1, 0]);
    expect(
      lightAppearance({ entityId: "light.desk", state: "on", hsColor: [240, 50] })?.color,
    ).toEqual([0.5, 0.5, 1]);
  });

  it("converts Kelvin and legacy mired color temperatures consistently", () => {
    const kelvin = lightAppearance({
      entityId: "light.desk",
      state: "on",
      colorTempKelvin: 4_000,
    })?.color;
    const mired = lightAppearance({
      entityId: "light.desk",
      state: "on",
      colorTempMireds: 250,
    })?.color;
    expect(mired).toEqual(kelvin);
    expect(kelvin?.[0]).toBe(1);
    expect(kelvin?.[1]).toBeGreaterThan(0.7);
    expect(kelvin?.[2]).toBeLessThan(kelvin?.[1] ?? 0);
  });
});

describe("equipment light direction", () => {
  it("classifies every adjustable spot through one shared helper", () => {
    expect(["wall_spot", "floor_spot", "ceiling_spot", "spike_spot", "downlight"].every(isSpotlightSymbol)).toBe(true);
    expect(isSpotlightSymbol("wall_lamp")).toBe(false);
    expect(isSpotlightSymbol(null)).toBe(false);
  });

  it("uses mount-aware defaults for adjustable spots", () => {
    expect(defaultLightAim("downlight")).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expect(defaultLightAim("spike_spot")).toEqual({ yawDeg: 0, pitchDeg: 90 });
    expect(defaultLightAim("ceiling_spot", 30)).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expect(defaultLightAim("wall_spot", 30)).toEqual({ yawDeg: 30, pitchDeg: 0 });
    expect(defaultLightAim("floor_spot", -20)).toEqual({ yawDeg: -20, pitchDeg: -45 });
    expect(defaultLightAim("wall_lamp")).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expectDirection(lightDirection("downlight", null), [0, -1, 0]);
    expectDirection(lightDirection("spike_spot", null), [0, 1, 0]);
    expectDirection(lightDirection("wall_spot", null, 90), [1, 0, 0]);
    expectDirection(lightDirection("wall_spot", { yawDeg: -90, pitchDeg: 0 }, 90), [-1, 0, 0]);
  });

  it("places emitters at their visible heads and rotates local offsets with the body", () => {
    expectDirection(lightSourceOffset("lamp_post"), [0, 0.587, 0]);
    expectDirection(lightSourceOffset("wall_spot"), [0, 0.045, 0.078]);
    expectDirection(lightSourceOffset("wall_spot", 90), [0.078, 0.045, 0]);
    expectDirection(lightSourceOffset("floor_spot"), [0, 0.35, 0.035]);
    expectDirection(lightSourceOffset("ceiling_spot"), [0.024, -0.088, 0]);
    expectDirection(lightSourcePosition([2, 3, 4], "lamp_post", 0, 1.5), [2, 5.087, 4]);
  });

  it("maps yaw around +Y and pitch from the horizontal", () => {
    expectDirection(directionFromAim({ yawDeg: 0, pitchDeg: 0 }), [0, 0, 1]);
    expectDirection(directionFromAim({ yawDeg: 90, pitchDeg: 0 }), [1, 0, 0]);
    expectDirection(directionFromAim({ yawDeg: -90, pitchDeg: 0 }), [-1, 0, 0]);
    expectDirection(directionFromAim({ yawDeg: 42, pitchDeg: -90 }), [0, -1, 0]);
  });

  it("derives persisted aim angles from a physical target point", () => {
    expect(aimFromTarget([1, 2, 3], [1, 2, 8])).toEqual({ yawDeg: 0, pitchDeg: 0 });
    expect(aimFromTarget([1, 2, 3], [6, 2, 3])).toEqual({ yawDeg: 90, pitchDeg: 0 });
    expect(aimFromTarget([1, 2, 3], [1, -3, 3])).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expect(aimFromTarget([1, 2, 3], [1, 2, 3])).toBeNull();

    const aim = aimFromTarget([0, 0, 0], [2, 3, -4]);
    expect(aim).not.toBeNull();
    const direction = directionFromAim(aim!);
    const length = Math.hypot(2, 3, -4);
    expectDirection(direction, [2 / length, 3 / length, -4 / length]);
  });
});
