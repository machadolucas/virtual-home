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
import { canMountSurface, canAttachSurface } from "../model/mountSurface";
import type { GroundReference } from "./groundProjection";
export { isSoffitSurface } from "../model/mountSurface";
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
  ground?: GroundReference;
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
  if (input.config.wallSnap && hit?.surfaceId) {
    const mesh = input.meshOf?.(hit.surfaceId);
    const room = hit.roomId ? manifest.rooms.get(hit.roomId) : undefined;
    const floorId = room?.floorId ?? manifest.floorOfSurface.get(hit.surfaceId) ?? hit.floorId ?? draft.floorId;
    const base = room?.floorElevation ?? manifest.floors.get(floorId)?.elevation ?? 0;
    if (canMountSurface(manifest, hit.surfaceId, "wall") && mesh) {
      const anchor = room ? input.anchorOf?.(room.id) : undefined;
      const frame = wallFrame(mesh, {
        point: hit.point, normal: hit.normal,
        towards: hit.normal ? hit.point.clone().add(hit.normal) : anchor ? new THREE.Vector3(...anchor) : undefined,
      });
      const local = frame.toLocal(hit.point);
      const u = snap(local.u);
      const currentHeight =
        draft.mount.kind === "wall" ? draft.mount.height : local.v - base;
      const height = snap(currentHeight);
      const point = frame.toWorld(u, base + height, WALL_STANDOFF);
      // Face towards the picked side, even if an exterior face has a room association.
      const rotY = THREE.MathUtils.radToDeg(Math.atan2(frame.n.x, frame.n.z));
      return {
        // Rounded to millimetres, **not** re-snapped to the grid: the grid snap already happened
        // in the wall's own frame (`u` and `height`), and re-snapping world X/Z here would eat
        // the 2 cm standoff and leave the marker co-planar with the wall it is mounted on.
        physical: [snapValue(point.x, 0), snapValue(point.y, 0), snapValue(point.z, 0)],
        rotationYDeg: snapValue(rotY, rotationStep),
        mount: { kind: "wall", surfaceId: hit.surfaceId, height, offset: WALL_STANDOFF },
        floorId,
        roomId: room?.id ?? null,
        surfaceId: hit.surfaceId,
        indicator: { kind: "wall", point: [point.x, point.y, point.z], frame, u, v: height },
      };
    }
  }

  // 2. CEILING / SOFFIT SNAP
  //
  // The case that used to be impossible: an eave spot. The package's roof undersides
  // (`s-e-roof-*-under`) are surfaces of kind `other`, and ceilings inside are kind `ceiling`;
  // neither was in the pick set and the mount union could not name them. Now a hit on either
  // hangs the fixture from the surface, `height` metres below it.
  if (hit?.surfaceId) {
    const overhead = canMountSurface(manifest, hit.surfaceId, "ceiling");
    if (overhead) {
      const drop = draft.mount.kind === "ceiling" ? draft.mount.height : 0;
      const x = snap(hit.point.x);
      const z = snap(hit.point.z);
      const y = snapValue(hit.point.y - drop, 0);
      const room = hit.roomId ? manifest.rooms.get(hit.roomId) : undefined;
      return {
        physical: [x, y, z],
        rotationYDeg: snapValue(draft.rotationYDeg, rotationStep),
        mount: {
          kind: "ceiling",
          surfaceId: hit.surfaceId,
          height: drop,
          offset: draft.mount.kind === "ceiling" ? draft.mount.offset : 0,
        },
        floorId: room?.floorId ?? manifest.floorOfSurface.get(hit.surfaceId) ?? hit.floorId ?? draft.floorId,
        roomId: room?.id ?? null,
        surfaceId: hit.surfaceId,
        indicator: { kind: "free", point: [x, y, z], floorY: hit.point.y },
      };
    }
  }

  // 3. FLOOR SNAP
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
        indicator: { kind: "floor", point: [x, snapValue(room.floorElevation + height, 0), z], floorY: room.floorElevation },
      };
    }
  }

  // Other physical surfaces use a free mount with an exact attachment reference. Do not flatten
  // a door reveal to its surrounding wall, or grid-round a narrow frame off its actual face.
  if (hit?.surfaceId && canAttachSurface(manifest, hit.surfaceId)) {
    const floorId = manifest.floorOfSurface.get(hit.surfaceId) ?? hit.floorId ?? draft.floorId;
    const roomId = hit.roomId ?? roomAt(manifest, floorId, hit.point.x, hit.point.z);
    const base = (roomId ? manifest.rooms.get(roomId)?.floorElevation : undefined)
      ?? manifest.floors.get(floorId)?.elevation ?? 0;
    const normal = hit.normal?.clone().normalize();
    const point = hit.point.clone();
    if (normal) point.addScaledVector(normal, WALL_STANDOFF);
    const physical: Vec3 = [snapValue(point.x, 0), snapValue(point.y, 0), snapValue(point.z, 0)];
    return {
      physical,
      rotationYDeg: normal && Math.hypot(normal.x, normal.z) > 0.01
        ? snapValue(THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z)), 0) : draft.rotationYDeg,
      mount: { kind: "free", surfaceId: hit.surfaceId, height: snapValue(physical[1] - base, 0) },
      floorId, roomId, surfaceId: hit.surfaceId,
      indicator: { kind: "free", point: physical },
    };
  }

  // 4. FREE — a horizontal plane at the drafted floor's elevation.
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
    indicator: { kind: "free", point: [x, snapValue(base + height, 0), z], floorY: base },
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
  opts: {
    /** The previous mount, so a changed height can move the marker rather than just disagree with it. */
    previousMount?: PlacementMount;
    meshOf?: (surfaceId: SurfaceId) => THREE.Mesh | undefined;
    anchorOf?: (roomId: RoomId) => Vec3 | undefined;
  } = {},
): SnapSolution {
  const grid = config.enabled ? config.grid : 0;
  let x = snapValue(draft.physical[0], grid);
  let z = snapValue(draft.physical[2], grid);
  const surfaceId = "surfaceId" in draft.mount ? draft.mount.surfaceId ?? null : null;
  const surface = surfaceId ? manifest.surfaces.get(surfaceId) : undefined;
  const floorId = (surfaceId ? manifest.floorOfSurface.get(surfaceId) : null) ?? draft.floorId;
  const roomId = surface
    ? surface.roomId ?? (draft.mount.kind === "free" ? roomAt(manifest, floorId, x, z) : null)
    : roomAt(manifest, floorId, x, z);
  const room = roomId ? manifest.rooms.get(roomId) : undefined;

  /**
   * The position follows the mount for **every** kind now.
   *
   * It used to be derived from the height only for a floor mount with a room, so a typed height or
   * standoff on a wall, ceiling or free mount changed `mount` and nothing else — and the row was
   * then saved with the old `pos_y` beside the new `mount_height_m`. The inspector read one number
   * and the marker sat at another.
   */
  let y = snapValue(draft.physical[1], 0);
  const mount = draft.mount;

  if (mount.kind === "free" && mount.surfaceId) {
    // Small frames and angled faces must not jump onto the global grid during an unrelated edit.
    x = snapValue(draft.physical[0], 0);
    z = snapValue(draft.physical[2], 0);
    const base = room?.floorElevation ?? manifest.floors.get(floorId)?.elevation ?? 0;
    y = snapValue(base + mount.height, 0);
  } else if (mount.kind === "floor" || mount.kind === "free") {
    const base = room?.floorElevation ?? manifest.floors.get(floorId)?.elevation ?? 0;
    y = snapValue(base + mount.height, 0);
  } else if (mount.kind === "wall") {
    const base = room?.floorElevation ?? manifest.floors.get(floorId)?.elevation ?? 0;
    const mesh = opts.meshOf?.(mount.surfaceId);
    if (mesh) {
      // Project onto the wall's own plane, exactly as the drag path does, so the standoff moves
      // the marker along the surface normal instead of only changing a number.
      const source = new THREE.Vector3(...draft.physical);
      let frame = wallFrame(mesh, { point: source, towards: source });
      // A flush mount has no positional side information; its saved facing direction retains it.
      if (Math.abs(frame.toLocal(source).d) < 1e-6) {
        const yaw = THREE.MathUtils.degToRad(draft.rotationYDeg);
        frame = wallFrame(mesh, { point: source, towards: source.clone().add(new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))) });
      }
      const local = frame.toLocal(source);
      const world = frame.toWorld(snapValue(local.u, grid), base + mount.height, mount.offset);
      x = snapValue(world.x, 0);
      y = snapValue(world.y, 0);
      z = snapValue(world.z, 0);
    } else {
      y = snapValue(base + mount.height, 0);
    }
  } else {
    // Ceiling: `height` is the drop *below* the surface, so the surface plane is recovered from
    // where the marker is now plus the drop it had, and the new drop is applied to that.
    const previousDrop = opts.previousMount?.kind === "ceiling" ? opts.previousMount.height : 0;
    const surfaceY = draft.physical[1] + previousDrop;
    y = snapValue(surfaceY - mount.height, 0);
  }

  return {
    physical: [x, y, z],
    rotationYDeg: snapValue(draft.rotationYDeg, config.enabled ? config.rotationStep : 0),
    mount: draft.mount,
    floorId,
    roomId,
    surfaceId,
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
