import { describe, expect, it } from "vitest";
import { classifyState, type EntityState } from "@/house/store/haStore";

describe("Home Assistant state freshness", () => {
  it("keeps stable event-driven light state current while the stream is open", () => {
    const light: EntityState = {
      entityId: "light.porch",
      state: "on",
      lastUpdated: 1,
    };
    expect(classifyState(light, "open", 7 * 24 * 60 * 60_000)).toBe("live");
    expect(classifyState(light, "closed", 7 * 24 * 60 * 60_000)).toBe("disconnected");
    expect(classifyState({ ...light, state: "unavailable" }, "open", 7 * 24 * 60 * 60_000))
      .toBe("unavailable");
  });

  it("still marks a silent sampled sensor stale", () => {
    expect(classifyState({ entityId: "sensor.temperature", state: "21", lastUpdated: 1 }, "open", 7 * 60 * 60_000))
      .toBe("stale");
  });

  it("expires outdoor illuminance quickly and weather on a two-hour cadence", () => {
    expect(classifyState({ entityId: "sensor.outdoor_lux", state: "200", lastUpdated: 1, deviceClass: "illuminance" }, "open", 31 * 60_000))
      .toBe("stale");
    expect(classifyState({ entityId: "weather.home", state: "cloudy", lastUpdated: 1 }, "open", 119 * 60_000))
      .toBe("live");
    expect(classifyState({ entityId: "weather.home", state: "cloudy", lastUpdated: 1 }, "open", 121 * 60_000))
      .toBe("stale");
  });

  it("never treats unknown or unavailable outdoor readings as live values", () => {
    const sensor: EntityState = { entityId: "sensor.outdoor_lux", state: "unknown", lastUpdated: 1, deviceClass: "illuminance" };
    expect(classifyState(sensor, "open", 1000)).toBe("unknown");
    expect(classifyState({ ...sensor, state: "unavailable" }, "open", 1000)).toBe("unavailable");
  });
});

it("keeps event-driven climate status live while connected without inventing unavailable readings", () => {
  const climate: EntityState = { entityId: "climate.pump", state: "heat", lastUpdated: 1 };
  expect(classifyState(climate, "open", 7 * 86400000)).toBe("live");
  expect(classifyState({ ...climate, state: "unavailable" }, "open", 7 * 86400000)).toBe("unavailable");
});
