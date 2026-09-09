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
      expect(Array.from(position.array).every(Number.isFinite), symbol).toBe(true);
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
      // Solar panels use normalized unit geometry so their placement scale can hold the real
      // width, thickness and length independently.
      if (symbol === "solar_panel") continue;
      const radius = symbolGeometry(symbol).boundingSphere?.radius ?? 0;
      expect(radius, symbol).toBeLessThan(0.5);
    }
  });

  it("normalizes a solar panel to configurable dimensions and anchors it on its bottom", () => {
    const box = symbolGeometry("solar_panel").boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(1, 6);
    expect(size.y).toBeCloseTo(1, 6);
    expect(size.z).toBeCloseTo(1, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    const centre = box.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.y).toBeCloseTo(0.5, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("centres the lantern directly over its single pole", () => {
    const position = symbolGeometry("lamp_post").getAttribute("position");
    const head = new THREE.Box3();
    for (let index = 0; index < position.count; index += 1) {
      if (position.getY(index) >= 0.52) {
        head.expandByPoint(
          new THREE.Vector3(position.getX(index), position.getY(index), position.getZ(index)),
        );
      }
    }
    const centre = head.getCenter(new THREE.Vector3());
    expect(centre.x).toBeCloseTo(0, 6);
    expect(centre.z).toBeCloseTo(0, 6);
  });

  it("labels every symbol", () => {
    for (const symbol of PLACEMENT_SYMBOLS) {
      expect(SYMBOL_LABEL[symbol]?.length, symbol).toBeGreaterThan(0);
    }
    expect(isPlacementSymbol("lamp_post")).toBe(true);
    expect(isPlacementSymbol("not_a_symbol")).toBe(false);
    expect(isPlacementSymbol(null)).toBe(false);
    expect(SYMBOL_LABEL.wall_spot).toBe("Wall spot");
    expect(SYMBOL_LABEL.floor_spot).toBe("Floor spot");
    expect(SYMBOL_LABEL.ceiling_spot).toBe("Ceiling spot");
    expect(SYMBOL_LABEL.solar_panel).toBe("Solar panel");
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

  it("recovers imported sensors and lights from their HA domain", () => {
    expect(defaultSymbol({ category: "appliance", entityId: "sensor.utility_temperature" })).toBe("sensor");
    expect(defaultSymbol({ category: "appliance", entityId: "binary_sensor.utility_motion" })).toBe("sensor");
    expect(defaultSymbol({ category: "appliance", entityId: "light.floor", mountKind: "floor" })).toBe("floor_lamp");
    expect(defaultSymbol({ category: "appliance", entityId: "light.eave", mountKind: "ceiling", isOutdoor: true })).toBe("downlight");
    expect(defaultSymbol({ category: "appliance", entityId: "light.path", mountKind: "floor", isOutdoor: true })).toBe("lamp_post");
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
