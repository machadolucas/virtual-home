import { describe, expect, it } from "vitest";
import { canMountSurface } from "@/house/model/mountSurface";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { FIXTURE_DIR, loadManifest } from "./glb";

describe("shared mount policy", () => {
  it("accepts roomless exterior faces but refuses horizontal trim and roof slopes", () => {
    const index = buildManifestIndex(loadManifest(FIXTURE_DIR));
    expect(canMountSurface(index, "s-e-l-ext-out", "wall")).toBe(true);
    expect(canMountSurface(index, "s-e-roof-fx-under", "ceiling")).toBe(true);
    expect(canMountSurface(index, "s-e-roof-fx-north", "ceiling")).toBe(false);
    const exterior = index.surfaces.get("s-e-l-ext-out")!;
    for (const role of ["wall-top", "exterior-ledge", "step"]) {
      index.surfaces.set(exterior.id, { ...exterior, role });
      expect(canMountSurface(index, exterior.id, "wall")).toBe(false);
    }
    expect(canMountSurface(index, "does-not-exist", "wall")).toBe(false);
  });
});
