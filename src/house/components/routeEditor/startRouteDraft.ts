"use client";
/**
 * Starting a route that does not exist yet.
 *
 * The missing half of the route editor. `beginRouteDraft` was only ever reached from
 * `RouteInspector`, i.e. for a run already in the database, so there was no way to record a new
 * pipe, duct or cable at all. This builds the first draft and hands it to the same editors.
 *
 * Two decisions worth stating:
 *
 *  - **A seeded polyline, not an empty one.** `infra_route` needs at least two points, and an
 *    editor with nothing in it has nothing to drag. The two points span the selected room (or the
 *    active floor) and are explicitly a *starting point*, not a claim: the certainty the caller
 *    picks — `inferred` by default — is what says how much the line can be trusted, and the editor
 *    says so in words.
 *  - **The draft is put into `routes` as well.** The 3D line geometry is built from the route list,
 *    so a draft that lives only in `routeDraft` shows handles and no line. The store mirrors
 *    subsequent draft edits into the list (`slices/route.ts`), which is what makes dragging a
 *    point move the line in 3D.
 */
import type { InfraCertainty, InfraLifecycle, InfraMedium } from "@/db/schema/infrastructure";
import { kindOfMedium, systemOfMedium } from "@/features/projects/infraMedium";
import type { RouteDto } from "@/features/projects/wire";
import { roomAt } from "@/house/model/manifestIndex";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { FloorId, Route, RoomId, Vec3 } from "@/house/model/types";
import type { HouseRuntime } from "@/house/runtime";

/** What the create form asks for. Everything else about a run is edited afterwards. */
export interface NewRouteSpec {
  name: string;
  medium: InfraMedium;
  certainty: InfraCertainty;
  lifecycle: InfraLifecycle;
  /** Free text as written on the part: "DN20", "Cat6a", "125/80". */
  nominalSize: string | null;
}

/** Height above the floor datum a freshly seeded run sits at, in metres. */
const SEED_HEIGHT_M = 0.4;
/** Half the length of the seeded run, in metres, when the room gives us nothing better. */
const SEED_HALF_SPAN_M = 0.75;

/**
 * Two points to start from: across the middle of the selected room where there is one, otherwise
 * across the middle of the active floor. Never through the origin, which on this coordinate system
 * is a corner of the site and reads as a bug rather than as a starting point.
 */
export function seedPoints(
  index: ManifestIndex,
  floorId: FloorId,
  selectedRoomId: RoomId | null,
): { points: [Vec3, Vec3]; roomIds: [RoomId | null, RoomId | null] } {
  const floorElevation = index.floors.get(floorId)?.elevation ?? 0;
  const room = selectedRoomId ? index.rooms.get(selectedRoomId) : undefined;

  if (room && room.floorId === floorId) {
    const anchor = index.roomAnchors.get(room.id);
    const [cx, cz] = anchor
      ? [anchor.point[0], anchor.point[2]]
      : ringCentre(room.footprint.outer as ReadonlyArray<[number, number]>);
    // Kept inside the room: the anchor's clearance is the largest half-span that cannot leave it.
    const half = Math.min(SEED_HALF_SPAN_M, Math.max(0.1, (anchor?.clearance ?? 0.2) * 0.8));
    const y = room.floorElevation + SEED_HEIGHT_M;
    return {
      points: [
        [cx - half, y, cz],
        [cx + half, y, cz],
      ],
      roomIds: [room.id, room.id],
    };
  }

  const rooms = index.roomsByFloor.get(floorId) ?? [];
  let cx: number;
  let cz: number;
  if (rooms.length > 0) {
    let x = 0;
    let z = 0;
    for (const r of rooms) {
      const [rx, rz] = ringCentre(r.footprint.outer as ReadonlyArray<[number, number]>);
      x += rx;
      z += rz;
    }
    cx = x / rooms.length;
    cz = z / rooms.length;
  } else {
    const { min, max } = index.manifest.bounds;
    cx = ((min?.[0] ?? 0) + (max?.[0] ?? 0)) / 2;
    cz = ((min?.[2] ?? 0) + (max?.[2] ?? 0)) / 2;
  }
  const y = floorElevation + SEED_HEIGHT_M;
  const a: Vec3 = [cx - SEED_HALF_SPAN_M, y, cz];
  const b: Vec3 = [cx + SEED_HALF_SPAN_M, y, cz];
  return {
    points: [a, b],
    roomIds: [roomAt(index, floorId, a[0], a[2]), roomAt(index, floorId, b[0], b[2])],
  };
}

/**
 * A single physical point to start an endpoint from — the middle of the room, at working height.
 * The same "somewhere sensible, now move me" contract as `seedPoints`, and the same reason: a
 * vent recorded at the site origin is worse than one the user has to nudge.
 */
export function defaultPositionIn(
  index: ManifestIndex,
  floorId: FloorId,
  roomId: RoomId | null,
): Vec3 {
  const { points } = seedPoints(index, floorId, roomId);
  const [a, b] = points;
  return [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
}

/**
 * Open the editors on a brand-new run. Returns `null` when there is no model to draw into, so the
 * caller can say so instead of appearing to do nothing.
 */
export function startRouteDraft(
  runtime: HouseRuntime,
  spec: NewRouteSpec,
): (Route & Partial<RouteDto>) | null {
  const s = runtime.store.getState();
  const index = s.index;
  if (!index || !s.modelId) return null;

  const floorId = s.activeFloorId ?? index.floorOrder[0] ?? null;
  if (!floorId) return null;

  const selectedRoomId = s.selection?.kind === "room" ? s.selection.id : null;
  const { points, roomIds } = seedPoints(index, floorId, selectedRoomId);

  /**
   * Wider than `Route` on purpose. The workspace's own type has no `medium` — it carries the
   * presentation `system`/`kind` instead — but the medium is the *stored* fact, and a draft that
   * dropped it would be saved back as its system's default: a supply-air duct silently becoming
   * cold water. The save path reads these through `RouteSave`.
   */
  const draft: Route & Partial<RouteDto> = {
    // A client-chosen id, which the API accepts: it keeps the store row, the 3D line and the
    // eventual database row the same thing, so a retried save updates rather than duplicates.
    id: crypto.randomUUID(),
    modelId: s.modelId,
    name: spec.name,
    system: systemOfMedium(spec.medium),
    kind: kindOfMedium(spec.medium),
    points: [...points],
    // One entry per span. A two-point run has exactly one.
    segments: [{ floorId, roomId: roomIds[0] }],
    certainty: spec.certainty,
    lifecycle: spec.lifecycle,
    endpoints: [],
    photoIds: [],
    medium: spec.medium,
    nominalSize: spec.nominalSize,
    isEstimated: spec.certainty !== "measured",
    fromEndpointId: null,
    toEndpointId: null,
  };

  s.upsertRoute(draft);
  s.beginRouteDraft(draft, { isNew: true });
  s.selectPoint(0);
  s.announce(
    `Drawing ${spec.name}. Drag the points on the plan, or type the coordinates, then save the path.`,
  );
  return draft;
}

function ringCentre(ring: ReadonlyArray<[number, number]>): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of ring) {
    x += px;
    z += pz;
  }
  return ring.length === 0 ? [0, 0] : [x / ring.length, z / ring.length];
}
