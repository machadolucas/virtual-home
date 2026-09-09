import { describe, expect, it } from "vitest";
import {
  buildGroupOrder,
  clipGroupOf,
  explodeOffset,
  groupsOf,
  roofGroup,
} from "@/house/model/explodeGroups";
import {
  boxUnion,
  buildingBox,
  cutRange,
  equipmentBox,
  floorBox,
  propertyBox,
  roomBox,
  routeBox,
} from "@/house/model/framingBoxes";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { FIXTURE_DIR, loadManifest, REAL_DIR } from "./glb";

describe("explode offsets (fixture)", () => {
  const index = buildManifestIndex(loadManifest(FIXTURE_DIR));
  const order = buildGroupOrder(index);

  it("orders each building's stack by floor elevation, roof on top, site pinned", () => {
    expect(order.get("site")).toBe(0);
    expect(order.get("f-lower")).toBe(0);
    expect(order.get("f-upper")).toBe(1);
    expect(order.get(roofGroup("b-fx"))).toBe(2);
  });

  it("scales offsets with the gap and collapses to zero when the gap is zero", () => {
    expect(explodeOffset(order, "f-upper", 2.5)).toBe(2.5);
    expect(explodeOffset(order, roofGroup("b-fx"), 2.5)).toBe(5);
    expect(explodeOffset(order, "site", 2.5)).toBe(0);
    for (const g of groupsOf(index)) expect(explodeOffset(order, g, 0)).toBe(0);
  });

  it("assigns every surface to a clip group", () => {
    for (const sid of index.surfaces.keys()) {
      expect(typeof clipGroupOf(index, sid), sid).toBe("string");
    }
    expect(clipGroupOf(index, "s-r-l-a-floor")).toBe("f-lower");
    expect(clipGroupOf(index, "s-r-u-a-floor")).toBe("f-upper");
    // the dormer belongs to the upper floor even though it lives in the roof asset
    expect(clipGroupOf(index, "s-e-dormer-fx-wall")).toBe("f-upper");
    expect(clipGroupOf(index, "s-e-roof-fx-north")).toBe(roofGroup("b-fx"));
    expect(clipGroupOf(index, "s-e-terrain-fx")).toBe("site");
    expect(clipGroupOf(index, "s-e-l-step")).toBe("site");
  });

  it("keeps the mesh-less surface classifiable", () => {
    expect(clipGroupOf(index, "s-e-l-ext-out-band")).toBe("f-lower");
  });
});

describe.skipIf(!REAL_DIR)("explode offsets (real package)", () => {
  it("keeps the garage stack independent of the house stack", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    const order = buildGroupOrder(index);
    expect(order.get("f-ground")).toBe(0);
    expect(order.get("f-upper")).toBe(1);
    expect(order.get(roofGroup("b-house"))).toBe(2);
    expect(order.get("f-garage")).toBe(0);
    expect(order.get(roofGroup("b-garage"))).toBe(1);
    // with a 2.5 m gap the garage roof rises 2.5 m, not 5 m: it is not part of the house stack
    expect(explodeOffset(order, roofGroup("b-garage"), 2.5)).toBe(2.5);
    expect(explodeOffset(order, roofGroup("b-house"), 2.5)).toBe(5);
  });

  it("groups the roof, terrace, terrain and structure surfaces sensibly", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    expect(clipGroupOf(index, "s-e-roof-house-north")).toBe(roofGroup("b-house"));
    expect(clipGroupOf(index, "s-e-roof-garage-north")).toBe(roofGroup("b-garage"));
    expect(clipGroupOf(index, "s-e-terrain")).toBe("site");
    expect(clipGroupOf(index, "s-e-terrace-slab")).toBe("site");
    expect(clipGroupOf(index, "s-r-g-living-floor")).toBe("f-ground");
    expect(clipGroupOf(index, "s-e-truss-01")).toBe(roofGroup("b-house"));
    expect(clipGroupOf(index, "s-e-footing-garage")).toBe("site");
  });
});

describe("framing boxes (fixture)", () => {
  const index = buildManifestIndex(loadManifest(FIXTURE_DIR));

  it("frames a room from its own floor elevation, not the floor datum", () => {
    const b = roomBox(index.rooms.get("r-l-b")!);
    expect(b.min[1]).toBeCloseTo(-0.25, 6); // -0.20 floor - 0.05
    expect(b.max[1]).toBeCloseTo(2.55, 6); // -0.20 + 2.70 + 0.05
  });

  it("unions a floor's rooms", () => {
    const b = floorBox(index, "f-lower");
    let expected = roomBox(index.rooms.get("r-l-a")!);
    for (const id of ["r-l-b", "r-l-closet"])
      expected = boxUnion(expected, roomBox(index.rooms.get(id)!));
    expect(b).toEqual(expected);
  });

  it("uses the manifest bounds for the property box and derives the cut range from them", () => {
    expect(propertyBox(index)).toEqual({ min: [-4, -1, -4], max: [10, 7, 8] });
    const range = cutRange(index);
    expect(range.min).toBeLessThan(-1);
    expect(range.max).toBeGreaterThan(7);
  });

  it("frames a building from all of its non-scan asset bounds", () => {
    const b = buildingBox(index, "b-fx");
    expect(b.min).toEqual([-0.3, -0.2, -0.3]);
    expect(b.max).toEqual([6.6, 6.2, 4.4]);
  });

  it("builds context boxes for equipment and routes", () => {
    const eq = equipmentBox({ position: [1, 2, 3] });
    expect(eq.min[0]).toBeCloseTo(0.2, 9);
    expect(eq.min[1]).toBeCloseTo(1.2, 9);
    expect(eq.max[2]).toBeCloseTo(3.8, 9);
    const r = routeBox({ points: [[0, 0, 0], [1, 1, 1]] });
    expect(r.min).toEqual([-0.5, -0.5, -0.5]);
    expect(r.max).toEqual([1.5, 1.5, 1.5]);
  });
});

describe.skipIf(!REAL_DIR)("framing boxes (real package)", () => {
  it("frames the living room at its -0.30 datum and the property at the manifest bounds", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    const living = roomBox(index.rooms.get("r-g-living")!);
    expect(living.min[1]).toBeCloseTo(-0.35, 6);
    expect(propertyBox(index)).toEqual({ min: [-15.02, -5.85, -8.9], max: [26.5, 6.8, 13.8] });
  });

  it("contains every room of a floor in that floor's box", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    for (const floorId of index.floors.keys()) {
      const fb = floorBox(index, floorId);
      for (const room of index.roomsByFloor.get(floorId) ?? []) {
        const rb = roomBox(room);
        for (let i = 0; i < 3; i++) {
          expect(fb.min[i]!, `${floorId}/${room.id}`).toBeLessThanOrEqual(rb.min[i]! + 1e-9);
          expect(fb.max[i]!, `${floorId}/${room.id}`).toBeGreaterThanOrEqual(rb.max[i]! - 1e-9);
        }
      }
    }
  });
});
