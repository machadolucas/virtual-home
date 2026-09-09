import { describe, expect, it } from "vitest";
import {
  aimFromTarget,
  defaultLightAim,
  directionFromAim,
  isLightEntity,
  lightAppearance,
  lightDirection,
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
    expect(lightAppearance({ entityId: "light.lamp", state: "on" })).toEqual({
      intensity: 1,
      color: [1, 1, 1],
    });
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
  it("uses vertical defaults for downlights, spike spots, and other light symbols", () => {
    expect(defaultLightAim("downlight")).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expect(defaultLightAim("spike_spot")).toEqual({ yawDeg: 0, pitchDeg: 90 });
    expect(defaultLightAim("wall_lamp")).toEqual({ yawDeg: 0, pitchDeg: -90 });
    expectDirection(lightDirection("downlight", null), [0, -1, 0]);
    expectDirection(lightDirection("spike_spot", null), [0, 1, 0]);
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
