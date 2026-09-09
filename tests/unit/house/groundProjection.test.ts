import { describe, expect, it } from "vitest";
import { projectGroundReference } from "@/house/scene/groundProjection";
import { buildScene } from "./sceneFromGlb";
import { FIXTURE_DIR } from "./glb";

describe("placement elevation reference", () => {
  it("uses a sunken room's floor rather than the floor datum", () => {
    const { manifestIndex } = buildScene(FIXTURE_DIR);
    expect(projectGroundReference({ point: [3, 1.4, 2], floorId: "f-lower", roomId: "r-l-b", manifest: manifestIndex }))
      .toMatchObject({ point: [3, -0.2, 2], source: "surface" });
  });
  it("finds terrain below an exterior placement without changing the point", () => {
    const { manifestIndex, index } = buildScene(FIXTURE_DIR);
    const point: [number, number, number] = [-2, 3, 1];
    const reference = projectGroundReference({ point, floorId: "f-lower", manifest: manifestIndex, sceneIndex: index });
    expect(reference.point[1]).toBeCloseTo(-0.4);
    expect(reference.surfaceId).toBe("s-e-terrain-fx");
    expect(point).toEqual([-2, 3, 1]);
  });
  it("uses the intersected terrain height on a slope", () => {
    const { manifestIndex, index } = buildScene(FIXTURE_DIR);
    const mesh = index.surfaceMesh.get("s-e-terrain-fx")!;
    const positions = mesh.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i++) positions.setY(i, positions.getX(i) * 0.1);
    mesh.geometry.computeBoundingSphere();
    const reference = projectGroundReference({ point: [-2, 3, 1], floorId: "f-lower", manifest: manifestIndex, sceneIndex: index });
    expect(reference.point[1]).toBeCloseTo(-0.2);
  });
  it("labels the floor datum fallback when outdoor geometry is absent", () => {
    const { manifestIndex } = buildScene(FIXTURE_DIR);
    expect(projectGroundReference({ point: [-2, 3, 1], floorId: "f-lower", manifest: manifestIndex }))
      .toMatchObject({ point: [-2, 0, 1], source: "floor-datum", label: "Floor datum" });
  });
});
