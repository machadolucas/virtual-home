"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { DaylightHaEntity } from "@/house/model/daylight";
import { useHouseStore } from "@/house/hooks/useHouseStore";
import { haStore } from "@/house/store/haStore";

const DaylightHaContext = createContext<readonly DaylightHaEntity[]>([]);

export const LUX_STORAGE_KEY = "vh-daylight-lux-registry-id";
export const WEATHER_STORAGE_KEY = "vh-daylight-weather-registry-id";

export function readDaylightPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); }
  catch { return null; } // Storage may be blocked; calculated daylight still works.
}

export function saveDaylightPreference(key: string, registryId: string | null): void {
  try {
    if (registryId) window.localStorage.setItem(key, registryId);
    else window.localStorage.removeItem(key);
  } catch { /* Keep the selected source for this session when persistence is unavailable. */ }
}

/** Restore browser-local source identities as soon as the workspace mounts, even with controls shut. */
export function DaylightHaProvider({
  entities,
  children,
}: {
  entities: readonly DaylightHaEntity[];
  children: ReactNode;
}) {
  const set = useHouseStore((state) => state.setIllumination);
  useEffect(() => {
    const resolve = (key: string, kind: "illuminance" | "weather") => {
      const registryId = readDaylightPreference(key);
      return entities.find((entity) => entity.kind === kind && entity.registryId === registryId) ?? null;
    };
    const lux = resolve(LUX_STORAGE_KEY, "illuminance");
    const weather = resolve(WEATHER_STORAGE_KEY, "weather");
    for (const entity of [lux, weather]) seedDaylightEntity(entity);
    set({
      outdoorLuxRegistryId: lux?.registryId ?? null,
      outdoorLuxEntityId: lux?.entityId ?? null,
      weatherRegistryId: weather?.registryId ?? null,
      weatherEntityId: weather?.entityId ?? null,
    });
  }, [entities, set]);

  return <DaylightHaContext.Provider value={entities}>{children}</DaylightHaContext.Provider>;
}

/** Never let a server-rendered snapshot replace a newer state already received over SSE. */
export function seedDaylightEntity(entity: DaylightHaEntity | null): void {
  if (!entity || entity.state === null || entity.lastUpdatedMs === null) return;
  const current = haStore.getState().entities[entity.entityId];
  if (current && current.lastUpdated >= entity.lastUpdatedMs) return;
  haStore.getState().applyBatch([{
    entityId: entity.entityId,
    state: entity.state,
    lastUpdated: entity.lastUpdatedMs,
    deviceClass: entity.deviceClass,
    unit: entity.unit,
  }]);
}

export const useDaylightHaEntities = (): readonly DaylightHaEntity[] => useContext(DaylightHaContext);
