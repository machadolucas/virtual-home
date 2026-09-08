/**
 * Placement snapping.
 *
 * The drag path and the typing path converge on this one function, so a numeric edit and a mouse
 * drag can never produce different results. `TransformControls` is deliberately not used: its
 * gizmo translates along world axes with `translationSnap` only — no surface snapping, no
 * wall-normal alignment, no mounting-height semantics — it re-parents the controlled object (which
 * is dangerous when the object lives under a group whose offset is presentation), and its handles
 * are ~10 px targets, unusable on touch.
 *
 * **Mounting height is measured from the room's own floor** (`room.floorElevation`), not from the
 * floor datum. A room whose floor sits below its datum makes this a real, testable distinction.
 */
import * as THREE from "three";
import { snapValue } from "@/house/model/geometry2d";
import { roomAt, type ManifestIndex } from "@/house/model/manifestIndex";
import type { FloorId, PlacementMount, RoomId, SurfaceId, Vec3 } from "@/house/model/types";
import type { PickResult } from "./picker";
import { wallFrame, type WallFrame } from "./wallFrame";

/** Clearance from a wall face so the marker is not co-planar with the surface. */
export const WALL_STANDOFF = 0.02;

export interface SnapConfig {
  grid: number;
  rotationStep: number;
  enabled: boolean;
  wallSnap: boolean;
}

export interface SnapIndicatorState {
  kind: "wall" | "floor" | "free";
  /** Snapped point in physical coordinates. */
  point: Vec3;
  /** Wall snapping only: the frame and the local coordinates within it. */
  frame?: WallFrame;
  u?: number;
  v?: number;
  /** Floor snapping: the room's own floor level. */
  floorY?: number;
}

export interface SnapSolution {
  physical: Vec3;
  rotationYDeg: number;
  mount: PlacementMount;
  floorId: FloorId;
  roomId: RoomId | null;
  surfaceId: SurfaceId | null;
  indicator: SnapIndicatorState;
}

export interface SnapInput {
  hit: PickResult | null;
  config: SnapConfig;
  manifest: ManifestIndex;
  draft: {
    physical: Vec3;
    rotationYDeg: number;
    mount: PlacementMount;
    floorId: FloorId;
  };
  /** Used for the free-placement fallback when there is no hit. */
  freePoint?: THREE.Vector3 | null;
  /** Held Alt disables grid snapping; held Shift constrains to the dominant axis. */
  modifiers?: { alt?: boolean; shift?: boolean };
  /** Mesh lookup, so wall snapping can build the frame. */
  meshOf?: (surfaceId: SurfaceId) => THREE.Mesh | undefined;
  /** Room anchor lookup, so the wall normal can be oriented into the room. */
  anchorOf?: (roomId: RoomId) => Vec3 | undefined;
}

