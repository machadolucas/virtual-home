import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  asset,
  location,
  system,
  systemAsset,
  systemLocation,
  type SystemKind,
  type SystemStatus,
} from "@/db/schema";

export interface SystemMember {
  assetId: string;
  assetName: string;
  locationName: string | null;
  role: string | null;
}

export interface SystemRow {
  id: string;
  name: string;
  kind: SystemKind;
  status: SystemStatus;
  description: string | null;
  members: SystemMember[];
  /** Locations the system declares it spans, plus the locations its members sit in. */
  declaredLocations: { id: string; name: string }[];
  memberLocationNames: string[];
}

/**
 * Every system with its members, in two set-based queries.
 *
 * `system_location` is the declared span and `member locations` is the observed one; the page shows
 * both because they disagreeing is information (a ventilation system whose members are all upstairs
 * but which declares the whole house is either mis-declared or missing equipment).
 */
export function listSystems(tx: Db): SystemRow[] {
  const systems = tx.select().from(system).orderBy(asc(system.name)).all();
  if (systems.length === 0) return [];

  const ids = systems.map((row) => row.id);

  const membersBySystem = new Map<string, SystemMember[]>();
  for (const row of tx
    .select({
      systemId: systemAsset.systemId,
      assetId: asset.id,
      assetName: asset.name,
      locationName: location.name,
      role: systemAsset.role,
    })
    .from(systemAsset)
    .innerJoin(asset, eq(asset.id, systemAsset.assetId))
    .leftJoin(location, eq(location.id, asset.locationId))
    .where(inArray(systemAsset.systemId, ids))
    .orderBy(asc(asset.name))
    .all()) {
    membersBySystem.set(row.systemId, [
      ...(membersBySystem.get(row.systemId) ?? []),
      {
        assetId: row.assetId,
        assetName: row.assetName,
        locationName: row.locationName,
        role: row.role,
      },
    ]);
  }

  const locationsBySystem = new Map<string, { id: string; name: string }[]>();
  for (const row of tx
    .select({
      systemId: systemLocation.systemId,
      id: location.id,
      name: location.name,
    })
    .from(systemLocation)
    .innerJoin(location, eq(location.id, systemLocation.locationId))
    .where(inArray(systemLocation.systemId, ids))
    .orderBy(asc(location.name))
    .all()) {
    locationsBySystem.set(row.systemId, [
      ...(locationsBySystem.get(row.systemId) ?? []),
      { id: row.id, name: row.name },
    ]);
  }

  return systems.map((row) => {
    const members = membersBySystem.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      description: row.description,
      members,
      declaredLocations: locationsBySystem.get(row.id) ?? [],
      memberLocationNames: [
        ...new Set(
          members
            .map((member) => member.locationName)
            .filter((value): value is string => value !== null),
        ),
      ].sort(),
    };
  });
}

export function readSystem(tx: Db, systemId: string): SystemRow | null {
  return listSystems(tx).find((row) => row.id === systemId) ?? null;
}
