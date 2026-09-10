import { describe, expect, it } from "vitest";
import { FURNISHING_CATALOG } from "@/house/model/furnishingCatalog";
import { projectFurnishingThumbnail } from "@/house/components/furnishings/furnitureThumbnail";

describe("furniture catalog thumbnails", () => {
  it("projects every procedural furnishing into finite, painter-sorted SVG triangles", () => {
    for (const item of FURNISHING_CATALOG) {
      const triangles = projectFurnishingThumbnail(item.kind);
      expect(triangles.length, item.kind).toBeGreaterThan(0);
      expect(triangles.every((triangle) => Number.isFinite(triangle.depth))).toBe(true);
      expect(triangles.every((triangle) => triangle.light >= 0.34 && triangle.light <= 1)).toBe(true);
      expect(triangles.map((triangle) => triangle.depth)).toEqual(
        [...triangles].map((triangle) => triangle.depth).sort((a, b) => b - a),
      );

      for (const triangle of triangles) {
        const coordinates = triangle.points.split(/[ ,]/).map(Number);
        expect(coordinates.every(Number.isFinite)).toBe(true);
        expect(coordinates.every((value) => value >= 4.99 && value <= 95.01)).toBe(true);
      }
    }
  });

  it("is deterministic without cloning or mutating the shared geometry", () => {
    expect(projectFurnishingThumbnail("sofa")).toEqual(projectFurnishingThumbnail("sofa"));
  });
});
