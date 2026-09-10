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
import { PHYSICAL_SYMBOL_SIZE } from "@/house/model/equipmentDimensions";
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

  it("uses realistic physical envelopes without moving the shared mount origin", () => {
    for (const [symbol, expected] of Object.entries(PHYSICAL_SYMBOL_SIZE)) {
      const box = symbolGeometry(symbol as (typeof PLACEMENT_SYMBOLS)[number]).boundingBox!;
      const size = box.getSize(new THREE.Vector3());
      expect(size.x, `${symbol} width`).toBeCloseTo(expected[0]!, 6);
      expect(size.y, `${symbol} height`).toBeCloseTo(expected[1]!, 6);
      expect(size.z, `${symbol} depth`).toBeCloseTo(expected[2]!, 6);
    }
    expect(symbolGeometry("dishwasher").boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(symbolGeometry("fridge").boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(symbolGeometry("floor_lamp").boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(symbolGeometry("lamp_post").boundingBox!.min.y).toBeCloseTo(0, 6);
  });

  it("pins the requested appliance and standing-light dimensions in physical metres", () => {
    const sizeOf = (symbol: (typeof PLACEMENT_SYMBOLS)[number]) =>
      symbolGeometry(symbol).boundingBox!.getSize(new THREE.Vector3()).toArray();
    const expectSize = (symbol: (typeof PLACEMENT_SYMBOLS)[number], expected: readonly number[]) => {
      const actual = sizeOf(symbol);
      expected.forEach((dimension, index) => expect(actual[index], `${symbol}[${index}]`).toBeCloseTo(dimension, 6));
    };
    expectSize("dishwasher", [0.6, 0.8, 0.6]);
    expectSize("fridge", [0.6, 1.86, 0.65]);
    expectSize("freezer", [0.6, 1.86, 0.65]);
    for (const symbol of ["floor_lamp", "lamp_post", "floor_spot"] as const) {
      expect(sizeOf(symbol)[1], symbol).toBeCloseTo(1.5, 6);
    }
    expectSize("hot_water_tank", [0.65, 1.86, 0.65]);
    expectSize("ventilation_machine", [0.46, 0.57, 1.02]);
    expectSize("wall_speaker", [0.25, 0.35, 0.18]);
    expectSize("tower_speaker", [0.25, 1, 0.3]);
    expectSize("wood_stove_oven", [0.6, 0.9, 0.6]);
    expectSize("electric_stove_oven", [0.6, 0.85, 0.6]);
    expectSize("outdoor_barbecue", [0.75, 1.1, 0.55]);
    expectSize("outdoor_wood_storage", [1, 2.2, 2.5]);
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

  it("authors LED bars at unit length on the axis their placement scales", () => {
    const vertical = symbolGeometry("led_bar_vertical").boundingBox!;
    const verticalSize = vertical.getSize(new THREE.Vector3());
    expect(verticalSize.x).toBeCloseTo(0.03, 6);
    expect(verticalSize.y).toBeCloseTo(1, 6);
    expect(verticalSize.z).toBeCloseTo(0.025, 6);
    expect(vertical.min.y).toBeCloseTo(0, 6);
    expect(vertical.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 6);

    const horizontal = symbolGeometry("led_bar_horizontal").boundingBox!;
    const horizontalSize = horizontal.getSize(new THREE.Vector3());
    expect(horizontalSize.x).toBeCloseTo(1, 6);
    expect(horizontalSize.y).toBeCloseTo(0.03, 6);
    expect(horizontalSize.z).toBeCloseTo(0.025, 6);
    expect(horizontal.min.x).toBeCloseTo(-0.5, 6);
    expect(horizontal.max.x).toBeCloseTo(0.5, 6);
  });

  it("faces aimable motion sensors and security cameras along +Z", () => {
    expect(symbolGeometry("motion_sensor").boundingBox!.max.z).toBeGreaterThan(0.04);
    expect(symbolGeometry("security_camera").boundingBox!.max.z).toBeGreaterThan(0.19);
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
    expect(SYMBOL_LABEL.wifi_access_point).toBe("Wi-Fi access point");
    expect(SYMBOL_LABEL.robot_vacuum).toBe("Robot vacuum");
    expect(SYMBOL_LABEL.heat_pump_indoor).toBe("Heat pump (indoor)");
    expect(SYMBOL_LABEL.heat_pump_outdoor).toBe("Heat pump (outdoor)");
    expect(SYMBOL_LABEL.homepod).toBe("HomePod");
    expect(SYMBOL_LABEL.network_switch).toBe("Network switch");
    expect(SYMBOL_LABEL.security_camera).toBe("Security camera");
    expect(SYMBOL_LABEL.fan).toBe("Fan");
    expect(SYMBOL_LABEL.humidifier).toBe("Humidifier");
    expect(SYMBOL_LABEL.motion_sensor).toBe("Motion sensor");
    expect(SYMBOL_LABEL.led_bar_vertical).toBe("LED bar (vertical)");
    expect(SYMBOL_LABEL.led_bar_horizontal).toBe("LED bar (horizontal)");
    expect(SYMBOL_LABEL.tree).toBe("Tree");
    expect(SYMBOL_LABEL.hot_water_tank).toBe("Hot-water tank");
    expect(SYMBOL_LABEL.ventilation_machine).toBe("Ventilation machine");
    expect(SYMBOL_LABEL.wall_speaker).toBe("Wall speaker");
    expect(SYMBOL_LABEL.tower_speaker).toBe("Tower speaker");
    expect(SYMBOL_LABEL.wood_stove_oven).toBe("Wood stove with oven");
    expect(SYMBOL_LABEL.electric_stove_oven).toBe("Electric stove with oven");
    expect(SYMBOL_LABEL.outdoor_barbecue).toBe("Outdoor barbecue");
    expect(SYMBOL_LABEL.outdoor_wood_storage).toBe("Outdoor wood storage");
  });

  it("authors a floor-anchored tree at its five-metre default envelope", () => {
    const box = symbolGeometry("tree").boundingBox!;
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(3, 6);
    expect(size.y).toBeCloseTo(5, 6);
    expect(size.z).toBeCloseTo(3, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
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

  it("scales a tree to its configured physical height and gives it a wall-mode cut plane", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    try {
      markers.set(
        [placement({ id: "oak", symbol: "tree", treeHeightM: 10 })],
        () => "unlinked",
        () => "f-lower",
        () => "tree",
      );
      const mesh = markers.meshes[0]!;
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      mesh.getMatrixAt(0, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      expect(scale.toArray()).toEqual([2, 2, 2]);
      expect((mesh.material as THREE.Material).clippingPlanes).toHaveLength(3);
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
