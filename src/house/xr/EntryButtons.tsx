"use client";
import { useEffect, useState } from "react";
import { FrameTiming } from "./FrameTiming";
import { Button } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { probeModes, type ImmersiveMode } from "./presentation";

export function EntryButtons() {
  const runtime = useHouseRuntime();
  const phase = useHouseStore(s => s.phase);
  const [supported, setSupported] = useState({ vr: false, mr: false });
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let live = true;
    const xr = navigator.xr;
    const check = () => { void probeModes(xr, window.isSecureContext).then(result => { if (live) setSupported(result); }); };
    check(); xr?.addEventListener("devicechange", check);
    return () => { live = false; xr?.removeEventListener("devicechange", check); };
  }, []);
  const enter = async (mode: ImmersiveMode) => {
    setError(""); setStarting(true);
    try {
      if (!runtime.enterImmersive) throw new Error("The 3D scene is still loading.");
      await runtime.enterImmersive(mode);
    } catch (err) { setError(err instanceof Error ? err.message : "The headset declined the session."); }
    finally { setStarting(false); }
  };
  const loading = starting || !["interactive", "enriching", "ready", "degraded"].includes(phase);
  if (!supported.vr && !supported.mr && !error) return null;
  return <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label="Headset modes">{supported.vr && <Button size="sm" disabled={loading} onClick={() => void enter("vr")}>Enter VR</Button>}
    {supported.mr && <Button size="sm" disabled={loading} onClick={() => void enter("mr")}>Enter mixed reality</Button>}
    {supported.mr && <Button size="sm" disabled={loading} onClick={() => void enter("survey")}>Survey room</Button>}
    {supported.vr && <details className="text-xs text-muted"><summary className="cursor-pointer px-1">Quest controls</summary>
      <p className="max-w-64 p-1">Walk with the left stick. Hold the right stick forward, aim and release to teleport. Squeeze a grip for the menu. With hands, hold a floor pinch to aim, or point and pinch the wrist menu.</p></details>}
    {(supported.vr || supported.mr) && <FrameTiming userId={runtime.userId} />}
    {error && <p role="alert" className="text-xs text-overdue">{error}</p>}</div>;
}
