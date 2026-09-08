"use client";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import type { SurfaceId } from "@/house/model/types";
import { IssueList } from "./IssueList";
import { Row } from "./RoomInspector";

/** One surface: its identity, its owner, its colour. Colouring touches this material only. */
export function SurfaceInspector({ surfaceId }: { surfaceId: SurfaceId }) {
  const runtime = useHouseRuntime();
  const { index, overrides } = useHouseStore(
    useShallow((s) => ({ index: s.index, overrides: s.overrides })),
  );
  const setOverride = useHouseStore((s) => s.setOverride);
  const clearOverride = useHouseStore((s) => s.clearOverride);

  const surface = index?.surfaces.get(surfaceId);
  if (!index || !surface) return null;
  const room = surface.roomId ? index.rooms.get(surface.roomId) : undefined;
  const element = surface.elementId ? index.elements.get(surface.elementId) : undefined;
  const hex = overrides[surfaceId] ?? surface.defaultColor.toLowerCase();
  const hasMesh = runtime.index?.surfaceMesh.has(surfaceId) ?? true;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-ink">
          {surface.kind}
          {surface.role ? ` · ${surface.role}` : ""}
        </h2>
        <p className="font-mono text-[11px] text-ink-3">{surface.id}</p>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Room" value={room?.name ?? "—"} />
        <Row label="Element" value={element ? `${element.kind} · ${element.id}` : "—"} />
        <Row label="Default colour" value={surface.defaultColor.toLowerCase()} />
        <Row label="Nodes" value={surface.nodeRefs.map((n) => n.assetId).join(", ")} />
      </dl>

      {!hasMesh ? (
        <p className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2">
          This surface exists in the manifest but its node carries no geometry (a degenerate band).
          It cannot be coloured or highlighted; that is the package&rsquo;s intent, not a fault.
        </p>
      ) : (
        <section className="flex items-center gap-2">
          <input
            type="color"
            value={hex}
            onChange={(event) => setOverride(surfaceId, event.currentTarget.value)}
            aria-label={`Colour for ${surfaceId}`}
            className="h-8 w-10 rounded border border-line"
          />
          <button
            type="button"
            onClick={() => clearOverride(surfaceId)}
            className="min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3"
          >
            Reset to default
          </button>
        </section>
      )}

      {room ? (
        <button
          type="button"
          onClick={() => runtime.select({ kind: "room", id: room.id }, { frame: true })}
          className="self-start text-xs text-accent-text hover:underline"
        >
          Show the whole room
        </button>
      ) : null}

      <IssueList issues={index.issuesByAffected.get(surfaceId) ?? []} />
    </div>
  );
}
