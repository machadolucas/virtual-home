import { describe, expect, it } from "vitest";
import { EMPTY_LABEL_PREFERENCES } from "@/house/model/labelPreferences";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { buildPropertyTree } from "@/house/model/propertyTree";
import type { Furnishing, Manifest, Placement, Route } from "@/house/model/types";
import { FIXTURE_DIR, loadManifest } from "./glb";

const manifest = loadManifest(FIXTURE_DIR);
const index = buildManifestIndex(manifest);

const placement: Placement = {
  id: "equipment-one",
  modelId: manifest.modelId,
  equipmentId: "asset-one",
  name: "Heat pump",
  position: [1, 0, 1],
  rotationYDeg: 0,
  mount: { kind: "floor", height: 0 },
  floorId: "f-lower",
  roomId: "r-l-a",
  surfaceId: null,
  locationNote: "",
  photoId: null,
  entityId: null,
  symbol: null,
  category: "hvac",
};

const furnishing: Furnishing = {
  id: "furniture-one",
  modelId: manifest.modelId,
  kind: "chair",
  name: "Reading chair",
  position: [1, 0, 1],
  rotationYDeg: 0,
  widthM: 0.5,
  depthM: 0.5,
  heightM: 0.8,
  floorId: "f-lower",
  roomId: "r-l-a",
};

const route: Route = {
  id: "route-one",
  modelId: manifest.modelId,
  name: "Main supply",
  system: "water",
  kind: "pipe",
  points: [[1, 0, 1], [1, 2.7, 1], [2, 2.7, 1]],
  segments: [
    { floorId: "f-lower", roomId: "r-l-a" },
    { floorId: "f-lower", roomId: "r-l-a" },
  ],
  pointPlaces: [
    { floorId: "f-lower", roomId: "r-l-a" },
    { floorId: "f-lower", roomId: "r-l-a" },
    { floorId: "f-upper", roomId: "r-u-a" },
  ],
  certainty: "measured",
  lifecycle: "installed",
  endpoints: [],
  photoIds: [],
};

const build = (over: Partial<Parameters<typeof buildPropertyTree>[0]> = {}) =>
  buildPropertyTree({
    index,
    placements: [placement],
    routes: [route],
    furnishings: [furnishing],
    labelPreferences: EMPTY_LABEL_PREFERENCES,
    ...over,
  });

describe("property tree model", () => {
  it("gives every floor the four stable sections without duplicating equipment under rooms", () => {
    const nodes = build();
    const floor = nodes.get("floor:f-lower")!;
    expect(floor.children.map((id) => nodes.get(id)?.label)).toEqual([
      "Rooms",
      "Equipment",
      "Infrastructure",
      "Furniture",
    ]);

    expect(nodes.get("section:f-lower:equipment")?.children).toEqual(["equipment:equipment-one"]);
    expect(nodes.get("room:r-l-a")?.children).not.toContain("equipment:equipment-one");
    expect([...nodes.keys()].filter((id) => id === "equipment:equipment-one")).toHaveLength(1);
    expect(nodes.get("section:f-lower:furniture")?.children).toEqual(["furnishing:furniture-one"]);
  });

  it("groups infrastructure by kind and includes a run on each floor it crosses", () => {
    const nodes = build();
    expect(nodes.get("section:f-lower:infrastructure")?.children).toEqual([
      "route-group:f-lower:pipe",
    ]);
    expect(nodes.get("route-group:f-lower:pipe")?.label).toBe("Pipes");
    expect(nodes.get("route-group:f-lower:pipe")?.children).toEqual([
      "route:f-lower:route-one",
    ]);
    expect(nodes.get("route-group:f-upper:pipe")?.children).toEqual([
      "route:f-upper:route-one",
    ]);
    expect(nodes.get("route:f-upper:route-one")?.selection).toEqual({ kind: "route", id: "route-one" });
  });

  it("keeps the single-floor building fold while placing sections below the folded floor row", () => {
    const floor = manifest.floors[0]!;
    const building = manifest.buildings[0]!;
    const singleFloorManifest: Manifest = {
      ...manifest,
      buildings: [{ ...building, floorIds: [floor.id] }],
      floors: [floor],
      rooms: manifest.rooms.filter((room) => room.floorId === floor.id),
    };
    const nodes = build({ index: buildManifestIndex(singleFloorManifest), routes: [] });
    expect(nodes.has(`building:${building.id}`)).toBe(false);
    expect(nodes.get(`floor:${floor.id}`)?.label).toBe(building.name);
    expect(nodes.get(`floor:${floor.id}`)?.children).toEqual([
      `section:${floor.id}:rooms`,
      `section:${floor.id}:equipment`,
      `section:${floor.id}:infrastructure`,
      `section:${floor.id}:furniture`,
    ]);
  });

  it("keeps furniture with a removed floor reachable for reassignment", () => {
    const nodes = build({ furnishings: [{ ...furnishing, id: "stale-chair", floorId: "removed-floor" }] });
    expect(nodes.get("section:unassigned-furniture")?.children).toEqual(["furnishing:stale-chair"]);
    expect(nodes.get("furnishing:stale-chair")?.secondary).toBe("Needs a floor");
  });
});
