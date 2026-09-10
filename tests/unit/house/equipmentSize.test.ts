import { describe, expect, it } from "vitest";
import {
  canonicalEquipmentSize,
  DEFAULT_WOOD_STORAGE_SIZE,
  equipmentSizeFromJson,
} from "@/house/model/equipmentSize";
import { equipmentSymbolScale } from "@/house/model/equipmentScale";

describe("resizable equipment dimensions", () => {
  it("uses the authored wood-storage size as unit scale", () => {
    expect(equipmentSymbolScale({ symbol: "outdoor_wood_storage" })).toEqual([1, 1, 1]);
    expect(DEFAULT_WOOD_STORAGE_SIZE).toEqual({ widthM: 1, depthM: 2.5, heightM: 2.2 });
  });

  it("scales width, height and depth on their matching scene axes", () => {
    expect(equipmentSymbolScale({
      symbol: "outdoor_wood_storage",
      equipmentSize: { widthM: 2, depthM: 5, heightM: 1.1 },
    })).toEqual([2, 0.5, 2]);
  });

  it("rounds valid stored dimensions and rejects malformed JSON", () => {
    expect(canonicalEquipmentSize({ widthM: 1.2344, depthM: 2.3456, heightM: 2.2222 }))
      .toEqual({ widthM: 1.234, depthM: 2.346, heightM: 2.222 });
    expect(equipmentSizeFromJson('{"widthM":1.2344,"depthM":2.3456,"heightM":2.2222}'))
      .toEqual({ widthM: 1.234, depthM: 2.346, heightM: 2.222 });
    expect(equipmentSizeFromJson("not json")).toBeNull();
    expect(equipmentSizeFromJson('{"widthM":0,"depthM":2.5,"heightM":2.2}')).toBeNull();
  });
});
