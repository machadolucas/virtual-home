"use client";
/**
 * "Locate equipment" — the phone's whole point.
 *
 * One tap runs a single orchestrated action so it cannot half-apply: isolate the floor, switch to
 * a locked top-down plan, cut at 1.6 m, roof and ceilings off, select the marker, wait for the
 * visibility resolver, then fit a small box around the marker.
 *
 * The **written note and the close-up photo are the primary locating aids** and are shown below
 * the canvas without requiring any interaction with the 3D view; the plan is context. Ordinary
 * maintenance work never requires the 3D view at all.
 */
import { useCallback, useState } from "react";
import * as THREE from "three";
import type { PlacementId } from "@/house/model/types";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";

export function LocateSheet({ placementId }: { placementId: PlacementId }) {
  const runtime = useHouseRuntime();
  const { placements, index } = useHouseStore(
    useShallow((s) => ({ placements: s.placements, index: s.index })),
  );
  const [located, setLocated] = useState(false);
  const [unlocked, setUnlocked] = useState(false);

  const placement = placements.find((p) => p.id === placementId);

  const locate = useCallback(async () => {
    const s = runtime.store.getState();
    const p = s.placements.find((x) => x.id === placementId);
    if (!p) return;
    const floor = s.index?.floors.get(p.floorId);
    s.isolateFloor(p.floorId);
    s.setViewMode("plan");
    s.setProjection("ortho");
    s.setRoofVisible(false);
    s.setCeilingsVisible(false);
    s.setCut({ enabled: true, y: (floor?.elevation ?? 0) + 1.6, vertical: null });
    s.setExplode({ enabled: false, gap: 0 });
    runtime.select({ kind: "equipment", id: p.id });
    setLocated(true);
    // The visibility resolver runs synchronously in a store subscription; one frame hands the
    // camera the applied matrices before it fits.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await runtime.camera?.fitBox(
      new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(...p.position),
        new THREE.Vector3(4.5, 3, 4.5),
      ),
    );
  }, [runtime, placementId]);

  if (!placement || !index) return null;
  const room = placement.roomId ? index.rooms.get(placement.roomId) : undefined;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3">
      <header>
        <h2 className="text-sm font-semibold text-ink">Locate {placement.name}</h2>
        <p className="text-xs text-ink-3">
          {[room?.name, room?.nameFi, index.floors.get(placement.floorId)?.name]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void locate()}
          className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-on-accent"
        >
          {located ? "Show me again" : "Show me where it is"}
        </button>
        {located ? (
          <button
            type="button"
            onClick={() => {
              const s = runtime.store.getState();
              s.setProjection("perspective");
              s.setViewMode("floor");
              setUnlocked(true);
            }}
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink"
          >
            Show in 3D
          </button>
        ) : null}
      </div>
      {unlocked ? (
        <p className="text-[11px] text-ink-3">
          The orbit is unlocked. Tap &ldquo;Show me where it is&rdquo; to go back to the plan.
        </p>
      ) : null}

      <section>
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Where it is
        </h3>
        {placement.locationNote ? (
          <p className="mt-1 text-sm text-ink">{placement.locationNote}</p>
        ) : (
          <p className="mt-1 text-sm text-ink-3">
            No written note yet. Add one from a desktop — the words are what actually find the
            thing.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">Close-up</h3>
        {placement.photoId ? (
          // A private attachment served by an authenticated route handler: `next/image` would
          // proxy household photos through the optimizer and cache them outside that boundary.
          // eslint-disable-next-line @next/next/no-img-element -- see above
          <img
            src={`/api/attachments/${encodeURIComponent(placement.photoId)}`}
            alt={`Close-up photo of ${placement.name}`}
            className="mt-1 w-full rounded-md border border-line"
          />
        ) : (
          <p className="mt-1 text-sm text-ink-3">No close-up photo yet.</p>
        )}
      </section>
    </section>
  );
}
