/**
 * Model correction / package swap reconciliation.
 *
 * Nothing is auto-migrated. Given the ids that persisted data references, this reports what the
 * new package no longer knows about, and the UI opens an explicit reconciliation screen.
 */
import type { ManifestIndex } from "./manifestIndex";
import type { Box, ElementId, FloorId, RoomId, SurfaceId } from "./types";

export interface PersistedRefs {
  surfaceIds?: readonly SurfaceId[];
  roomIds?: readonly RoomId[];
  elementIds?: readonly ElementId[];
  floorIds?: readonly FloorId[];
  /** Physical positions of placements/route points, to detect a frame change. */
  positions?: ReadonlyArray<readonly [number, number, number]>;
}

export interface ReconcileReport {
  modelIdChanged: boolean;
  fingerprintChanged: boolean;
  coordinateSystemChanged: boolean;
  unknownSurfaceIds: SurfaceId[];
  unknownRoomIds: RoomId[];
  unknownElementIds: ElementId[];
  unknownFloorIds: FloorId[];
  /** Positions that fall outside the new package's bounds. */
  outOfBoundsPositions: number;
  clean: boolean;
}

export interface PersistedModelStamp {
  modelId: string;
  fingerprint: string;
  /** Snapshot of the coordinate system fields that would invalidate stored metre coordinates. */
  coordinate?: {
    units?: string;
    upAxis?: string;
    handedness?: string;
    originDescription?: string;
    siteElevationOffset?: number;
  };
}

export function reconcile(
  index: ManifestIndex,
  stamp: PersistedModelStamp,
  current: { modelId: string; fingerprint: string },
  refs: PersistedRefs,
): ReconcileReport {
  const cs = index.manifest.coordinateSystem;
  const prev = stamp.coordinate;
  const coordinateSystemChanged = prev
    ? prev.units !== cs.units ||
      prev.upAxis !== cs.upAxis ||
      prev.handedness !== cs.handedness ||
      prev.originDescription !== cs.originDescription ||
      (prev.siteElevationOffset ?? null) !== (cs.siteElevationOffset ?? null)
    : false;

  const unknownSurfaceIds = missing(refs.surfaceIds, (id) => index.surfaces.has(id));
  const unknownRoomIds = missing(refs.roomIds, (id) => index.rooms.has(id));
  const unknownElementIds = missing(refs.elementIds, (id) => index.elements.has(id));
  const unknownFloorIds = missing(refs.floorIds, (id) => index.floors.has(id));

  const bounds: Box = { min: [...index.manifest.bounds.min], max: [...index.manifest.bounds.max] };
  let outOfBoundsPositions = 0;
  for (const p of refs.positions ?? []) {
    for (let i = 0; i < 3; i++) {
      if ((p[i] as number) < (bounds.min[i] as number) || (p[i] as number) > (bounds.max[i] as number)) {
        outOfBoundsPositions++;
        break;
      }
    }
  }

  const report: ReconcileReport = {
    modelIdChanged: stamp.modelId !== current.modelId,
    fingerprintChanged: stamp.fingerprint !== current.fingerprint,
    coordinateSystemChanged,
    unknownSurfaceIds,
    unknownRoomIds,
    unknownElementIds,
    unknownFloorIds,
    outOfBoundsPositions,
    clean: false,
  };
  report.clean =
    !report.modelIdChanged &&
    !report.coordinateSystemChanged &&
    unknownSurfaceIds.length === 0 &&
    unknownRoomIds.length === 0 &&
    unknownElementIds.length === 0 &&
    unknownFloorIds.length === 0 &&
    outOfBoundsPositions === 0;
  return report;
}

function missing(ids: readonly string[] | undefined, known: (id: string) => boolean): string[] {
  if (!ids) return [];
  const out = new Set<string>();
  for (const id of ids) if (!known(id)) out.add(id);
  return [...out];
}

/** Coordinate stamp to persist alongside overrides/placements so a swap is detectable. */
export function coordinateStamp(index: ManifestIndex): PersistedModelStamp["coordinate"] {
  const cs = index.manifest.coordinateSystem;
  return {
    units: cs.units,
    upAxis: cs.upAxis,
    handedness: cs.handedness,
    originDescription: cs.originDescription,
    siteElevationOffset: cs.siteElevationOffset,
  };
}
