"use client";
/**
 * Phone layout: single column, the 3D view present but **demoted and simplified**.
 *
 * Simplifications (§12), all of them decisions rather than accidents:
 *  - the structure and scan layers are neither loaded nor offered (`planTiers` already drops them
 *    on a phone), so the layer list here is short on purpose;
 *  - drag placement is not offered — the numeric sheet is the editor;
 *  - the exploded view is unavailable: it needs precise orbiting to be legible;
 *  - the 2D route editors are read-only.
 *
 * The order is task-first: header, Locate card, then the written note and the photo. A user
 * finishing an ordinary maintenance job never has to touch the canvas.
 */
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { HouseCanvasLazy } from "../HouseCanvasLazy";
import { HouseErrorBoundary } from "../HouseErrorBoundary";
import { PlacementEditor } from "../edit/PlacementEditor";
import { Inspector } from "../inspector/Inspector";
import { LocateSheet } from "./LocateSheet";

export function PhoneHouse() {
  const runtime = useHouseRuntime();
  const { index, activeFloorId, selection, placements, editing, announcement } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      activeFloorId: s.activeFloorId,
      selection: s.selection,
      placements: s.placements,
      editing: s.editing !== null,
      announcement: s.announcement,
    })),
  );
  const isolateFloor = useHouseStore((s) => s.isolateFloor);

  const floors = index?.floorOrder ?? [];
  const equipmentId = selection?.kind === "equipment" ? selection.id : null;
  const floorEquipment = placements.filter(
    (p) => !activeFloorId || p.floorId === activeFloorId,
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-semibold text-neutral-900">
          {index?.manifest.name ?? "House"}
        </h1>
        <p className="text-xs text-neutral-500">
          The plan is context. The written note and the photo are what find the thing.
        </p>
      </header>

      <nav aria-label="Floors" className="flex flex-wrap gap-1">
        <FloorChip label="All" active={activeFloorId === null} onClick={() => isolateFloor(null)} />
        {floors.map((floorId) => (
          <FloorChip
            key={floorId}
            label={index?.floors.get(floorId)?.name ?? floorId}
            active={activeFloorId === floorId}
            onClick={() => {
              isolateFloor(floorId);
              void runtime.camera?.frameFloor(floorId);
            }}
          />
        ))}
      </nav>

      <div className="relative h-64 shrink-0">
        <HouseErrorBoundary>
          <HouseCanvasLazy />
        </HouseErrorBoundary>
      </div>

      {equipmentId ? <LocateSheet placementId={equipmentId} /> : null}

      <section className="rounded-lg border border-neutral-200 bg-white p-3">
        {editing ? <PlacementEditor /> : <Inspector />}
      </section>

      <section className="rounded-lg border border-neutral-200 bg-white p-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Equipment on this floor
        </h2>
        {floorEquipment.length === 0 ? (
          <p className="mt-1 text-sm text-neutral-500">Nothing placed here yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {floorEquipment.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => runtime.select({ kind: "equipment", id: p.id })}
                  className="min-h-11 w-full truncate text-left text-sm text-neutral-800"
                >
                  {p.name}
                  <span className="ml-1 text-xs text-neutral-500">
                    {p.roomId ? (index?.rooms.get(p.roomId)?.name ?? p.roomId) : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function FloorChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 rounded-full border px-3 text-sm font-medium ${
        active
          ? "border-sky-700 bg-sky-700 text-white"
          : "border-neutral-300 bg-white text-neutral-800"
      }`}
    >
      {label}
    </button>
  );
}