export function resolveSnap(input: SnapInput): SnapSolution {
  const { hit, manifest, draft } = input;
  const grid = input.config.enabled && !input.modifiers?.alt ? input.config.grid : 0;
  const snap = (v: number) => snapValue(v, grid);
  const rotationStep = input.config.enabled ? input.config.rotationStep : 0;

  // 1. WALL SNAP
  if (input.config.wallSnap && hit?.surfaceId && hit.roomId) {
    const surface = manifest.surfaces.get(hit.surfaceId);
    const mesh = input.meshOf?.(hit.surfaceId);
    const room = manifest.rooms.get(hit.roomId);
    if (surface?.kind === "wall" && mesh && room) {
      const anchor = input.anchorOf?.(room.id);
      const frame = wallFrame(mesh, {
        towards: anchor ? new THREE.Vector3(anchor[0], anchor[1], anchor[2]) : undefined,
      });
      const local = frame.toLocal(hit.point);
      const u = snap(local.u);
      const currentHeight =
        draft.mount.kind === "wall" ? draft.mount.height : local.v - room.floorElevation;
      const height = snap(currentHeight);
      const point = frame.toWorld(u, room.floorElevation + height, WALL_STANDOFF);
      // Face out of the wall, into the room.
      const rotY = THREE.MathUtils.radToDeg(Math.atan2(frame.n.x, frame.n.z));
      return {
        // Rounded to millimetres, **not** re-snapped to the grid: the grid snap already happened
        // in the wall's own frame (`u` and `height`), and re-snapping world X/Z here would eat
        // the 2 cm standoff and leave the marker co-planar with the wall it is mounted on.
        physical: [snapValue(point.x, 0), snapValue(point.y, 0), snapValue(point.z, 0)],
        rotationYDeg: snapValue(rotY, rotationStep),
        mount: { kind: "wall", surfaceId: hit.surfaceId, height, offset: WALL_STANDOFF },
        floorId: room.floorId,
        roomId: room.id,
        surfaceId: hit.surfaceId,
        indicator: { kind: "wall", point: [point.x, point.y, point.z], frame, u, v: height },
      };
    }
  }

  // 2. FLOOR SNAP
  if (hit?.surfaceId && hit.roomId) {
    const surface = manifest.surfaces.get(hit.surfaceId);
    const room = manifest.rooms.get(hit.roomId);
    if (surface?.kind === "floor" && room) {
      const height = draft.mount.kind === "floor" ? draft.mount.height : 0;
      const x = snap(hit.point.x);
      const z = snap(hit.point.z);
      return {
        physical: [x, snapValue(room.floorElevation + height, 0), z],
        rotationYDeg: snapValue(draft.rotationYDeg, rotationStep),
        mount: { kind: "floor", height },
        floorId: room.floorId,
        roomId: room.id,
        surfaceId: hit.surfaceId,
        indicator: { kind: "floor", point: [x, room.floorElevation, z], floorY: room.floorElevation },
      };
    }
  }

  // 3. FREE — a horizontal plane at the drafted floor's elevation.
  const floor = manifest.floors.get(draft.floorId);
  const planeY = floor?.elevation ?? draft.physical[1];
  const source = input.freePoint ?? new THREE.Vector3(draft.physical[0], planeY, draft.physical[2]);
  let x = snap(source.x);
  let z = snap(source.z);
  if (input.modifiers?.shift) {
    // Constrain to the dominant axis relative to where the draft started.
    const dx = Math.abs(x - draft.physical[0]);
    const dz = Math.abs(z - draft.physical[2]);
    if (dx >= dz) z = draft.physical[2];
    else x = draft.physical[0];
  }
  const roomId = roomAt(manifest, draft.floorId, x, z);
  const room = roomId ? manifest.rooms.get(roomId) : undefined;
  const base = room?.floorElevation ?? planeY;
  const height = draft.mount.kind === "floor" ? draft.mount.height : 0;
  return {
    physical: [x, snapValue(base + height, 0), z],
    rotationYDeg: snapValue(draft.rotationYDeg, rotationStep),
    mount: { kind: "floor", height },
    floorId: draft.floorId,
    roomId,
    surfaceId: null,
    indicator: { kind: "free", point: [x, base, z], floorY: base },
  };
}

/**
 * Numeric-mode resolution: no ray, the user typed the numbers. Reuses the same room resolution and
 * the same rounding so the two paths cannot drift.
 */
export function resolveNumeric(
  manifest: ManifestIndex,
  draft: { physical: Vec3; rotationYDeg: number; mount: PlacementMount; floorId: FloorId },
  config: SnapConfig,
): SnapSolution {
  const grid = config.enabled ? config.grid : 0;
  const x = snapValue(draft.physical[0], grid);
  const z = snapValue(draft.physical[2], grid);
  const roomId = roomAt(manifest, draft.floorId, x, z);
  const room = roomId ? manifest.rooms.get(roomId) : undefined;
  const y =
    draft.mount.kind === "floor" && room
      ? snapValue(room.floorElevation + draft.mount.height, 0)
      : snapValue(draft.physical[1], 0);
  return {
    physical: [x, y, z],
    rotationYDeg: snapValue(draft.rotationYDeg, config.enabled ? config.rotationStep : 0),
    mount: draft.mount,
    floorId: draft.floorId,
    roomId,
    surfaceId: draft.mount.kind === "wall" ? draft.mount.surfaceId : null,
    indicator: { kind: "free", point: [x, y, z] },
  };
}

/**
 * Dev-only guard for the save path: the draft's physical Y must equal the world Y minus the
 * group's presentation offset. Never used to *derive* the saved value — the draft is the authority.
 */
export function assertPhysicalY(
  worldY: number,
  explodeOffsetY: number,
  draftY: number,
  tolerance = 1e-3,
): void {
  if (process.env.NODE_ENV === "production") return;
  if (Math.abs(worldY - explodeOffsetY - draftY) > tolerance) {
    throw new Error(
      `[house] placement Y mismatch: world ${worldY} − offset ${explodeOffsetY} ≠ draft ${draftY}`,
    );
  }
}
