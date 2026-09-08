"use client";
/**
 * The code-splitting boundary. `ssr: false` is only legal inside a Client Component in Next 15/16,
 * which is why this wrapper exists at all: `HouseWorkspace`'s chrome can render on the server, and
 * only this chunk pulls in three / R3F / drei.
 */
import dynamic from "next/dynamic";

export const HouseCanvasLazy = dynamic(() => import("./HouseCanvas").then((m) => m.HouseCanvas), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

export function CanvasSkeleton() {
  return (
    <div
      className="flex h-full w-full items-center justify-center rounded-lg bg-neutral-100"
      role="status"
      aria-live="polite"
    >
      <span className="text-sm text-neutral-500">Preparing the 3D view…</span>
    </div>
  );
}
