"use client";
/**
 * Equipment inspector.
 *
 * A placeholder for the asset/maintenance data that another part of the app owns; what it does own
 * is the placement's authoritative numbers, its HA state and its location note. Two rules from
 * CLAUDE.md show up here directly: an unknown battery is "unknown", never 0 %, and telemetry
 * recovering after a battery change is not evidence of maintenance.
 */
import { useStore } from "zustand";
import type { PlacementId } from "@/house/model/types";
import {
  classifyBattery,
  classifyState,
  haStore,
  type EntityState,
} from "@/house/store/haStore";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { useNow } from "../../hooks/useReducedMotion";
import { IssueList } from "./IssueList";
import { Row } from "./RoomInspector";

export function EquipmentInspector({ placementId }: { placementId: PlacementId }) {
  const runtime = useHouseRuntime();
  const { index, placements } = useHouseStore(
    useShallow((s) => ({ index: s.index, placements: s.placements })),
  );
  const beginEdit = useHouseStore((s) => s.beginEdit);
  const placement = placements.find((p) => p.id === placementId);

  // One selector per entity, so a temperature change re-renders only this card.
  const entity = useStore(haStore, (s) =>
    placement?.entityId ? s.entities[placement.entityId] : undefined,
  );
  const connection = useStore(haStore, (s) => s.connection);

  if (!index || !placement) return null;
  const room = placement.roomId ? index.rooms.get(placement.roomId) : undefined;
  const buildingIssues = room?.buildingId ? index.issuesByAffected.get(room.buildingId) ?? [] : [];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-ink">{placement.name}</h2>
        <p className="text-xs text-ink-3">
          {[room?.name, index.floors.get(placement.floorId)?.name].filter(Boolean).join(" · ")}
        </p>
      </header>

      <HaState entity={entity} connection={connection} />

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="X" value={`${placement.position[0].toFixed(3)} m`} />
        <Row label="Y" value={`${placement.position[1].toFixed(3)} m`} />
        <Row label="Z" value={`${placement.position[2].toFixed(3)} m`} />
        <Row label="Rotation" value={`${placement.rotationYDeg}°`} />
        <Row label="Mount" value={mountLabel(placement.mount)} />
        <Row
          label="Height above floor"
          value={`${placement.mount.height.toFixed(3)} m`}
        />
      </dl>

      {placement.locationNote ? (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
            Where it is
          </h3>
          <p className="mt-1 text-sm text-ink">{placement.locationNote}</p>
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runtime.camera?.frameEquipment(placement.id)}
          className="min-h-9 rounded-md border border-line bg-surface px-3 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Show me
        </button>
        <button
          type="button"
          onClick={() =>
            beginEdit({
              placementId: placement.id,
              equipmentId: placement.equipmentId,
              modelId: placement.modelId,
              name: placement.name,
              physical: [...placement.position],
              rotationYDeg: placement.rotationYDeg,
              mount: placement.mount,
              floorId: placement.floorId,
              roomId: placement.roomId,
              surfaceId: placement.surfaceId,
              locationNote: placement.locationNote,
              photoId: placement.photoId,
              symbol: placement.symbol,
              dirty: false,
            })
          }
          className="min-h-9 rounded-md border border-line bg-surface px-3 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Adjust placement (E)
        </button>
      </div>

      <section className="rounded-md border border-dashed border-line p-3 text-xs text-ink-3">
        Camera streams are not part of this view. An &ldquo;Open stream&rdquo; action would mount
        nothing until tapped.
      </section>

      <IssueList issues={buildingIssues} />
    </div>
  );
}

function HaState({
  entity,
  connection,
}: {
  entity: EntityState | undefined;
  connection: ReturnType<typeof haStore.getState>["connection"];
}) {
  // Staleness is time-based, so this card re-evaluates on a slow shared tick rather than on
  // every event — and `now` comes from a store, because reading the clock in render is impure.
  const now = useNow();
  const cls = classifyState(entity, connection, now);
  const battery = classifyBattery(entity?.battery);

  if (cls === "unlinked")
    return (
      <p className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2">
        Not linked to a Home Assistant entity.
      </p>
    );

  return (
    <section className="rounded-md border border-line bg-surface-2 p-3">
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row
          label="State"
          value={
            cls === "disconnected"
              ? "Home Assistant disconnected"
              : cls === "unavailable"
                ? "unavailable"
                : cls === "unknown"
                  ? "—"
                  : `${entity?.state ?? "—"}${entity?.unit ? ` ${entity.unit}` : ""}`
          }
        />
        <Row
          label="Battery"
          value={
            battery === "unknown"
              ? "unknown"
              : `${entity?.battery}%${entity?.batteryType ? ` (${entity.batteryType})` : ""}`
          }
        />
        <Row
          label="Last update"
          value={entity ? new Date(entity.lastUpdated).toLocaleString() : "—"}
        />
        <Row label="Freshness" value={cls} />
      </dl>
      {battery === "low" || battery === "critical" ? (
        <p className="mt-2 text-xs text-due">
          Battery {battery}. Replacing it is a recorded completion — telemetry coming back is not
          proof on its own.
        </p>
      ) : null}
    </section>
  );
}

function mountLabel(mount: { kind: string; surfaceId?: string }): string {
  switch (mount.kind) {
    case "wall":
      return `wall · ${mount.surfaceId}`;
    case "ceiling":
      return `ceiling or eave · ${mount.surfaceId}`;
    case "free":
      return "free-standing";
    default:
      return "floor";
  }
}
