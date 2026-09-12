"use client";
import { useSyncExternalStore } from "react";
const defaults = { tree: 256, inspector: 320 };
let widths: typeof defaults | null = null;
const listeners = new Set<() => void>();
function snapshot() {
  if (!widths) {
    try { const saved = JSON.parse(localStorage.getItem("vh.house.panel-widths") ?? "{}"); widths = { tree: clamp(saved.tree, 256), inspector: clamp(saved.inspector, 320) }; } catch { widths = defaults; }
  }
  return widths;
}
function clamp(value: unknown, fallback: number) { return typeof value === "number" && Number.isFinite(value) ? Math.max(220, Math.min(480, value)) : fallback; }
function resize(panel: keyof typeof defaults, value: number) {
  widths = { ...snapshot(), [panel]: clamp(value, defaults[panel]) };
  try { localStorage.setItem("vh.house.panel-widths", JSON.stringify(widths)); } catch { /* Session only. */ }
  listeners.forEach((listener) => listener());
}
export function usePanelWidths() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, snapshot, () => defaults); }
export function PanelResizeHandle({ panel }: { panel: keyof typeof defaults }) {
  const width = usePanelWidths()[panel];
  return <div role="separator" aria-label={`Resize ${panel === "tree" ? "property panel" : "details panel"}`} aria-orientation="vertical" aria-valuemin={220} aria-valuemax={480} aria-valuenow={width} tabIndex={0}
    className={`absolute inset-y-0 z-10 w-2 touch-none cursor-col-resize hover:bg-accent-soft focus-visible:bg-accent-soft ${panel === "tree" ? "right-0" : "left-0"}`}
    onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const delta = event.key === "ArrowRight" ? 16 : -16; resize(panel, width + (panel === "tree" ? delta : -delta)); }}
    onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.start = `${event.clientX},${width}`; }}
    onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const [x, initial] = (event.currentTarget.dataset.start ?? "").split(",").map(Number); if (x !== undefined && initial !== undefined) resize(panel, initial + (event.clientX - x) * (panel === "tree" ? 1 : -1)); }}
    onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />;
}
