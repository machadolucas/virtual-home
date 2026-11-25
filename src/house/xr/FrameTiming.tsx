"use client";
import { useSyncExternalStore } from "react";
import { timingEvent, timingKey, type TimingRow } from "./frameLog";
function subscribe(notify: () => void) {
  window.addEventListener(timingEvent, notify);
  return () => window.removeEventListener(timingEvent, notify);
}
export function FrameTiming({ userId }: { userId?: string }) {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return localStorage.getItem(timingKey(userId)) ?? "";
      } catch {
        return "";
      }
    },
    () => "",
  );
  let rows: TimingRow[] = [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value))
      rows = value.filter((r) => r && typeof r.area === "string" && Number.isFinite(r.p95Ms));
  } catch {
    /* no completed session */
  }
  if (!rows.length) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer">Last headset frame timing</summary>
      <ul>
        {rows.map((r) => (
          <li key={r.area}>
            {r.area} · {r.samples} frames · {r.hz} Hz target · p95 {r.p95Ms} ms · {r.missedPercent}% late
          </li>
        ))}
      </ul>
    </details>
  );
}
