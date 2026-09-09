import "server-only";

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  assetHaLink,
  haControlCommand,
  haDevice,
  haEntity,
  haEntityState,
  integrationStatus,
} from "@/db/schema";
import {
  capabilitiesForEntity,
  type EquipmentHaControlsResponse,
  type HaControlEntity,
  type HaRgbColor,
} from "@/domain/haControl";

const LIVE_LINK_STATES = ["active", "renamed"] as const;

function parseAttributes(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function integerAttribute(attributes: Record<string, unknown>, key: string): number | null {
  const value = attributes[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function rgbAttribute(attributes: Record<string, unknown>): HaRgbColor | null {
  const value = attributes.rgb_color;
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  )
    return null;
  return value as HaRgbColor;
}

const WORKER_HEARTBEAT_STALE_MS = 45_000;

export function isHaConnected(tx: Db, atMs = Date.now()): boolean {
  const status = tx
      .select({ state: integrationStatus.state })
      .from(integrationStatus)
      .where(eq(integrationStatus.id, "ha"))
      .get();
  const heartbeat = tx
    .select({ atMs: integrationStatus.heartbeatAtMs })
    .from(integrationStatus)
    .where(eq(integrationStatus.id, "ha"))
    .get()?.atMs;
  return status?.state === "subscribed" && heartbeat !== undefined && atMs - heartbeat < WORKER_HEARTBEAT_STALE_MS;
}

/** Controllable HA entities that are currently and explicitly in this equipment's link scope. */
export function readEquipmentHaControls(tx: Db, assetId: string): EquipmentHaControlsResponse | null {
  if (!tx.select({ id: asset.id }).from(asset).where(eq(asset.id, assetId)).get()) return null;

  const rows = tx
    .selectDistinct({
      registryId: haEntity.registryId,
      entityId: haEntity.entityId,
      domain: haEntity.domain,
      name: haEntity.name,
      originalName: haEntity.originalName,
      disabledBy: haEntity.disabledBy,
      hiddenBy: haEntity.hiddenBy,
      deviceDisabledBy: haDevice.disabledBy,
      linkKind: assetHaLink.linkKind,
      state: haEntityState.state,
      attributesJson: haEntityState.attributesJson,
    })
    .from(assetHaLink)
    .innerJoin(
      haEntity,
      or(
        eq(haEntity.registryId, assetHaLink.haEntityRegistryId),
        eq(haEntity.deviceId, assetHaLink.haDeviceId),
      ),
    )
    .leftJoin(haDevice, eq(haDevice.deviceId, haEntity.deviceId))
    .leftJoin(haEntityState, eq(haEntityState.registryId, haEntity.registryId))
    .where(
      and(
        eq(assetHaLink.assetId, assetId),
        inArray(assetHaLink.linkState, [...LIVE_LINK_STATES]),
        inArray(haEntity.domain, ["light", "switch"]),
        isNull(haEntity.removedAtMs),
        or(eq(assetHaLink.linkKind, "entity"), isNull(haEntity.disabledBy)),
        or(eq(assetHaLink.linkKind, "entity"), isNull(haEntity.hiddenBy)),
        or(eq(assetHaLink.linkKind, "entity"), isNull(haDevice.disabledBy)),
      ),
    )
    .orderBy(asc(haEntity.entityId))
    .all();

  const byRegistryId = new Map<string, HaControlEntity>();
  for (const row of rows.sort((a, b) => Number(a.linkKind === "device") - Number(b.linkKind === "device"))) {
    if (byRegistryId.has(row.registryId)) continue;
    const attributes = parseAttributes(row.attributesJson);
    const rawName = attributes.friendly_name;
    byRegistryId.set(row.registryId, {
      registryId: row.registryId,
      entityId: row.entityId,
      name:
        (typeof rawName === "string" && rawName.trim()) ||
        row.name ||
        row.originalName ||
        row.entityId,
      state: row.state ?? "unavailable",
      available:
        row.disabledBy === null &&
        row.hiddenBy === null &&
        row.deviceDisabledBy === null &&
        row.state !== null &&
        row.state !== "unknown" &&
        row.state !== "unavailable",
      capabilities: capabilitiesForEntity(row.domain, attributes),
      brightness: integerAttribute(attributes, "brightness"),
      colorTempKelvin: integerAttribute(attributes, "color_temp_kelvin"),
      rgbColor: rgbAttribute(attributes),
    });
  }

  return { connected: isHaConnected(tx), entities: [...byRegistryId.values()] };
}

export function readHaControlStatus(tx: Db, assetId: string, commandId: string) {
  return tx
    .select({
      id: haControlCommand.id,
      status: haControlCommand.state,
      error: haControlCommand.lastError,
    })
    .from(haControlCommand)
    .where(and(eq(haControlCommand.id, commandId), eq(haControlCommand.assetId, assetId)))
    .get();
}
