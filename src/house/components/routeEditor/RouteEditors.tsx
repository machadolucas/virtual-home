"use client";
import { useState } from "react";
import type { FloorId } from "@/house/model/types";
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { useIsPhone } from "../../hooks/useReducedMotion";
import { Select } from "@/ui/Select";
import { PlanEditor2D } from "./PlanEditor2D";
import { WallElevationEditor2D } from "./WallElevationEditor2D";

export function RouteEditors() {
  const { routeDraft, activeFloorId, selection, index } = useHouseStore(
    useShallow((s) => ({
      routeDraft: s.routeDraft,
      activeFloorId: s.activeFloorId,
      selection: s.selection,
      index: s.index,
    })),
  );
  const cancelRouteDraft = useHouseStore((s) => s.cancelRouteDraft);
  const saving = useHouseStore((s) => s.editorSaving);
  const phone = useIsPhone();
  const [heldFloor, setHeldFloor] = useState<{ routeId: string; floorId: FloorId | null } | null>(null);
  if (!routeDraft || !index) return null;

  const initialFloorId: FloorId | null =
    activeFloorId ?? routeDraft.segments.find((seg) => seg.floorId)?.floorId ?? index.floorOrder[0] ?? null;
  const floorId = heldFloor?.routeId === routeDraft.id ? heldFloor.floorId : initialFloorId;
  const wallSurfaceId =
    selection?.kind === "surface" && index.surfaces.get(selection.id)?.kind === "wall"
      ? selection.id
      : null;

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Route path — {routeDraft.name}
        </h3>
        <button
          type="button"
          disabled={saving}
          onClick={cancelRouteDraft}
          className="min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Cancel path edit
        </button>
      </header>
      {phone ? (
        <p className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2">
          The 2D route editors are read-only on a phone. Edit on a desktop.
        </p>
      ) : null}
      {index.floorOrder.length > 1 ? (
        <label className="flex flex-col gap-1 text-xs text-ink-2">
          Plan floor
          <Select
            selectSize="sm"
            value={floorId ?? ""}
            onValueChange={(value) =>
              setHeldFloor({ routeId: routeDraft.id, floorId: (value || null) as FloorId | null })
            }
            options={index.floorOrder.map((id) => ({
              value: id,
              label: index.floors.get(id)?.name ?? id,
            }))}
          />
        </label>
      ) : null}
      {floorId ? <PlanEditor2D floorId={floorId} /> : null}
      {wallSurfaceId ? <WallElevationEditor2D surfaceId={wallSurfaceId} /> : (
        <p className="text-[11px] text-ink-3">
          Select a wall surface to edit this route in that wall&rsquo;s elevation.
        </p>
      )}
    </section>
  );
}
