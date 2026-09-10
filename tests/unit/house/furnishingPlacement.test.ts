import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { furnishingCollisionShape, furnishingWallCollision, placementEnvelopeCollision, placementShapeCollision, roundedPosition } from "@/house/scene/furnishingPlacement";
import type { Furnishing } from "@/house/model/types";

const furniture: Furnishing = { id: "test", modelId: "synthetic", name: "Sofa", kind: "sofa", floorId: "floor", roomId: null,
  position: [0,0,0], rotationYDeg: 0, widthM: 1, depthM: 1, heightM: 1 };
function wall(a: [number,number], b: [number,number]) {
  const vertices = [new THREE.Vector3(a[0],0,a[1]), new THREE.Vector3(b[0],0,b[1]), new THREE.Vector3(b[0],3,b[1]),
    new THREE.Vector3(a[0],0,a[1]),new THREE.Vector3(b[0],3,b[1]),new THREE.Vector3(a[0],3,a[1])];
  return { vertices, bounds: new THREE.Box3().setFromPoints(vertices) };
}
describe("furniture wall collision", () => {
  it("blocks wall penetration while allowing furniture flush against a wall", () => {
    expect(furnishingWallCollision(furniture, [wall([.2,-2],[.2,2])])).toBe(true);
    expect(furnishingWallCollision(furniture, [wall([.5,-2],[.5,2])])).toBe(false);
  });
  it("uses actual diagonal wall triangles rather than rejecting their entire bounding rectangle", () => {
    const diagonal = wall([-2,-2],[2,2]);
    expect(furnishingWallCollision({ ...furniture, position:[-1,0,1] }, [diagonal])).toBe(false);
    expect(furnishingWallCollision(furniture, [diagonal])).toBe(true);
  });
  it("accounts for dimensions, rotation and vertical separation", () => {
    const obstacle = wall([1,-3],[1,3]);
    expect(furnishingWallCollision(furniture, [obstacle])).toBe(false);
    expect(furnishingWallCollision({ ...furniture, widthM: 3 }, [obstacle])).toBe(true);
    expect(furnishingWallCollision({ ...furniture, widthM: 3, rotationYDeg: 90 }, [obstacle])).toBe(false);
    expect(furnishingWallCollision({ ...furniture, widthM:3, position:[0,4,0] }, [obstacle])).toBe(false);
    expect(roundedPosition([1.123456,0,2.34567])).toEqual([1.123,0,2.346]);
  });
});

describe("placed object collision", () => {
  it("blocks mutual overlap but permits side and stacking contact", () => {
    const beside = { ...furniture, id: "beside", position: [1, 0, 0] as [number, number, number] };
    const stacked = { ...furniture, id: "stacked", position: [0, 1, 0] as [number, number, number] };
    expect(placementEnvelopeCollision(furniture, { ...beside, position: [.8, 0, 0] })).toBe(true);
    expect(placementEnvelopeCollision(furniture, beside)).toBe(false);
    expect(placementEnvelopeCollision(furniture, stacked)).toBe(false);
    expect(placementEnvelopeCollision(stacked, furniture)).toBe(false);
  });

  it("uses both objects' yaw instead of axis-aligned bounding boxes", () => {
    const narrow = { ...furniture, widthM: 2, depthM: .2, rotationYDeg: 45 };
    expect(placementEnvelopeCollision(narrow, { ...narrow, id: "other", position: [0, 0, .2] })).toBe(true);
    expect(placementEnvelopeCollision(narrow, { ...narrow, id: "far", position: [1.8, 0, 0] })).toBe(false);
  });

  it("keeps real open space under a table and treats rugs as underlays", () => {
    const table = { ...furniture, id: "table", kind: "dining_table" as const, widthM: 1.6, depthM: 1, heightM: .75 };
    const chair = { ...furniture, id: "chair", kind: "chair" as const, position: [0, 0, 0] as [number, number, number], widthM: .45, depthM: .45, heightM: .42 };
    const tableShape = furnishingCollisionShape(table)!;
    const chairShape = furnishingCollisionShape(chair)!;
    expect(placementEnvelopeCollision(table, chair)).toBe(true);
    expect(placementShapeCollision(tableShape, chairShape)).toBe(false);
    expect(furnishingCollisionShape({ ...furniture, kind: "rug" })).toBeNull();
  });
});
