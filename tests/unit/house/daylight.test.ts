import { describe, expect, it } from "vitest";
import {
  adaptDaylightToEnvironment,
  daylightAppearance,
  GLOBAL_ILLUMINATION_BASELINE,
  outdoorLuxValue,
  solarPosition,
} from "@/house/model/daylight";

function utc(value: string): number {
  return Date.parse(value);
}

function expectUnitVector(vector: readonly number[]): void {
  expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
}

describe("solarPosition", () => {
  it("puts the equinox sun near overhead at the equator around solar noon", () => {
    const result = solarPosition(utc("2026-03-20T12:00:00Z"), 0, 0);
    expect(result.elevationDeg).toBeGreaterThan(87);
    expectUnitVector(result.direction);
  });

  it("moves from the eastern morning sky through south to the western evening sky", () => {
    const morning = solarPosition(utc("2026-03-20T08:00:00Z"), 40, 0);
    const noon = solarPosition(utc("2026-03-20T12:00:00Z"), 40, 0);
    const evening = solarPosition(utc("2026-03-20T16:00:00Z"), 40, 0);

    expect(morning.azimuthDeg).toBeGreaterThan(90);
    expect(morning.azimuthDeg).toBeLessThan(180);
    expect(noon.azimuthDeg).toBeGreaterThan(175);
    expect(noon.azimuthDeg).toBeLessThan(185);
    expect(evening.azimuthDeg).toBeGreaterThan(180);
    expect(evening.azimuthDeg).toBeLessThan(270);
    expect(noon.elevationDeg).toBeGreaterThan(morning.elevationDeg);
    expect(noon.elevationDeg).toBeGreaterThan(evening.elevationDeg);
  });

  it("captures the large seasonal elevation difference at high northern latitude", () => {
    const summer = solarPosition(utc("2026-06-21T12:00:00Z"), 65, 0);
    const winter = solarPosition(utc("2026-12-21T12:00:00Z"), 65, 0);

    expect(summer.elevationDeg).toBeGreaterThan(47);
    expect(winter.elevationDeg).toBeLessThan(3);
    expect(summer.elevationDeg - winter.elevationDeg).toBeGreaterThan(45);
  });

  it("uses longitude with an absolute UTC instant", () => {
    const greenwich = solarPosition(utc("2026-03-20T12:00:00Z"), 40, 0);
    const thirtyDegreesEast = solarPosition(utc("2026-03-20T10:00:00Z"), 40, 30);

    // The hour angle matches; the tiny difference comes from declination advancing over two hours.
    expect(thirtyDegreesEast.elevationDeg).toBeCloseTo(greenwich.elevationDeg, 1);
    expect(thirtyDegreesEast.azimuthDeg).toBeCloseTo(greenwich.azimuthDeg, 1);
  });

  it("rotates the model direction by the manifest north bearing", () => {
    const instant = utc("2026-03-20T08:00:00Z");
    const unrotated = solarPosition(instant, 40, 0, 0);
    const quarterTurn = solarPosition(instant, 40, 0, 90);

    expect(quarterTurn.elevationDeg).toBe(unrotated.elevationDeg);
    expect(quarterTurn.azimuthDeg).toBe(unrotated.azimuthDeg);
    expect(quarterTurn.direction[0]).toBeCloseTo(-unrotated.direction[2], 10);
    expect(quarterTurn.direction[1]).toBeCloseTo(unrotated.direction[1], 10);
    expect(quarterTurn.direction[2]).toBeCloseTo(unrotated.direction[0], 10);
  });

  it("returns a below-horizon direction at night", () => {
    const midnight = solarPosition(utc("2026-03-20T00:00:00Z"), 40, 0);
    expect(midnight.elevationDeg).toBeLessThan(-45);
    expect(midnight.direction[1]).toBeLessThan(0);
    expectUnitVector(midnight.direction);
  });

  it("rejects invalid inputs", () => {
    expect(() => solarPosition(Number.NaN, 0, 0)).toThrow(RangeError);
    expect(() => solarPosition(0, 91, 0)).toThrow(RangeError);
    expect(() => solarPosition(0, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("environment-driven daylight", () => {
  const base = daylightAppearance(35);

  it("treats the old 150% rendering level as the calibrated 100% baseline", () => {
    expect(GLOBAL_ILLUMINATION_BASELINE).toBe(1.5);
  });

  it("dims global illumination logarithmically for a dark outdoor lux reading", () => {
    const dim = adaptDaylightToEnvironment(base, { lux: 10 });
    const bright = adaptDaylightToEnvironment(base, { lux: 50_000 });
    expect(dim.ambientIntensity).toBeLessThan(base.ambientIntensity);
    expect(dim.sunIntensity).toBeLessThan(bright.sunIntensity);
    expect(bright.sunIntensity).toBeGreaterThan(base.sunIntensity);
  });

  it("cools and dims daylight for overcast weather", () => {
    const cloudy = adaptDaylightToEnvironment(base, { weather: "cloudy" });
    expect(cloudy.sunIntensity).toBeLessThan(base.sunIntensity);
    expect(cloudy.sunColor).not.toBe(base.sunColor);
    expect(cloudy.skyColor).not.toBe(base.skyColor);
  });

  it("uses calculated daylight unchanged when readings are absent or invalid", () => {
    expect(adaptDaylightToEnvironment(base, {})).toEqual(base);
    expect(adaptDaylightToEnvironment(base, { lux: null, weather: "unavailable" })).toEqual(base);
    expect(adaptDaylightToEnvironment(base, { lux: Number.NaN, weather: "unknown" })).toEqual(base);
  });

  it("normalizes supported lux units and rejects blank, negative, and unknown units", () => {
    expect(outdoorLuxValue(" 25 ", "lx")).toBe(25);
    expect(outdoorLuxValue("1.5", "klx")).toBe(1500);
    expect(outdoorLuxValue("", "lx")).toBeNull();
    expect(outdoorLuxValue("-1", "lx")).toBeNull();
    expect(outdoorLuxValue("25", "fc")).toBeNull();
  });
});

describe("daylightAppearance", () => {
  it("keeps night dark and blue but usable", () => {
    const night = daylightAppearance(-30);
    expect(parseInt(night.skyColor.slice(5, 7), 16)).toBeGreaterThan(parseInt(night.skyColor.slice(1, 3), 16));
    expect(night.sunIntensity).toBe(0);
    expect(night.ambientIntensity).toBeGreaterThan(0);
    expect(night.nightFillIntensity).toBeGreaterThan(0);
    expect(night.ambientIntensity).toBeLessThan(daylightAppearance(35).ambientIntensity / 2);
  });

  it("warms and strengthens the sun through sunrise", () => {
    const horizon = daylightAppearance(0);
    const morning = daylightAppearance(8);
    const day = daylightAppearance(35);
    expect(horizon.sunColor).toBe("#ff9b68");
    expect(morning.sunIntensity).toBeGreaterThan(horizon.sunIntensity);
    expect(day.sunIntensity).toBeGreaterThan(morning.sunIntensity);
    expect(day.nightFillIntensity).toBe(0);
  });

  it("interpolates continuously between elevation stops", () => {
    const before = daylightAppearance(3.99);
    const after = daylightAppearance(4.01);
    expect(Math.abs(after.ambientIntensity - before.ambientIntensity)).toBeLessThan(0.01);
    expect(Math.abs(after.sunIntensity - before.sunIntensity)).toBeLessThan(0.01);
  });

  it("clamps appearance beyond the modeled elevation range", () => {
    expect(daylightAppearance(-90)).toEqual(daylightAppearance(-12));
    expect(daylightAppearance(90)).toEqual(daylightAppearance(70));
  });
});
