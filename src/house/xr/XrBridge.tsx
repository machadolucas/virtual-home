"use client";
/* eslint-disable react-hooks/immutability -- HouseRuntime holds imperative renderer handles. */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useHouseRuntime } from "../hooks/useHouseStore";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { useVentilationFeedback } from "../components/VentilationFeedbackContext";
import { airMotionRate } from "../components/SceneRoot";
import { HouseSession } from "./session";
import { requestHouseSession } from "./presentation";
import type { VentilationFeedback } from "@/domain/ventilationFeedback";

function reading(value: VentilationFeedback) {
  return "percentage" in value ? `${value.percentage}%` : value.status;
}
export function XrBridge() {
  const runtime = useHouseRuntime();
  const gl = useThree(s => s.gl);
  const active = useRef<HouseSession | null>(null);
  const fans = useVentilationFeedback();
  const reduced = useReducedMotion();
  useEffect(() => {
    let closed = false, starting = false;
    let pending: XRSession | null = null;
    runtime.enterImmersive = async mode => {
      if (closed || starting || active.current) return;
      if (!runtime.index || !runtime.manifest || !runtime.scene || !runtime.store.getState().fingerprint)
        throw new Error("Wait for the house model to load.");
      if (!navigator.xr || !window.isSecureContext) throw new Error("Open House over HTTPS in a WebXR browser.");
      if (mode === "mr" && !runtime.userId) throw new Error("Sign in again before calibrating the room.");
      starting = true;
      let session: XRSession | null = null;
      let ended = false;
      const finish = () => {
        ended = true;
        if (active.current?.session === session) { active.current.dispose(); active.current = null; }
        if (pending === session) pending = null;
      };
      try {
        // Keep requestSession on the original button gesture: no async probing here.
        session = await requestHouseSession(navigator.xr, mode);
        pending = session;
        session.addEventListener("end", finish, { once: true });
        if (closed) throw new Error("House view has closed.");
        if (mode === "mr" && session.environmentBlendMode === "opaque") throw new Error("This session does not provide passthrough.");
        const space = await session.requestReferenceSpace("local-floor");
        if (closed || ended) throw new Error("The headset session ended.");
        active.current = new HouseSession(runtime, session, mode, space);
        gl.xr.setReferenceSpaceType("local-floor");
        gl.xr.enabled = true;
        await gl.xr.setSession(session);
        if (closed || ended) throw new Error("The headset session ended.");
        gl.xr.setReferenceSpace(space);
      } catch (error) {
        if (session && !ended) await session.end().catch(() => {});
        finish();
        if (!gl.xr.isPresenting) gl.xr.enabled = false;
        throw error;
      } finally { starting = false; }
    };
    return () => {
      closed = true; delete runtime.enterImmersive;
      if (pending) void pending.end().catch(() => {});
      active.current?.dispose(); active.current = null;
    };
  }, [runtime, gl]);
  // Positive priority substitutes exactly one render. Desktop retains the existing demand loop.
  useFrame(({ scene, camera }, delta, frame) => {
    if (frame && active.current) {
      active.current.frame(gl, frame, delta, { motion: !reduced, rates: {
        supply: airMotionRate(fans.supply), extract: airMotionRate(fans.extract) },
        fans: `Supply ${reading(fans.supply)} · Extract ${reading(fans.extract)}` });
    } else if (!gl.xr.isPresenting) gl.render(scene, camera);
  }, 1);
  return null;
}
