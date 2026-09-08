"use client";
/**
 * The numeric fields **are** the authority: the drag path writes the same draft these fields edit,
 * and both go through `resolveSnap`/`resolveNumeric`, so typing and dragging cannot diverge.
 *
 * On a phone this is the whole editor (§7.3): drag placement is not offered there.
 */
import { resolveNumeric } from "@/house/scene/snap";
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";

export function NumericPlacementFields() {
  const { editing, snap, index } = useHouseStore(
    useShallow((s) => ({ editing: s.editing, snap: s.snap, index: s.index })),
  );
  const updateDraft = useHouseStore((s) => s.updateDraft);
  if (!editing || !index) return null;

  const room = editing.roomId ? index.rooms.get(editing.roomId) : undefined;
  const floor = index.floors.get(editing.floorId);

  const commit = (patch: Partial<typeof editing>) => {
    const next = { ...editing, ...patch };
    const solution = resolveNumeric(index, next, snap);
    updateDraft(
      {
        ...patch,
        physical: solution.physical,
        rotationYDeg: solution.rotationYDeg,
        roomId: solution.roomId,
      },
      { coalesce: true },
    );
  };

  const axis = (i: 0 | 1 | 2, label: string) => (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-ink-3">{label} (m)</span>
      <input
        type="number"
        step={0.05}
        value={editing.physical[i]}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (!Number.isFinite(value)) return;
          const physical: [number, number, number] = [...editing.physical];
          physical[i] = value;
          commit({ physical });
        }}
        className="min-h-9 rounded-md border border-line px-2 font-mono text-xs"
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        {axis(0, "X")}
        {axis(1, "Y")}
        {axis(2, "Z")}
      </div>

      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-ink-3">Rotation around Y (°)</span>
        <input
          type="number"
          step={15}
          value={editing.rotationYDeg}
          onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (Number.isFinite(value)) commit({ rotationYDeg: value });
          }}
          className="min-h-9 rounded-md border border-line px-2 font-mono text-xs"
        />
      </label>

      <fieldset className="flex flex-col gap-1 text-xs">
        <legend className="text-ink-3">Mount</legend>
        <div className="flex gap-2">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="mount"
              checked={editing.mount.kind === "floor"}
              onChange={() => commit({ mount: { kind: "floor", height: editing.mount.height } })}
            />
            Floor
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="mount"
              checked={editing.mount.kind === "wall"}
              disabled={editing.surfaceId === null}
              onChange={() =>
                editing.surfaceId
                  ? commit({
                      mount: {
                        kind: "wall",
                        surfaceId: editing.surfaceId,
                        height: editing.mount.height,
                        offset: 0.02,
                      },
                    })
                  : undefined
              }
            />
            Wall
          </label>
        </div>
      </fieldset>

      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-ink-3">
          Height above {room ? `${room.name}'s floor` : "the floor"} (m)
          {room ? (
            <span className="ml-1 font-mono text-[10px] text-ink-3">
              floor at {room.floorElevation.toFixed(2)} m
            </span>
          ) : null}
        </span>
        <input
          type="number"
          step={0.05}
          value={editing.mount.height}
          onChange={(event) => {
            const height = Number(event.currentTarget.value);
            if (!Number.isFinite(height)) return;
            commit({ mount: { ...editing.mount, height } });
          }}
          className="min-h-9 rounded-md border border-line px-2 font-mono text-xs"
        />
      </label>

      {editing.mount.kind === "wall" ? (
        <label className="flex flex-col gap-0.5 text-xs">
          <span className="text-ink-3">Clearance from the wall face (m)</span>
          <input
            type="number"
            step={0.005}
            value={editing.mount.offset}
            onChange={(event) => {
              const offset = Number(event.currentTarget.value);
              if (!Number.isFinite(offset) || editing.mount.kind !== "wall") return;
              commit({ mount: { ...editing.mount, offset } });
            }}
            className="min-h-9 rounded-md border border-line px-2 font-mono text-xs"
          />
        </label>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-ink-3">Room (derived)</dt>
        <dd className="text-ink">{room?.name ?? "outside any room"}</dd>
        <dt className="text-ink-3">Floor</dt>
        <dd className="text-ink">{floor?.name ?? editing.floorId}</dd>
      </dl>

      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-ink-3">Where it is, in words</span>
        <textarea
          rows={3}
          value={editing.locationNote}
          onChange={(event) => updateDraft({ locationNote: event.currentTarget.value }, { coalesce: true })}
          placeholder="behind the utility-room door, top shelf"
          className="rounded-md border border-line px-2 py-1 text-xs"
        />
      </label>
    </div>
  );
}
