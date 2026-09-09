import type { PlacementLinkedEntity } from "./types";
import {
  classifyBattery,
  classifyState,
  type ConnectionState,
  type EntityState,
} from "../store/haStore";

export interface EquipmentLabelReading {
  text: string;
  className: string;
  batteryPercent?: number;
}

function valueOf(entity: EntityState | undefined): string {
  if (!entity || entity.state === "unknown") return "—";
  if (entity.state === "unavailable") return "unavailable";
  return `${entity.state}${entity.unit ? ` ${entity.unit}` : ""}`;
}

function batteryPercent(
  links: readonly PlacementLinkedEntity[],
  entities: Readonly<Record<string, EntityState>>,
  main: EntityState | undefined,
): number | null {
  const batteryLink = links.find(
    (link) => link.role === "battery_level" || link.deviceClass === "battery",
  );
  if (batteryLink) {
    const raw = entities[batteryLink.entityId]?.state;
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (Number.isFinite(value)) return value;
    return null;
  }
  return main?.battery ?? null;
}

/** Text for an equipment chip. Expanded chips enumerate every linked HA reading. */
export function equipmentLabelReading(
  entityId: string | null | undefined,
  links: readonly PlacementLinkedEntity[],
  entities: Readonly<Record<string, EntityState>>,
  connection: ConnectionState,
  now: number,
  expanded: boolean,
): EquipmentLabelReading | null {
  const mainId = entityId ?? links[0]?.entityId;
  if (!mainId) return null;
  const main = entities[mainId];
  const stateClass = classifyState(main, connection, now);
  if (stateClass === "unlinked") return null;
  if (stateClass === "disconnected") return { text: "—", className: "vh-label-disconnected" };

  const battery = batteryPercent(links, entities, main);
  const batteryClass = classifyBattery(battery);
  const batteryPercentValue = battery == null ? undefined : Math.min(100, Math.max(0, battery));

  let text = valueOf(main);
  if (expanded && links.length > 1) {
    text = links
      .filter((link) => link.role !== "battery_level")
      .map((link) => {
        const entity = entities[link.entityId];
        const label = link.name ?? link.entityId;
        return `${label}: ${valueOf(entity)}`;
      })
      .join(" · ");
  } else if (batteryPercentValue !== undefined && links.find((link) => link.entityId === mainId)?.role === "battery_level") {
    text = "";
  }

  return {
    text,
    ...(batteryPercentValue === undefined ? {} : { batteryPercent: batteryPercentValue }),
    className:
      stateClass === "stale"
        ? "vh-label-stale"
        : stateClass === "unavailable"
          ? "vh-label-unavailable"
          : stateClass === "unknown"
            ? "vh-label-unknown"
            : `vh-label-${batteryClass}`,
  };
}
