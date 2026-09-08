"use client";
/**
 * Room inspector: names, certainty, area, and the per-surface colour pickers.
 *
 * The floor and each room-facing wall are exposed **independently**, by name, so the colour picker
 * is a full non-3D route to the same capability. Certainty is always shown, because "inferred" is
 * a fact the household needs when deciding whether to trust a dimension.
 */
import { useMemo } from "react";
import { planRoomColors } from "@/house/model/colorPlan";
import type { RoomId, SurfaceKind } from "@/house/model/types";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { IssueList } from "./IssueList";

const KIND_LABELS: Record<SurfaceKind, string> = {
  floor: "Floor",
  wall: "Wall",
  ceiling: "Ceiling",
  other: "Other",
};

export function RoomInspector({ roomId }: { roomId: RoomId }) {
  const runtime = useHouseRuntime();
  const { index, overrides, saveState, saveError } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      overrides: s.overrides,
      saveState: s.saveState,
      saveError: s.saveError,
    })),
  );
  const setOverride = useHouseStore((s) => s.setOverride);
  const clearOverrides = useHouseStore((s) => s.clearOverrides);

  const room = index?.rooms.get(roomId);
  const plan = useMemo(
    () => (room && index ? planRoomColors(room, index.surfaces, overrides) : []),
    [room, index, overrides],
  );

  if (!index || !room) return null;
  const floor = index.floors.get(room.floorId);
  const issues = index.issuesByAffected.get(room.id) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-neutral-900">{room.name}</h2>
        <p className="text-xs text-neutral-500">
          {[room.nameFi, floor?.name, room.kind && room.kind !== "room" ? room.kind : null]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Area" value={room.area !== undefined ? `${room.area.toFixed(2)} m²` : "—"} />
        <Row label="Floor level" value={`${room.floorElevation.toFixed(2)} m`} />
        <Row
          label="Ceiling height"
          value={room.ceilingHeight !== undefined ? `${room.ceilingHeight.toFixed(2)} m` : "—"}
        />
        <Row label="Certainty" value={room.certainty ?? "unknown"} />
      </dl>

      {room.note ? <p className="text-xs text-neutral-600">{room.note}</p> : null}
      {room.aliases.length ? (
        <p className="text-xs text-neutral-500">Also called: {room.aliases.join(", ")}</p>
      ) : null}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Colours</h3>
          <button
            type="button"
            onClick={() => clearOverrides(plan.map((d) => d.surfaceId))}
            className="min-h-8 rounded-md border border-neutral-300 bg-white px-2 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
          >
            Reset room
          </button>
        </div>
        {saveState === "local" ? (
          <p className="text-[11px] text-amber-700">
            Colours are kept for this session only — the model package has not been imported into
            the database yet, so there is nowhere to save them.
          </p>
        ) : null}
        {saveError ? <p className="text-[11px] text-red-700">{saveError}</p> : null}
        <ul className="flex flex-col gap-1">
          {plan.map((decision) => {
            const surface = index.surfaces.get(decision.surfaceId);
            if (!surface) return null;
            return (
              <li key={decision.surfaceId} className="flex min-h-9 items-center gap-2">
                <input
                  type="color"
                  value={decision.hex}
                  onChange={(event) => setOverride(decision.surfaceId, event.currentTarget.value)}
                  aria-label={`${KIND_LABELS[surface.kind]} colour — ${decision.surfaceId}`}
                  className="h-7 w-9 shrink-0 rounded border border-neutral-300"
                />
                <button
                  type="button"
                  onClick={() => runtime.select({ kind: "surface", id: decision.surfaceId })}
                  className="min-w-0 flex-1 truncate text-left text-xs text-neutral-800 hover:underline"
                >
                  {KIND_LABELS[surface.kind]}
                  {surface.role ? ` · ${surface.role}` : ""}
                  <span className="ml-1 font-mono text-[10px] text-neutral-400">
                    {decision.surfaceId}
                  </span>
                </button>
                {decision.source === "override" ? (
                  <span className="shrink-0 rounded bg-sky-100 px-1 text-[10px] text-sky-800">
                    changed
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <IssueList issues={issues} />
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-mono text-neutral-900">{value}</dd>
    </>
  );
}
