"use client";
import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import type CameraControlsImpl from "camera-controls";
import type { RefObject } from "react";

/**
 * Wake the demand renderer for imperative camera operations and pointer gestures. Every actual
 * controls update requests the next frame; when no update occurs, the loop can sleep.
 *
 * Do not pump from `controls.active`: camera-controls exposes `!_hasRested`, which can remain true
 * after a one-frame snapped change (wake → sleep without a rest event). Polling it would render
 * forever even though the camera no longer moves. Drei also invalidates on update/wake, including
 * when it replaces the controls instance after switching the camera.
 */
export function useDemandFrames(controlsRef: RefObject<CameraControlsImpl | null>): void {
  const invalidate = useThree((s) => s.invalidate);

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
