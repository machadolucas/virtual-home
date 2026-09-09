"use client";
/* eslint-disable react-hooks/immutability -- HouseRuntime is the imperative context, like SceneRoot. */

import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { captureHouseView } from "../capture";
import { useHouseRuntime } from "../hooks/useHouseStore";

/** Mounted after label projectors so capture sees this frame's camera and label coordinates. */
export function CaptureBridge({ hostRef, labelRef }: {
  hostRef: RefObject<HTMLDivElement | null>;
  labelRef: RefObject<HTMLDivElement | null>;
}) {
  const runtime = useHouseRuntime();
  const invalidate = useThree((s) => s.invalidate);
  const renderer = useThree((s) => s.gl);
  const pending = useRef<{ resolve(blob: Blob): void; reject(error: Error): void } | null>(null);
  useEffect(() => {
    runtime.captureImage = () => new Promise<Blob>((resolve, reject) => {
      if (renderer.getContext().isContextLost()) { reject(new Error("The 3D view is unavailable. Reload it before capturing an image.")); return; }
      if (pending.current) { reject(new Error("An image is already being captured.")); return; }
      pending.current = { resolve, reject };
      invalidate();
    });
    return () => {
      runtime.captureImage = null;
      pending.current?.reject(new Error("The 3D view closed before capture completed."));
      pending.current = null;
    };
  }, [runtime, invalidate, renderer]);
  useFrame(({ gl, scene, camera }) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    const host = hostRef.current;
    if (!host) { request.reject(new Error("The 3D view is not ready.")); return; }
    void captureHouseView({ renderer: gl, scene, camera, host, labelHost: labelRef.current,
      background: runtime.store.getState().background }).then(request.resolve, request.reject);
  });
  return null;
}
