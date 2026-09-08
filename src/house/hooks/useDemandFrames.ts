"use client";
import { useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type CameraControlsImpl from "camera-controls";
import type { RefObject } from "react";

/**
 * `frameloop="demand"` starves camera-controls' damping: the library integrates over time in
 * `update(delta)`, drei calls that from `useFrame`, and under demand the loop stops after one
 * frame — so the camera freezes mid-transition.
 *
 * This is the pump. One `invalidate()` per rendered frame **while the controls are active**
 * sustains the animation and stops the instant it settles; the event listeners are what start it
 * from idle (a wheel tick, or a `setLookAt` call while nothing is rendering).
 *
 * Priority stays at the default 0: `useFrame(cb, priority > 0)` disables R3F's automatic render.
 */
export function useDemandFrames(controlsRef: RefObject<CameraControlsImpl | null>): void {
  const invalidate = useThree((s) => s.invalidate);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (controls.active || controls.currentAction !== 0) invalidate();
  });

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const wake = () => invalidate();
    controls.addEventListener("control", wake);
    controls.addEventListener("transitionstart", wake);
    controls.addEventListener("update", wake);
    controls.addEventListener("wake", wake);
    return () => {
      controls.removeEventListener("control", wake);
      controls.removeEventListener("transitionstart", wake);
      controls.removeEventListener("update", wake);
      controls.removeEventListener("wake", wake);
    };
  }, [controlsRef, invalidate]);
}
