import { describe, expect, it, vi } from "vitest";
import { createHouseStore } from "@/house/store/createHouseStore";
import { rememberRenderingPreferences, RENDERING_PREFERENCES_KEY, resetRenderingPreferences, restoreRenderingPreferences } from "@/house/store/renderingPreferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}

describe("remembered rendering preferences", () => {
  it("restores all lights, quality, manual daylight and coordinates across viewer instances", () => {
    const storage = memoryStorage();
    const first = createHouseStore();
    const stop = rememberRenderingPreferences(first, storage);
    first.getState().setDetailedLightAll(true);
    first.getState().setDetailedLightLimit(180);
    first.getState().setPerformanceMode(true);
    first.getState().setIllumination({ mode: "manual", atMs: 1_800_000_000_000, intensity: 1.65, latitude: 45, longitude: 12, northDeg: 30, softShadows: false });
    stop();
    const second = createHouseStore();
    const stopSecond = rememberRenderingPreferences(second, storage);
    expect(second.getState()).toMatchObject({ detailedLightAll: true, detailedLightLimit: 180, performanceMode: true,
      illumination: { mode: "manual", atMs: 1_800_000_000_000, intensity: 1.65, latitude: 45, longitude: 12, northDeg: 30, softShadows: false } });
    stopSecond();
  });

  it("does not store or restore scene state, device capabilities or transient HA addresses", () => {
    const storage = memoryStorage();
    const store = createHouseStore();
    const stop = rememberRenderingPreferences(store, storage);
    store.getState().setDetailedLightAll(true);
    const saved = storage.getItem(RENDERING_PREFERENCES_KEY);
    storage.setItem.mockClear();
    store.getState().setDetailedLightHardwareMax(9);
    store.getState().setDetailedLightCapabilities({ textures: 16, varyings: 16 });
    store.getState().setIllumination({ outdoorLuxRegistryId: "stable-id", outdoorLuxEntityId: "sensor.current_name" });
    store.getState().setTool("select");
    store.getState().setCut({ enabled: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    const restored = createHouseStore();
    restored.getState().setIllumination({ outdoorLuxRegistryId: "resolved", outdoorLuxEntityId: "sensor.renamed" });
    restoreRenderingPreferences(restored, saved);
    expect(restored.getState()).toMatchObject({ detailedLightHardwareMax: 12, tool: "orbit", cut: { enabled: false }, illumination: { outdoorLuxRegistryId: "resolved", outdoorLuxEntityId: "sensor.renamed" } });
    stop();
  });

  it("ignores corrupt and out-of-range preferences and tolerates denied browser storage", () => {
    const store = createHouseStore();
    restoreRenderingPreferences(store, "{broken");
    restoreRenderingPreferences(store, JSON.stringify({ version: 2 }));
    const storage = memoryStorage();
    const stop = rememberRenderingPreferences(store, storage);
    store.getState().setDetailedLightAll(true);
    stop();
    const raw = JSON.parse(storage.getItem(RENDERING_PREFERENCES_KEY)!);
    raw.illumination.intensity = 900;
    const restored = createHouseStore();
    restoreRenderingPreferences(restored, JSON.stringify(raw));
    expect(restored.getState().illumination.intensity).toBe(1);
    const denied = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("quota"); } };
    const cleanup = rememberRenderingPreferences(restored, denied);
    expect(() => restored.getState().setDetailedLightAll(true)).not.toThrow();
    cleanup();
  });

  it("resets rendering choices while retaining the selected HA sources and household background", () => {
    const store = createHouseStore({ background: { mode: "solid", color: "#123456" } });
    const storage = memoryStorage();
    const stop = rememberRenderingPreferences(store, storage);
    store.getState().setDetailedLightAll(true);
    store.getState().setIllumination({ intensity: 2, mode: "studio", outdoorLuxRegistryId: "stable-id" });
    resetRenderingPreferences(store);
    expect(store.getState()).toMatchObject({ detailedLightAll: false, detailedLightLimit: 64, background: { mode: "solid", color: "#123456" }, illumination: { intensity: 1, mode: "live", outdoorLuxRegistryId: "stable-id" } });
    expect(JSON.parse(storage.getItem(RENDERING_PREFERENCES_KEY)!).detailedLightAll).toBe(false);
    stop();
  });
});
