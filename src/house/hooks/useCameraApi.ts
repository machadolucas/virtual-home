"use client";
import { useMemo } from "react";
import * as THREE from "three";
import type CameraControlsImpl from "camera-controls";
import type { RefObject } from "react";
import { boxForSelection, buildingBox3, equipmentBox3, floorBox3, planBox3, propertyBox3, roomBox3 } from "@/house/scene/framing";
import type { CameraApi, HouseRuntime } from "../runtime";

/**
 * Deterministic overview pose. An explicit pose rather than `controls.reset()`, so "reset" always
 * lands in the same place no matter what happened before; `saveState()` is still called once after
 * the first `overview()` so `reset()` remains a secondary escape hatch.
 */
export const OVERVIEW_TARGET: [number, number, number] = [5.65, 1.5, 5.05];
export const OVERVIEW_OFFSET: [number, number, number] = [16, 14, 18];

const PAD = 0.6;
const MIN_POLAR_DEG = 15;
const MAX_POLAR_DEG = 70;

export function useCameraApi(
  controlsRef: RefObject<CameraControlsImpl | null>,
  runtime: HouseRuntime,
  reducedMotion: boolean,
): CameraApi {
  return useMemo(
    () => makeCameraApi(controlsRef, runtime, reducedMotion),
    [controlsRef, runtime, reducedMotion],
  );
}

export function makeCameraApi(
  controlsRef: RefObject<CameraControlsImpl | null>,
  runtime: HouseRuntime,
  reducedMotion: boolean,
): CameraApi {
  const transition = !reducedMotion;
  let savedOnce = false;

  const withControls = async (fn: (c: CameraControlsImpl) => Promise<unknown> | void) => {
    const controls = controlsRef.current;
    if (!controls) return;
    await fn(controls);
    runtime.invalidate();
  };

  const centreOfProperty = (): [number, number, number] => {
    const index = runtime.manifest;
    if (!index) return OVERVIEW_TARGET;
    const box = propertyBox3(index);
    const houseId = [...index.buildings.keys()][0];
    const houseBox = houseId ? buildingBox3(index, houseId) : box;
    const centre = houseBox.isEmpty() ? box.getCenter(new THREE.Vector3()) : houseBox.getCenter(new THREE.Vector3());
    return [centre.x, Math.max(1.2, centre.y), centre.z];
  };

  const api: CameraApi = {
    async overview() {
      const target = runtime.manifest ? centreOfProperty() : OVERVIEW_TARGET;
      await withControls(async (controls) => {
        await controls.setLookAt(
          target[0] + OVERVIEW_OFFSET[0],
          target[1] + OVERVIEW_OFFSET[1],
          target[2] + OVERVIEW_OFFSET[2],
          target[0],
          target[1],
          target[2],
          transition,
        );
        if (!savedOnce) {
          controls.saveState();
          savedOnce = true;
        }
      });
    },

    async fitBox(box, opts = {}) {
      if (box.isEmpty()) return;
      const padding = opts.padding ?? PAD;
      await withControls(async (controls) => {
        // Framing a room from straight overhead in the middle of a plan view produces a
        // confusing pose, so clamp the polar angle into a readable band first.
        if (opts.clampPolar) {
          const polar = THREE.MathUtils.radToDeg(controls.polarAngle);
          const clamped = THREE.MathUtils.clamp(polar, MIN_POLAR_DEG, MAX_POLAR_DEG);
          if (Math.abs(clamped - polar) > 0.5)
            await controls.rotatePolarTo(THREE.MathUtils.degToRad(clamped), transition);
        }
        // `fitToBox` fits along the CURRENT view direction, which satisfies "preserve
        // orientation" for free — no azimuth bookkeeping.
        await controls.fitToBox(box, transition, {
          cover: false,
          paddingLeft: padding,
          paddingRight: padding,
          paddingTop: padding,
          paddingBottom: padding,
        });
      });
    },

    async frameRoom(roomId) {
      if (!runtime.manifest) return;
      await api.fitBox(roomBox3(runtime.manifest, roomId), { clampPolar: true });
    },

    async frameFloor(floorId) {
      if (!runtime.manifest) return;
      await api.fitBox(floorBox3(runtime.manifest, floorId));
    },

    async frameBuilding(buildingId) {
      if (!runtime.manifest) return;
      await api.fitBox(buildingBox3(runtime.manifest, buildingId));
    },

    async frameSelection() {
      const index = runtime.index;
      if (!index) return;
      const state = runtime.store.getState();
      const box = boxForSelection(index, state.selection, {
        placement: (id) => state.placements.find((p) => p.id === id),
        route: (id) => state.routes.find((r) => r.id === id),
      });
      if (box) await api.fitBox(box, { clampPolar: true });
    },

    async frameEquipment(placementId) {
      const placement = runtime.store.getState().placements.find((p) => p.id === placementId);
      if (placement) await api.fitBox(equipmentBox3(placement));
    },

    async planFor(floorId) {
      if (!runtime.manifest) return;
      await api.fitBox(planBox3(runtime.manifest, floorId), { padding: 0.5 });
    },

    orbit(dAzimuthDeg, dPolarDeg) {
      const controls = controlsRef.current;
      if (!controls) return;
      controls.rotate(
        THREE.MathUtils.degToRad(dAzimuthDeg),
        THREE.MathUtils.degToRad(dPolarDeg),
        transition,
      );
      runtime.invalidate();
    },

    truck(dx, dy) {
      controlsRef.current?.truck(dx, dy, transition);
      runtime.invalidate();
    },

    dolly(delta) {
      controlsRef.current?.dolly(delta, transition);
      runtime.invalidate();
    },

    pose() {
      const controls = controlsRef.current;
      const position = new THREE.Vector3();
      const target = new THREE.Vector3();
      if (controls) {
        controls.getPosition(position);
        controls.getTarget(target);
      }
      return {
        position: [position.x, position.y, position.z],
        target: [target.x, target.y, target.z],
      };
    },
  };

  return api;
}
