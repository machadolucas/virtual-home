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
const ROOM_FOCUS_POLAR_DEG = 0;
const EQUIPMENT_FOCUS_POLAR_DEG = 48;
const FLOOR_FOCUS_POLAR_DEG = 0;

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

  /** Resolves with the controls instance once its camera matches the store's projection (≤ ~10 frames). */
  const settledControls = async () => {
    const wanted = runtime.store.getState().projection === "ortho" ? "OrthographicCamera" : "PerspectiveCamera";
    for (let i = 0; i < 10; i++) {
      const c = controlsRef.current;
      if (c && (c.camera as THREE.Camera).type === wanted) return c;
      await new Promise<void>((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
    }
    return controlsRef.current;
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
          if (Math.abs(clamped - polar) > 0.5) {
            // Snap before the animated fit. Awaiting a second animation here creates a quiet gap
            // in which stable-frame observers can mistake the preceding focus for the final pose.
            await controls.rotatePolarTo(THREE.MathUtils.degToRad(clamped), false);
            controls.update(0);
          }
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
      const box = roomBox3(runtime.manifest, roomId);
      if (box.isEmpty()) return;
      await withControls(async (controls) => {
        // Snap the direction before fitting. Keeping rotation and fit in one controls operation
        // also makes a rapid floor → room tree click deterministic: the room fit supersedes the
        // in-flight floor transition instead of waiting behind it.
        await controls.rotatePolarTo(THREE.MathUtils.degToRad(ROOM_FOCUS_POLAR_DEG), false);
        controls.update(0);
        await controls.fitToBox(box, transition, {
          cover: false,
          paddingLeft: PAD,
          paddingRight: PAD,
          paddingTop: PAD,
          paddingBottom: PAD,
        });
      });
    },

    async frameFloor(floorId) {
      if (!runtime.manifest) return;
      // A floor shortcut uses the same straight-down direction as room navigation, while retaining
      // the perspective camera and ordinary `floor` view mode. The rig therefore starts as a
      // readable plan-like view but remains free to orbit immediately.
      const controls = await settledControls();
      const box = floorBox3(runtime.manifest, floorId);
      if (!controls || box.isEmpty()) return;
      await controls.rotatePolarTo(THREE.MathUtils.degToRad(FLOOR_FOCUS_POLAR_DEG), false);
      controls.update(0);
      await controls.fitToBox(box, transition, {
        cover: false,
        paddingLeft: PAD,
        paddingRight: PAD,
        paddingTop: PAD,
        paddingBottom: PAD,
      });
      runtime.invalidate();
    },

    async frameBuilding(buildingId) {
      if (!runtime.manifest) return;
      await api.fitBox(buildingBox3(runtime.manifest, buildingId));
    },

    async frameSelection() {
      const index = runtime.index;
      if (!index) return;
      const state = runtime.store.getState();
      if (state.selection?.kind === "room") {
        await api.frameRoom(state.selection.id);
        return;
      }
      if (state.selection?.kind === "equipment") {
        await api.frameEquipment(state.selection.id);
        return;
      }
      const box = boxForSelection(index, state.selection, {
        placement: (id) => state.placements.find((p) => p.id === id),
        route: (id) => state.routes.find((r) => r.id === id),
      });
      if (box) await api.fitBox(box, { clampPolar: true });
    },

    async frameEquipment(placementId) {
      const placement = runtime.store.getState().placements.find((p) => p.id === placementId);
      if (!placement) return;
      const box = equipmentBox3(placement);
      await withControls(async (controls) => {
        await controls.rotatePolarTo(THREE.MathUtils.degToRad(EQUIPMENT_FOCUS_POLAR_DEG), false);
        controls.update(0);
        await controls.fitToBox(box, transition, {
          cover: false,
          paddingLeft: PAD,
          paddingRight: PAD,
          paddingTop: PAD,
          paddingBottom: PAD,
        });
      });
    },

    async planFor(floorId) {
      if (!runtime.manifest) return;
      // A projection switch remounts <CameraControls>; wait until the live instance drives a camera
      // of the requested projection, otherwise we would steer the instance being unmounted.
      const controls = await settledControls();
      // Straight down (polar 0) with plan-north up (azimuth 0) BEFORE fitting: fitToBox keeps the
      // current view direction, so the tilt is snapped first (a plan is a cut, not a flight).
      if (controls) {
        void controls.rotateTo(0, 0, false);
        controls.update(0);
      }
      await api.fitBox(planBox3(runtime.manifest, floorId), { padding: 0.5 });
      runtime.invalidate();
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
