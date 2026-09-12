"use client";
import { useEffect } from "react";
import { ZoomIn, ZoomOut, Focus, RotateCcw } from "lucide-react";
import { IconButton } from "@/ui";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";

export function CameraNavigation({ input = false, inputOnly = false }: { input?: boolean; inputOnly?: boolean }) {
  const runtime = useHouseRuntime();
  const preset = useHouseStore((s) => s.inputPreset);
  useEffect(() => {
    try {
      const value = localStorage.getItem("vh.house.input");
      if (value === "trackpad" || value === "mouse") runtime.store.getState().setInputPreset(value);
    } catch { /* Preferences are optional. */ }
  }, [runtime]);
  return <div className="flex flex-wrap items-center gap-0.5">
    {!inputOnly ? <>
    <IconButton size="sm" label="Zoom in" icon={<ZoomIn />} onClick={() => { if (runtime.store.getState().projection === "ortho") void runtime.controls?.zoom(5, true); else runtime.camera?.dolly(1); }} />
    <IconButton size="sm" label="Zoom out" icon={<ZoomOut />} onClick={() => { if (runtime.store.getState().projection === "ortho") void runtime.controls?.zoom(-5, true); else runtime.camera?.dolly(-1); }} />
    <IconButton size="sm" label="Frame selection" icon={<Focus />} onClick={() => void runtime.camera?.frameSelection()} />
    <IconButton size="sm" label="Reset view" icon={<RotateCcw />} onClick={() => void runtime.camera?.overview()} />
    </> : null}
    {input || inputOnly ? <label className="flex min-h-11 items-center gap-2 text-xs">Input<select aria-label="Camera input" className="rounded border border-line bg-surface px-2 py-1 text-ink" value={preset} onChange={(e) => { const value = e.target.value === "trackpad" ? "trackpad" : "mouse"; runtime.store.getState().setInputPreset(value); try { localStorage.setItem("vh.house.input", value); } catch { /* Session preference still works. */ } }}><option value="mouse">Mouse</option><option value="trackpad">Trackpad</option></select></label> : null}
  </div>;
}
