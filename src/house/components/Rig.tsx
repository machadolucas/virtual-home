"use client";
/* eslint-disable react-hooks/immutability -- `HouseRuntime` is a deliberately mutable,
   non-reactive box handed around by context (see `src/house/runtime.ts`): the imperative layer
   publishes its handles onto it and React never re-renders because of it. The React Compiler
   rule assumes a hook's return value is immutable, which is precisely the assumption this
   design breaks on purpose — the alternative is putting `Object3D`s in React state. */
/**
 * Camera + controls.
 *
 * Drei `CameraControls` (over `camera-controls`) with `makeDefault`, chosen for `fitToBox` (which
 * fits along the *current* view direction, so "preserve orientation" is free), the promise-returning
 * damped `setLookAt`, per-mode axis locking for the plan view, and correct behaviour in ortho.
 *
 * `key={projection}` re-binds the controls cleanly on a projection switch, and the outgoing pose is
 * re-applied without a transition so the view does not jump.
 */
import { useEffect, useRef } from "react";
import { OrthographicCamera, PerspectiveCamera, CameraControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import CameraControlsImpl from "camera-controls";
import * as THREE from "three";
import { useDemandFrames } from "../hooks/useDemandFrames";
import { makeCameraApi } from "../hooks/useCameraApi";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { useReducedMotion } from "../hooks/useReducedMotion";

const ACTION = CameraControlsImpl.ACTION;

export function Rig() {
  const runtime = useHouseRuntime();
  const reduced = useReducedMotion();
  const projection = useHouseStore((s) => s.projection);
  const viewMode = useHouseStore((s) => s.viewMode);
  const controlsRef = useRef<CameraControlsImpl | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const poseRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);

  useDemandFrames(controlsRef);

  // Publish the camera API on the runtime so the chrome, the shortcuts and the test hook all
  // drive the camera through exactly one path.
  useEffect(() => {
    runtime.camera = makeCameraApi(controlsRef, runtime, reduced);
    runtime.controls = controlsRef.current;
    return () => {
      runtime.camera = null;
      runtime.controls = null;
    };
  }, [runtime, reduced, projection]);

  // Remember the outgoing pose so the projection switch is seamless. The controls instance is
  // captured on mount rather than read in the cleanup, because by cleanup time `<CameraControls>`
  // (keyed on the projection) has already been unmounted and the ref cleared.
  useEffect(() => {
    const controls = controlsRef.current;
    return () => {
      if (!controls) return;
      const position = new THREE.Vector3();
      const target = new THREE.Vector3();
      controls.getPosition(position);
      controls.getTarget(target);
      poseRef.current = { position, target };
    };
  }, [projection]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const pose = poseRef.current;
    if (pose) {
      void controls.setLookAt(
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.target.x,
        pose.target.y,
        pose.target.z,
        false,
      );
    }
    invalidate();
  }, [projection, invalidate]);

  /**
   * Plan view locks the rig: without this, one stray drag tumbles the camera out of plan, which is
   * the main way an orthographic plan becomes confusing.
   */
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const planLocked = viewMode === "plan";
    if (planLocked) {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = 0;
      controls.azimuthRotateSpeed = 0;
      controls.mouseButtons.left = ACTION.TRUCK;
      controls.mouseButtons.wheel = ACTION.ZOOM;
      controls.touches.one = ACTION.TOUCH_TRUCK;
    } else {
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = Math.PI * 0.98;
      controls.azimuthRotateSpeed = 1;
      controls.mouseButtons.left = ACTION.ROTATE;
      controls.mouseButtons.wheel = projection === "ortho" ? ACTION.ZOOM : ACTION.DOLLY;
      controls.touches.one = ACTION.TOUCH_ROTATE;
    }
    invalidate();
  }, [viewMode, projection, invalidate]);

  return (
    <>
      {projection === "perspective" ? (
        <PerspectiveCamera makeDefault fov={45} near={0.05} far={500} position={[22, 16, 24]} />
      ) : (
        // Negative `near` so geometry behind the camera plane still renders in a plan view.
        <OrthographicCamera makeDefault near={-200} far={400} position={[22, 16, 24]} zoom={40} />
      )}
      <CameraControls
        key={projection}
        ref={controlsRef}
        makeDefault
        smoothTime={reduced ? 0 : 0.25}
        draggingSmoothTime={reduced ? 0 : 0.125}
        minDistance={0.6}
        maxDistance={140}
      />
    </>
  );
}
