import type { PlacementLinkedEntity } from "./types";
import {
  classifyBattery,
  classifyState,
  type ConnectionState,
  type EntityState,
} from "../store/haStore";

export type EquipmentReadingIcon =
  | "temperature"
  | "humidity"
  | "illuminance"
  | "occupancy"
  | "contact"
  | "light"
  | "power"
  | "reading";

export interface EquipmentLabelDetail {
  label: string;
  value: string;
  icon: EquipmentReadingIcon;
  tone: "live" | "inactive" | "unknown" | "stale";
}

export interface EquipmentLabelReading {
  /** The compact chip's main value. This remains stable when details are expanded. */
  text: string;
  className: string;
  batteryPercent?: number;
  details: EquipmentLabelDetail[];
  expandable: boolean;
}

const USEFUL_ROLES = new Set<PlacementLinkedEntity["role"]>([
  "primary",
  "status",
  "power",
  "battery_level",
]);

/** Whole-device links can subscribe live fixtures, but never populate the expanded reading card. */
export function explicitUsefulLinks(
  links: readonly PlacementLinkedEntity[],
): PlacementLinkedEntity[] {
  return links.filter((link) => {
    const domain = link.entityId.split(".", 1)[0];
    return link.source !== "device" &&
      USEFUL_ROLES.has(link.role) &&
      !["update", "button", "select", "number"].includes(domain ?? "");
  });
}

function effectiveClass(link: PlacementLinkedEntity, entity?: EntityState): string | null {
  return entity?.deviceClass ?? link.deviceClass;
}

function humanState(state: string, deviceClass: string | null, entityId: string): string {
  if (state !== "on" && state !== "off") return state;
  const active = state === "on";
  switch (deviceClass) {
    case "occupancy":
    case "presence":
      return active ? "Occupied" : "Unoccupied";
    case "motion":
      return active ? "Motion detected" : "Clear";
    case "door":
    case "garage_door":
    case "window":
    case "opening":
      return active ? "Open" : "Closed";
    case "lock":
      return active ? "Unlocked" : "Locked";
    case "connectivity":
      return active ? "Connected" : "Disconnected";
    case "smoke":
    case "gas":
    case "moisture":
    case "problem":
    case "safety":
      return active ? "Detected" : "Clear";
    case "light":
      return active ? "On" : "Off";
    default:
      return entityId.startsWith("binary_sensor.")
        ? active ? "Detected" : "Clear"
        : active ? "On" : "Off";
  }
}

function valueOf(entity: EntityState | undefined, link?: PlacementLinkedEntity): string {
  if (!entity || entity.state === "unknown") return "—";
  if (entity.state === "unavailable") return "Unavailable";
  const state = humanState(
    entity.state,
    entity.deviceClass ?? link?.deviceClass ?? null,
    entity.entityId,
  );
  return `${state}${entity.unit ? ` ${entity.unit}` : ""}`;
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

function iconOf(link: PlacementLinkedEntity, entity?: EntityState): EquipmentReadingIcon {
  const cls = effectiveClass(link, entity);
  if (cls === "temperature") return "temperature";
  if (cls === "humidity" || cls === "moisture") return "humidity";
  if (cls === "illuminance") return "illuminance";
  if (cls === "occupancy" || cls === "presence" || cls === "motion") return "occupancy";
  if (["door", "garage_door", "window", "opening", "lock"].includes(cls ?? "")) return "contact";
  if (link.role === "power" || cls === "power" || cls === "energy") return "power";
  if (entity?.entityId.startsWith("light.")) return "light";
  return "reading";
}

function toneOf(
  entity: EntityState | undefined,
  connection: ConnectionState,
  now: number,
): EquipmentLabelDetail["tone"] {
  const cls = classifyState(entity, connection, now);
  if (cls === "stale") return "stale";
  if (cls !== "live") return "unknown";
  return entity?.state === "off" ? "inactive" : "live";
}

/** Compact main value plus structured, explicitly-linked readings for the expanded card. */
export function equipmentLabelReading(
  entityId: string | null | undefined,
  links: readonly PlacementLinkedEntity[],
  entities: Readonly<Record<string, EntityState>>,
  connection: ConnectionState,
  now: number,
  _expanded: boolean,
): EquipmentLabelReading | null {
  void _expanded;
  const mainId = entityId ?? links[0]?.entityId;
  if (!mainId) return null;
  const main = entities[mainId];
  const stateClass = classifyState(main, connection, now);
  if (stateClass === "unlinked") return null;

  const usefulLinks = explicitUsefulLinks(links);
  const battery = batteryPercent(usefulLinks, entities, main);
  const batteryClass = classifyBattery(battery);
  const batteryPercentValue = battery == null ? undefined : Math.min(100, Math.max(0, battery));
  const mainLink = links.find((link) => link.entityId === mainId);
  const text = stateClass === "disconnected"
    ? "HA offline"
    : mainLink?.role === "battery_level" && batteryPercentValue !== undefined
      ? ""
      : valueOf(main, mainLink);
  const details = usefulLinks
    .filter((link) => link.role !== "battery_level")
    .map((link) => {
      const entity = entities[link.entityId];
      return {
        label: link.name ?? link.entityId,
        value: connection === "open" ? valueOf(entity, link) : "—",
        icon: iconOf(link, entity),
        tone: toneOf(entity, connection, now),
      } satisfies EquipmentLabelDetail;
    });

  return {
    text,
    details,
    expandable: details.length > 1,
    ...(batteryPercentValue === undefined ? {} : { batteryPercent: batteryPercentValue }),
    className:
      stateClass === "stale"
        ? "vh-label-stale"
        : stateClass === "unavailable"
          ? "vh-label-unavailable"
          : stateClass === "unknown"
            ? "vh-label-unknown"
            : stateClass === "disconnected"
              ? "vh-label-disconnected"
              : `vh-label-${batteryClass}`,
  };
}
