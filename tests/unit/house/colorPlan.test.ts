/**
 * "Colour never leaks" — proven once as a data property rather than checked case by case.
 */
import { describe, expect, it } from "vitest";
import {
  hexFromLinear,
  hexToLinear,
  normalizeHex,
  planAllSurfaces,
  planRoomColors,
} from "@/house/model/colorPlan";
import { buildManifestIndex, ROOM_SURFACE_KINDS } from "@/house/model/manifestIndex";
import type { SurfaceId } from "@/house/model/types";
import { FIXTURE_DIR, loadManifest, REAL_DIR } from "./glb";

function plansOf(dir: string) {
  const manifest = loadManifest(dir);
  const index = buildManifestIndex(manifest);
  const plans = new Map<string, Set<SurfaceId>>();
  for (const room of manifest.rooms) {
    const plan = planRoomColors(room, index.surfaces, {});
    plans.set(room.id, new Set(plan.map((p) => p.surfaceId)));
  }
  return { manifest, index, plans };
}

const PACKAGES: Array<[string, string]> = [["fixture", FIXTURE_DIR]];
if (REAL_DIR) PACKAGES.push(["real", REAL_DIR]);

describe.each(PACKAGES)("colour plans (%s package)", (_label, dir) => {
  it("are pairwise disjoint across every room", () => {
    const { plans } = plansOf(dir);
    const ids = [...plans.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = plans.get(ids[i] as string) as Set<SurfaceId>;
        const b = plans.get(ids[j] as string) as Set<SurfaceId>;
        const overlap = [...a].filter((s) => b.has(s));
        expect(overlap, `${ids[i]} vs ${ids[j]}`).toEqual([]);
      }
    }
  });

  it("only ever contain floor / wall / ceiling surfaces of that very room", () => {
    const { index, plans } = plansOf(dir);
    for (const [roomId, set] of plans) {
      for (const sid of set) {
        const s = index.surfaces.get(sid);
        expect(s, sid).toBeDefined();
        expect(s!.roomId, sid).toBe(roomId);
        expect(ROOM_SURFACE_KINDS.has(s!.kind), `${sid} kind=${s!.kind}`).toBe(true);
      }
    }
  });

  it("covers every room-facing surface exactly once", () => {
    const { manifest, plans } = plansOf(dir);
    const planned = new Set<SurfaceId>();
    for (const set of plans.values()) for (const s of set) planned.add(s);
    const expected = manifest.surfaces.filter(
      (s) => s.roomId !== undefined && ROOM_SURFACE_KINDS.has(s.kind),
    );
    expect(planned.size).toBe(expected.length);
  });

  it("plans every surface, override or default, for the whole model", () => {
    const { manifest, index } = plansOf(dir);
    const all = planAllSurfaces(manifest.surfaces, {});
    expect(all.length).toBe(manifest.surfaces.length);
    for (const d of all) {
      expect(d.source).toBe("default");
      expect(d.hex).toBe(index.surfaces.get(d.surfaceId)?.defaultColor.toLowerCase());
    }
  });
});

describe("shared-wall independence (fixture)", () => {
  const manifest = loadManifest(FIXTURE_DIR);
  const index = buildManifestIndex(manifest);

  it("colours only the face that belongs to the selected room", () => {
    const roomA = index.rooms.get("r-l-a");
    const roomB = index.rooms.get("r-l-b");
    expect(roomA && roomB).toBeTruthy();
    const planA = planRoomColors(roomA!, index.surfaces, { "s-w-l-ab--r-l-a": "#ff0000" });
    const ids = planA.map((p) => p.surfaceId);
    expect(ids).toContain("s-w-l-ab--r-l-a");
    expect(ids).not.toContain("s-w-l-ab--r-l-b");
    const decision = planA.find((p) => p.surfaceId === "s-w-l-ab--r-l-a");
    expect(decision).toEqual({ surfaceId: "s-w-l-ab--r-l-a", hex: "#ff0000", source: "override" });
    // the neighbour's plan is untouched by the override
    const planB = planRoomColors(roomB!, index.surfaces, { "s-w-l-ab--r-l-a": "#ff0000" });
    for (const d of planB) expect(d.source).toBe("default");
  });

  it("refuses to repaint a neighbour's face even if the manifest listed it here", () => {
    const roomA = index.rooms.get("r-l-a");
    const doctored = { ...roomA!, surfaceIds: [...roomA!.surfaceIds, "s-w-l-ab--r-l-b"] };
    const plan = planRoomColors(doctored, index.surfaces, {});
    expect(plan.map((p) => p.surfaceId)).not.toContain("s-w-l-ab--r-l-b");
  });

  it("narrows to a single kind when the wall picker enumerates surfaces", () => {
    const room = index.rooms.get("r-l-a");
    const walls = planRoomColors(room!, index.surfaces, {}, { kinds: new Set(["wall"]) });
    expect(walls.length).toBeGreaterThan(0);
    for (const d of walls) expect(index.surfaces.get(d.surfaceId)?.kind).toBe("wall");
  });
});

describe("colour conversions", () => {
  it("round-trips sRGB hex through the linear working space", () => {
    for (const hex of ["#000000", "#ffffff", "#d9c3a5", "#bfd8e6", "#010203"]) {
      expect(hexFromLinear(hexToLinear(hex))).toBe(hex);
    }
  });

  it("normalises shorthand and rejects nonsense", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #D9C3A5 ")).toBe("#d9c3a5");
    expect(() => normalizeHex("red")).toThrow();
    expect(() => normalizeHex("#12345")).toThrow();
  });

  it("reproduces the shipped 0.69387 linear channel as 0xd9", () => {
    expect(hexFromLinear([0.6938717, 0.5457245, 0.3712277]).slice(0, 3)).toBe("#d9");
  });
});
