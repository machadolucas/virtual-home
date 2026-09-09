import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOLAR_PANEL_CONFIG,
  isSolarPanelConfig,
  solarPanelConfigFromJson,
} from "@/house/model/solarPanel";

describe("solar-panel config", () => {
  it("accepts the defaults and inclusive limits", () => {
    expect(isSolarPanelConfig(DEFAULT_SOLAR_PANEL_CONFIG)).toBe(true);
    expect(
      isSolarPanelConfig({ widthM: 0.1, lengthM: 10, thicknessM: 0.005, tiltDeg: -90 }),
    ).toBe(true);
  });

  it.each([
    ["NaN", { ...DEFAULT_SOLAR_PANEL_CONFIG, widthM: Number.NaN }],
    ["positive infinity", { ...DEFAULT_SOLAR_PANEL_CONFIG, lengthM: Number.POSITIVE_INFINITY }],
    ["negative infinity", { ...DEFAULT_SOLAR_PANEL_CONFIG, tiltDeg: Number.NEGATIVE_INFINITY }],
    ["width below range", { ...DEFAULT_SOLAR_PANEL_CONFIG, widthM: 0.099 }],
    ["length above range", { ...DEFAULT_SOLAR_PANEL_CONFIG, lengthM: 10.001 }],
    ["thickness below range", { ...DEFAULT_SOLAR_PANEL_CONFIG, thicknessM: 0.004 }],
    ["tilt above range", { ...DEFAULT_SOLAR_PANEL_CONFIG, tiltDeg: 90.001 }],
  ])("rejects %s", (_label, config) => {
    expect(isSolarPanelConfig(config)).toBe(false);
  });

  it("does not expose malformed database JSON as panel dimensions", () => {
    expect(solarPanelConfigFromJson("not json")).toBeNull();
    expect(solarPanelConfigFromJson('{"widthM":null}')).toBeNull();
  });
});
