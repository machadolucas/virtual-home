"use client";
/**
 * The numeric fields **are** the authority: the drag path writes the same draft these fields edit,
 * and both go through `resolveSnap`/`resolveNumeric`, so typing and dragging cannot diverge.
 *
 * On a phone this is the whole editor (§7.3): drag placement is not offered there.
 */
import { resolveNumeric } from "@/house/scene/snap";
import {
  defaultSymbol,
  PLACEMENT_SYMBOLS,
  SYMBOL_LABEL,
  type PlacementSymbol,
} from "@/house/scene/symbols";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";

/** Sentinel for "let the view infer it", which is `null` in the draft and in the database. */
import { canMountSurface } from "@/house/model/mountSurface";
import { Select } from "@/ui/Select";

const INFERRED = "__inferred";

export function NumericPlacementFields() {
  const { editing, snap, index } = useHouseStore(
    useShallow((s) => ({ editing: s.editing, snap: s.snap, index: s.index })),
  );
  const updateDraft = useHouseStore((s) => s.updateDraft);
  const runtime = useHouseRuntime();
  if (!editing || !index) return null;

  const room = editing.roomId ? index.rooms.get(editing.roomId) : undefined;
  const floor = index.floors.get(editing.floorId);
  // What the view would draw with no explicit choice, so the "Automatic" option can name it
  // instead of leaving the user to guess. The draft has no category, so this is the mount-only
  // inference — good enough to label the option honestly.
  // A mount kind the surface cannot take is refused by the endpoint, so offering it only produces
  // a failed save at the end of the work. The remembered surface decides what is on offer.
  const canWall = canMountSurface(index, editing.surfaceId ?? "", "wall");
  const canCeiling = canMountSurface(index, editing.surfaceId ?? "", "ceiling");

  const inferredSymbol: PlacementSymbol = defaultSymbol({
    mountKind: editing.mount.kind,
    isOutdoor: editing.roomId === null,
  });

  const commit = (patch: Partial<typeof editing>) => {
    const next = { ...editing, ...patch };
    const solution = resolveNumeric(index, next, snap, {
      previousMount: editing.mount,
      meshOf: (id) => runtime.index?.surfaceMesh.get(id),
      anchorOf: (id) => index.roomAnchors.get(id)?.point,
    });
    updateDraft(
      {
        ...patch,
        physical: solution.physical,
        rotationYDeg: solution.rotationYDeg,
        roomId: solution.roomId,
        floorId: solution.floorId,
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
        <div className="flex flex-wrap gap-2">
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
              disabled={!canWall}
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
          <label className="flex items-center gap-1" title="A ceiling, or the underside of an eave">
            <input
              type="radio"
              name="mount"
              checked={editing.mount.kind === "ceiling"}
              disabled={!canCeiling}
              onChange={() =>
                editing.surfaceId
                  ? commit({
                      mount: {
                        kind: "ceiling",
                        surfaceId: editing.surfaceId,
                        height: editing.mount.height,
                        offset: 0,
                      },
                    })
                  : undefined
              }
            />
            Ceiling / eave
          </label>
          <label
            className="flex items-center gap-1"
            title="Suspended, buried, or on a post — attached to nothing the model knows about"
          >
            <input
              type="radio"
              name="mount"
              checked={editing.mount.kind === "free"}
              onChange={() => commit({ mount: { kind: "free", height: editing.mount.height } })}
            />
            Free
          </label>
        </div>
        {editing.surfaceId === null ? (
          <p className="text-[10px] leading-3 text-ink-3">
            Click a wall, a ceiling or an eave in the 3D view to mount it there.
          </p>
        ) : (
          <p className="font-mono text-[10px] leading-3 text-ink-3">
            {editing.surfaceId}
            {!canWall && !canCeiling ? (
              <span className="ml-1 font-sans text-ink-3">
                — this surface takes a floor or free mount
              </span>
            ) : null}
          </p>
        )}
      </fieldset>

      {/* Appearance, not geometry: which silhouette the 3D view draws for this thing. */}
      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-ink-3">Shown as</span>
        <Select
          selectSize="sm"
          value={editing.symbol ?? INFERRED}
          onValueChange={(value) => {
            updateDraft({ symbol: value === INFERRED ? null : value });
          }}
          options={[
            {
              value: INFERRED,
              label: `Automatic (${SYMBOL_LABEL[inferredSymbol].toLowerCase()})`,
            },
            ...PLACEMENT_SYMBOLS.map((symbol) => ({
              value: symbol,
              label: SYMBOL_LABEL[symbol],
            })),
          ]}
        />
      </label>

      <label className="flex flex-col gap-0.5 text-xs">
        <span className="text-ink-3">
          {editing.mount.kind === "ceiling"
            ? "Drop below the surface (m)"
            : `Height above ${room ? `${room.name}'s floor` : "the floor"} (m)`}
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

      {editing.mount.kind === "wall" || editing.mount.kind === "ceiling" ? (
        <label className="flex flex-col gap-0.5 text-xs">
          <span className="text-ink-3">
            {editing.mount.kind === "ceiling"
              ? "Clearance from the surface (m)"
              : "Clearance from the wall face (m)"}
          </span>
          <input
            type="number"
            step={0.005}
            value={editing.mount.offset}
            onChange={(event) => {
              const offset = Number(event.currentTarget.value);
              if (!Number.isFinite(offset)) return;
              if (editing.mount.kind !== "wall" && editing.mount.kind !== "ceiling") return;
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
