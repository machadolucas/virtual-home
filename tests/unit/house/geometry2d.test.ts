import { describe, expect, it } from "vitest";
import {
  distanceToRings,
  pointInFootprint,
  pointInRing,
  poleOfInaccessibility,
  polylineLength,
  ringArea,
  ringBBox,
  ringCentroid,
  signedClearance,
  snapValue,
} from "@/house/model/geometry2d";
import { buildManifestIndex, roomAt } from "@/house/model/manifestIndex";
import type { Vec2 } from "@/house/model/types";
import { FIXTURE_DIR, loadManifest, REAL_DIR } from "./glb";

const square: Vec2[] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];
/** An L: the area centroid of this ring lies in the notch, outside the polygon. */
const lShape: Vec2[] = [
  [0, 0],
  [6, 0],
  [6, 2],
  [2, 2],
  [2, 6],
  [0, 6],
];

describe("rings", () => {
  it("computes bbox, area and centroid", () => {
    expect(ringBBox(square)).toEqual({ minX: 0, minZ: 0, maxX: 4, maxZ: 4 });
    expect(ringArea(square)).toBe(16);
    expect(ringCentroid(square)).toEqual([2, 2]);
    expect(ringArea(lShape)).toBe(20);
  });

  it("tests point-in-ring including the boundary", () => {
    expect(pointInRing(2, 2, square)).toBe(true);
    expect(pointInRing(-0.001, 2, square)).toBe(false);
    expect(pointInRing(0, 2, square)).toBe(true); // on the edge
    expect(pointInRing(4, 4, square)).toBe(true); // on a vertex
  });

  it("excludes holes", () => {
    const footprint = {
      outer: square,
      holes: [
        [
          [1, 1],
          [2, 1],
          [2, 2],
          [1, 2],
        ] as Vec2[],
      ],
    };
    expect(pointInFootprint(0.5, 0.5, footprint)).toBe(true);
    expect(pointInFootprint(1.5, 1.5, footprint)).toBe(false);
    expect(pointInFootprint(3, 3, footprint)).toBe(true);
  });

  it("measures signed clearance from the rings", () => {
    expect(distanceToRings(2, 2, [square])).toBe(2);
    expect(signedClearance(2, 2, { outer: square })).toBe(2);
    expect(signedClearance(-1, 2, { outer: square })).toBe(-1);
  });
});

describe("pole of inaccessibility", () => {
  it("lands inside a concave ring where the area centroid does not", () => {
    const c = ringCentroid(lShape);
    expect(pointInRing(c[0], c[1], lShape)).toBe(false);
    const { point, clearance } = poleOfInaccessibility({ outer: lShape });
    expect(pointInRing(point[0], point[1], lShape)).toBe(true);
    expect(clearance).toBeGreaterThan(0.9);
  });

  it("respects holes", () => {
    const footprint = {
      outer: square,
      holes: [
        [
          [1.4, 1.4],
          [2.6, 1.4],
          [2.6, 2.6],
          [1.4, 2.6],
        ] as Vec2[],
      ],
    };
    const { point } = poleOfInaccessibility(footprint);
    expect(pointInFootprint(point[0], point[1], footprint)).toBe(true);
  });

  it("is inside every fixture room and beats the centroid's clearance on the concave one", () => {
    const index = buildManifestIndex(loadManifest(FIXTURE_DIR));
    for (const room of index.rooms.values()) {
      const { point, clearance } = poleOfInaccessibility(room.footprint);
      expect(pointInFootprint(point[0], point[1], room.footprint), room.id).toBe(true);
      expect(clearance, room.id).toBeGreaterThan(0);
    }
    const concave = index.rooms.get("r-u-a");
    const c = ringCentroid(concave!.footprint.outer);
    const pole = poleOfInaccessibility(concave!.footprint);
    expect(pole.clearance).toBeGreaterThanOrEqual(
      signedClearance(c[0], c[1], concave!.footprint) - 1e-6,
    );
  });

  it("caches an anchor above the room's own floor, not the floor datum", () => {
    const index = buildManifestIndex(loadManifest(FIXTURE_DIR));
    const anchor = index.roomAnchors.get("r-l-b");
    expect(anchor).toBeDefined();
    // r-l-b sits 0.20 m below its floor datum; the anchor rides its own elevation
    expect(anchor!.point[1]).toBeCloseTo(-0.2 + Math.min(2.7 * 0.6, 1.6), 6);
  });
});

describe.skipIf(!REAL_DIR)("pole of inaccessibility on the real concave rings", () => {
  it("is inside the hall and living-room rings, with a usable clearance", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    for (const id of ["r-g-hall", "r-g-living", "r-g-office-m", "r-u-attic-s"]) {
      const room = index.rooms.get(id);
      expect(room, id).toBeDefined();
      const { point, clearance } = poleOfInaccessibility(room!.footprint);
      expect(pointInFootprint(point[0], point[1], room!.footprint), id).toBe(true);
      expect(clearance, id).toBeGreaterThan(0.3);
    }
  });

  it("resolves a point inside the living room to r-g-living, not to a neighbour", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    const anchor = index.roomAnchors.get("r-g-living");
    expect(anchor).toBeDefined();
    expect(roomAt(index, "f-ground", anchor!.point[0], anchor!.point[2])).toBe("r-g-living");
  });

  it("assigns every room's own anchor back to that room", () => {
    const index = buildManifestIndex(loadManifest(REAL_DIR as string));
    for (const room of index.rooms.values()) {
      const a = index.roomAnchors.get(room.id);
      expect(roomAt(index, room.floorId, a!.point[0], a!.point[2]), room.id).toBe(room.id);
    }
  });
});

describe("snapping and lengths", () => {
  it("snaps to a 5 cm grid and rounds to millimetres", () => {
    expect(snapValue(1.234, 0.05)).toBe(1.25);
    expect(snapValue(-0.31, 0.05)).toBe(-0.3);
    expect(snapValue(0.1 + 0.2, 0.05)).toBe(0.3);
    expect(snapValue(1.2345, 0)).toBe(1.235);
  });

  it("measures polyline length in metres", () => {
    expect(polylineLength([[0, 0, 0], [3, 0, 4]])).toBe(5);
    expect(polylineLength([[0, 0, 0]])).toBe(0);
  });
});

describe("roomAt (fixture)", () => {
  const index = buildManifestIndex(loadManifest(FIXTURE_DIR));

  it("finds the room a point falls in, per floor", () => {
    expect(roomAt(index, "f-lower", 1.0, 2.5)).toBe("r-l-a");
    expect(roomAt(index, "f-lower", 3.8, 2.0)).toBe("r-l-b");
    expect(roomAt(index, "f-lower", 5.2, 2.0)).toBe("r-l-closet");
    expect(roomAt(index, "f-upper", 1.0, 2.0)).toBe("r-u-a");
  });

  it("returns null inside a footprint hole and outside the envelope", () => {
    expect(roomAt(index, "f-lower", 1.3, 1.3)).toBeNull(); // the flue hole in r-l-a
    expect(roomAt(index, "f-lower", 20, 20)).toBeNull();
  });

  it("does not leak a lower-floor room into the upper floor", () => {
    expect(roomAt(index, "f-upper", 5.2, 2.0)).toBe("r-u-a");
    expect(roomAt(index, "f-upper", 5.5, 3.7)).toBeNull(); // cut off by the diagonal wall
  });
});
