import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  detectionRange,
  isAimableSymbol,
  isDirectionalSymbol,
  isLedBar,
  ledLength,
  ledSource,
  showDetectionGuide,
} from "@/house/model/equipmentOptics";
import { directionFromAim } from "@/house/model/equipmentLight";
import type { Placement } from "@/house/model/types";
import { MarkerLayer } from "@/house/scene/markers";
import type { PlacementSymbol } from "@/house/scene/symbols";
import { FIXTURE_DIR } from "./glb";
import { buildScene } from "./sceneFromGlb";

const placement = (
  id: string,
  symbol: PlacementSymbol,
  over: Partial<Placement> = {},
): Placement => ({
  id,
  modelId: "fixture-house",
  equipmentId: `equipment-${id}`,
  name: id,
  position: [2, 1, 3],
  rotationYDeg: 0,
  mount: { kind: "free", height: 1 },
  floorId: "f-lower",
  roomId: null,
  surfaceId: null,
  locationNote: "",
  photoId: null,
  entityId: null,
  symbol,
  category: null,
  ...over,
});

const link = (deviceClass: string | null) => ({
  entityId: "binary_sensor.fixture",
  role: "status" as const,
  name: "Fixture",
  deviceClass,
  unit: null,
});

describe("equipment optics", () => {
  it("classifies LED bars, directional equipment and aimable symbols", () => {
    expect(isLedBar("led_bar_vertical")).toBe(true);
    expect(isLedBar("led_bar_horizontal")).toBe(true);
    expect(isLedBar("floor_lamp")).toBe(false);

    for (const symbol of ["sensor", "motion_sensor", "security_camera"]) {
      expect(isDirectionalSymbol(symbol), symbol).toBe(true);
      expect(isAimableSymbol(symbol), symbol).toBe(true);
    }
    expect(isAimableSymbol("wall_spot")).toBe(true);
    expect(isDirectionalSymbol("wall_spot")).toBe(false);
    expect(isAimableSymbol(null)).toBe(false);
  });

  it("accepts physical values only inside the supported ranges", () => {
    expect(ledLength(0.05)).toBe(0.05);
    expect(ledLength(20)).toBe(20);
    for (const value of [undefined, null, NaN, Infinity, 0.049, 20.001]) {
      expect(ledLength(value), String(value)).toBe(1);
    }

    expect(detectionRange(0.1)).toBe(0.1);
    expect(detectionRange(30)).toBe(30);
    for (const value of [undefined, null, NaN, -Infinity, 0.099, 30.001]) {
      expect(detectionRange(value), String(value)).toBe(5);
    }
  });

  it("shows detection guides only when the symbol or linked HA class supports one", () => {
    expect(showDetectionGuide(placement("camera", "security_camera"))).toBe(true);
    expect(showDetectionGuide(placement("pir", "motion_sensor"))).toBe(true);
    expect(showDetectionGuide(placement("aimed", "sensor", { lightAim: { yawDeg: 10, pitchDeg: -5 } }))).toBe(true);
    for (const deviceClass of ["motion", "occupancy", "presence"]) {
      expect(
        showDetectionGuide(placement(deviceClass, "sensor", { linkedEntities: [link(deviceClass)] })),
        deviceClass,
      ).toBe(true);
    }
    expect(showDetectionGuide(placement("temperature", "sensor", { linkedEntities: [link("temperature")] }))).toBe(false);
    expect(showDetectionGuide(placement("plain", "sensor"))).toBe(false);
    expect(showDetectionGuide(placement("lamp", "floor_lamp", { linkedEntities: [link("motion")] }))).toBe(false);
  });

  it("places a vertical bar's light at its centre and preserves horizontal-bar height", () => {
    expect(ledSource([2, 3, 4], "led_bar_vertical", 2.4, 0.7)).toEqual([2, 4.9, 4]);
    expect(ledSource([2, 3, 4], "led_bar_horizontal", 2.4, 0.7)).toEqual([2, 3.7, 4]);
  });
});

describe("equipment marker optical transforms", () => {
  it("scales LED length on only the authored axis", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    try {
      markers.set(
        [
          placement("vertical", "led_bar_vertical", { ledLengthM: 2.4 }),
          placement("horizontal", "led_bar_horizontal", { ledLengthM: 3.6 }),
        ],
        () => "live",
        () => "f-lower",
        (p) => p.symbol as PlacementSymbol,
      );

      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const vertical = markers.meshes.find((mesh) => mesh.name.endsWith("led_bar_vertical"))!;
      vertical.getMatrixAt(0, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(position.toArray()).toEqual([2, 1, 3]);
      expect(scale.x).toBeCloseTo(1);
      expect(scale.y).toBeCloseTo(2.4);
      expect(scale.z).toBeCloseTo(1);

      const horizontal = markers.meshes.find((mesh) => mesh.name.endsWith("led_bar_horizontal"))!;
      horizontal.getMatrixAt(0, matrix);
      matrix.decompose(position, quaternion, scale);
      expect(scale.x).toBeCloseTo(3.6);
      expect(scale.y).toBeCloseTo(1);
      expect(scale.z).toBeCloseTo(1);
      expect(vertical.castShadow).toBe(false);
      expect(horizontal.castShadow).toBe(false);
    } finally {
      markers.dispose();
    }
  });

  it("rotates each directional symbol's local +Z front to its physical aim", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    const aim = { yawDeg: 55, pitchDeg: 24 };
    try {
      for (const symbol of ["sensor", "motion_sensor", "security_camera"] as const) {
        markers.set(
          [placement(symbol, symbol, { rotationYDeg: -80, lightAim: aim })],
          () => "live",
          () => "f-lower",
          () => symbol,
        );
        const mesh = markers.meshes.find((candidate) => candidate.name.endsWith(symbol))!;
        const matrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        mesh.getMatrixAt(0, matrix);
        matrix.decompose(position, quaternion, scale);
        const actual = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
        const expected = new THREE.Vector3(...directionFromAim(aim));
        expect(actual.distanceTo(expected), symbol).toBeLessThan(1e-6);
      }
    } finally {
      markers.dispose();
    }
  });

  it("uses placement yaw as the default horizontal aim", () => {
    const built = buildScene(FIXTURE_DIR);
    const markers = new MarkerLayer(built.index, built.clip);
    try {
      markers.set(
        [placement("camera", "security_camera", { rotationYDeg: 90, lightAim: null })],
        () => "live",
        () => "f-lower",
        () => "security_camera",
      );
      const matrix = new THREE.Matrix4();
      markers.meshes[0]!.getMatrixAt(0, matrix);
      const actual = new THREE.Vector3(0, 0, 1).transformDirection(matrix);
      expect(actual.distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-6);
    } finally {
      markers.dispose();
    }
  });
});
