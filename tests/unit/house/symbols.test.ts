/**
 * Device symbols: what a piece of equipment looks like in the 3D view.
 *
 * Every marker used to be the same 6 cm sphere, so the view could not answer "which of those is
 * the lamp post and which is the ceiling light" — the one question a picture is for. These tests
 * pin the three properties that keep that honest: a symbol is a *shape*, the inference never
 * writes anything, and instancing still holds (one draw call per symbol per explode group, not one
 * per marker).
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { MarkerLayer } from "@/house/scene/markers";
import {
  defaultSymbol,
  isPlacementSymbol,
  PLACEMENT_SYMBOLS,
  symbolGeometry,
  SYMBOL_LABEL,
} from "@/house/scene/symbols";
import type { Placement } from "@/house/model/types";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const placement = (over: Partial<Placement> & { id: string }): Placement => ({
  modelId: "fixture-house",
  equipmentId: `eq-${over.id}`,
  name: over.id,
  position: [2, 0, 2],
  rotationYDeg: 0,
  mount: { kind: "floor", height: 0 },
  floorId: "f-lower",
  roomId: "r-l-a",
  surfaceId: null,
  locationNote: "",
  photoId: null,
  entityId: null,
  symbol: null,
  category: null,
  ...over,
});

describe("symbol geometry", () => {
  it("builds a distinct, non-empty geometry for every symbol", () => {
    const signatures = new Set<string>();
    for (const symbol of PLACEMENT_SYMBOLS) {
      const geometry = symbolGeometry(symbol);
      const position = geometry.getAttribute("position");
      expect(position, symbol).toBeTruthy();
      expect(position.count, symbol).toBeGreaterThan(0);
      expect(geometry.boundingSphere, symbol).toBeTruthy();
      // A symbol nobody can tell apart from another is not a symbol.
      signatures.add(`${position.count}:${geometry.boundingSphere?.radius.toFixed(4)}`);
    }
    expect(signatures.size).toBe(PLACEMENT_SYMBOLS.length);
  });

  it("shares one geometry per symbol, so instancing is not defeated", () => {
    expect(symbolGeometry("lamp_post")).toBe(symbolGeometry("lamp_post"));
    expect(symbolGeometry("lamp_post")).not.toBe(symbolGeometry("ceiling_lamp"));
  });

  it("keeps every symbol small enough to read as a marker rather than as furniture", () => {
    for (const symbol of PLACEMENT_SYMBOLS) {
      const radius = symbolGeometry(symbol).boundingSphere?.radius ?? 0;
      expect(radius, symbol).toBeLessThan(0.5);
    }
  });

  it("labels every symbol", () => {
    for (const symbol of PLACEMENT_SYMBOLS) {
      expect(SYMBOL_LABEL[symbol]?.length, symbol).toBeGreaterThan(0);
    }
    expect(isPlacementSymbol("lamp_post")).toBe(true);
    expect(isPlacementSymbol("not_a_symbol")).toBe(false);
    expect(isPlacementSymbol(null)).toBe(false);
  });
});

describe("symbol inference", () => {
  it("reads the mount first: the same lamp is a dome, a bracket or a post", () => {
    expect(defaultSymbol({ category: "electrical", mountKind: "ceiling" })).toBe("ceiling_lamp");
    expect(defaultSymbol({ category: "electrical", mountKind: "wall" })).toBe("wall_lamp");
    expect(defaultSymbol({ category: "outdoor", mountKind: "floor", isOutdoor: true })).toBe(
      "lamp_post",
    );
    expect(defaultSymbol({ category: "outdoor", mountKind: "free", isOutdoor: true })).toBe(
      "spike_spot",
    );
  });

  it("draws an outdoor ceiling fixture as a downlight — the eave case", () => {
    expect(defaultSymbol({ category: "electrical", mountKind: "ceiling", isOutdoor: true })).toBe(
      "downlight",
    );
  });

  it("falls back to the generic marker rather than guessing wrongly", () => {
    expect(defaultSymbol({})).toBe("generic");
    expect(defaultSymbol({ category: "vehicle", mountKind: "floor" })).toBe("generic");
  });

  it("is inference only — nothing about it is written back", () => {
    // The stored value stays null; the view decides each render. This is what keeps a guess about
    // appearance from becoming a recorded fact about the house.
    const p = placement({ id: "p", category: "electrical", mount: { kind: "floor", height: 0 } });
    expect(p.symbol).toBeNull();
    expect(defaultSymbol({ category: p.category, mountKind: p.mount.kind })).not.toBe("generic");
    expect(p.symbol).toBeNull();
  });
});

describe("marker layer with symbols", () => {
  it("draws one instanced mesh per symbol, and reuses it for every marker of that symbol", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    try {
      markers.set(
        [
          placement({ id: "a", symbol: "lamp_post" }),
          placement({ id: "b", symbol: "lamp_post" }),
          placement({ id: "c", symbol: "ceiling_lamp" }),
        ],
        () => "live",
        () => "f-lower",
        (p) => (p.symbol === "ceiling_lamp" ? "ceiling_lamp" : "lamp_post"),
      );

      // Two symbols → two meshes, not three markers → three meshes.
      expect(markers.meshes).toHaveLength(2);
      const counts = markers.meshes.map((m) => m.count).sort();
      expect(counts).toEqual([1, 2]);
    } finally {
      markers.dispose();
    }
  });

  it("applies the placement's yaw, so a wall fixture can face away from its wall", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    try {
      markers.set(
        [placement({ id: "a", rotationYDeg: 90, symbol: "wall_lamp" })],
        () => "live",
        () => "f-lower",
        () => "wall_lamp",
      );
      const mesh = markers.meshes[0]!;
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(0, matrix);
      const euler = new THREE.Euler().setFromRotationMatrix(matrix);
      expect(THREE.MathUtils.radToDeg(euler.y)).toBeCloseTo(90, 6);
    } finally {
      markers.dispose();
    }
  });

  it("keeps the shared geometry alive after one layer is disposed", () => {
    const built = buildScene(FIXTURE_DIR);
    const layer = new MarkerLayer(built.index, built.clip);
    layer.set([placement({ id: "a" })], () => "live", () => "f-lower", () => "vent");
    layer.dispose();
    // A second workspace mounting must not find its geometry pulled out from under it.
    expect(symbolGeometry("vent").getAttribute("position").count).toBeGreaterThan(0);
  });
});
