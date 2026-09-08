/**
 * Contract tests: the zod mirror and the cross-reference checks, against the synthetic fixture
 * always and against the real package only when `VH_REAL_MODEL_DIR` points at one.
 */
import { describe, expect, it } from "vitest";
import { crossCheck, errorsOf } from "@/house/model/crossref";
import { hexFromLinear } from "@/house/model/colorPlan";
import { buildManifestIndex } from "@/house/model/manifestIndex";
import { baseColorFactorOf, FIXTURE_DIR, loadManifest, readPackageGlbs, REAL_DIR } from "./glb";

describe("fixture package", () => {
  const manifest = loadManifest(FIXTURE_DIR);

  it("parses against the zod mirror of the v1.0 contract", () => {
    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.modelId).toBe("fixture-house");
  });

  it("has no cross-reference errors", () => {
    const diagnostics = crossCheck(manifest);
    expect(errorsOf(diagnostics)).toEqual([]);
  });

  it("reproduces the structural quirks the viewer has to cope with", () => {
    const index = buildManifestIndex(manifest);
    // one shared wall -> two independently colourable faces
    expect(index.surfaces.has("s-w-l-ab--r-l-a")).toBe(true);
    expect(index.surfaces.has("s-w-l-ab--r-l-b")).toBe(true);
    // room kinds include `closet`, certainty includes `derived`
    expect(index.rooms.get("r-l-closet")?.kind).toBe("closet");
    expect(index.elements.get("e-w-l-bc")?.certainty).toBe("derived");
    // a room whose own floor elevation differs from its floor datum
    expect(index.rooms.get("r-l-b")?.floorElevation).toBe(-0.2);
    expect(index.floors.get("f-lower")?.elevation).toBe(0);
    // a footprint with a hole and a concave footprint
    expect(index.rooms.get("r-l-a")?.footprint.holes.length).toBe(1);
    expect(index.rooms.get("r-u-a")?.footprint.outer.length).toBe(5);
  });

  it("mirrors the mesh-less surface node and the floor-less element", () => {
    const glbs = readPackageGlbs(FIXTURE_DIR, ["fixture-lower"]);
    const lower = glbs.get("fixture-lower");
    expect(lower).toBeDefined();
    // the degenerate band has no mesh
    expect(baseColorFactorOf(lower!, "s-e-l-ext-out-band")).toBeNull();
    // ... while every other surface of that element does
    expect(baseColorFactorOf(lower!, "s-e-l-ext-out")).not.toBeNull();
    const index = buildManifestIndex(manifest);
    expect(index.elements.get("e-l-step")?.floorId).toBeUndefined();
  });

  it("has a floor node in more than one asset", () => {
    const glbs = readPackageGlbs(FIXTURE_DIR, ["fixture-upper", "fixture-roof"]);
    for (const id of ["fixture-upper", "fixture-roof"]) {
      const g = glbs.get(id);
      expect(g, id).toBeDefined();
      expect(g!.json.nodes.some((n) => n.name === "f-upper"), id).toBe(true);
    }
  });

  it("encodes defaultColor as the sRGB form of baseColorFactor for every mesh-backed surface", () => {
    const index = buildManifestIndex(manifest);
    const glbs = readPackageGlbs(FIXTURE_DIR, [...index.assets.keys()]);
    let checked = 0;
    for (const s of manifest.surfaces) {
      for (const nr of s.nodeRefs) {
        const g = glbs.get(nr.assetId);
        if (!g) continue;
        const bcf = baseColorFactorOf(g, nr.nodeName);
        if (!bcf) continue;
        expect(hexFromLinear(bcf), s.id).toBe(s.defaultColor.toLowerCase());
        checked++;
      }
    }
    expect(checked).toBe(29); // 30 surfaces, one of them mesh-less
  });
});

describe.skipIf(!REAL_DIR)("real package (VH_REAL_MODEL_DIR)", () => {
  it("validates with no schema and no cross-reference errors", () => {
    const manifest = loadManifest(REAL_DIR as string);
    expect(manifest.schemaVersion).toBe("1.0");
    expect(errorsOf(crossCheck(manifest))).toEqual([]);
    expect(manifest.rooms.length).toBe(25);
    expect(manifest.surfaces.length).toBe(405);
    expect(manifest.assets.length).toBe(11);
    expect(manifest.elements.length).toBe(170);
  });

  it("has exactly two mesh-less surface nodes and 403 with a material", () => {
    const dir = REAL_DIR as string;
    const manifest = loadManifest(dir);
    const glbs = readPackageGlbs(dir, manifest.assets.map((a) => a.id));
    const meshless: string[] = [];
    let withMaterial = 0;
    for (const s of manifest.surfaces) {
      for (const nr of s.nodeRefs) {
        const g = glbs.get(nr.assetId);
        if (!g) continue;
        if (baseColorFactorOf(g, nr.nodeName)) withMaterial++;
        else meshless.push(s.id);
      }
    }
    expect(meshless.sort()).toEqual([
      "s-e-f-garage-ext-out-0-upper",
      "s-e-f-garage-ext-out-2-upper",
    ]);
    expect(withMaterial).toBe(403);
  });

  it("keeps the defaultColor <-> baseColorFactor invariant for all 403 surfaces", () => {
    const dir = REAL_DIR as string;
    const manifest = loadManifest(dir);
    const glbs = readPackageGlbs(dir, manifest.assets.map((a) => a.id));
    let checked = 0;
    for (const s of manifest.surfaces) {
      for (const nr of s.nodeRefs) {
        const bcf = glbs.get(nr.assetId) ? baseColorFactorOf(glbs.get(nr.assetId)!, nr.nodeName) : null;
        if (!bcf) continue;
        expect(hexFromLinear(bcf), s.id).toBe(s.defaultColor.toLowerCase());
        checked++;
      }
    }
    expect(checked).toBe(403);
  });

  it("carries no node transforms: world == local == site frame", () => {
    const dir = REAL_DIR as string;
    const manifest = loadManifest(dir);
    const glbs = readPackageGlbs(dir, manifest.assets.map((a) => a.id));
    let transformed = 0;
    for (const g of glbs.values())
      for (const n of g.json.nodes as Array<Record<string, unknown>>)
        if ("translation" in n || "rotation" in n || "scale" in n || "matrix" in n) transformed++;
    expect(transformed).toBe(0);
  });
});
