/**
 * Finds the physical ground reference for an equipment preview.
 *
 * A point on a wall or ceiling is useful on its own, but it is hard to read in a perspective
 * view. This helper deliberately has no React or store dependency: hover callers can use it to
 * decorate a preview without mutating the edit draft.
 */
import * as THREE from "three";
import type { FloorId, RoomId, SurfaceId, Vec3 } from "@/house/model/types";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { SceneIndex } from "./SceneIndex";

export interface GroundReference {
  point: Vec3;
  label: string;
  source: "surface" | "floor-datum";
  surfaceId?: SurfaceId;
}

export interface GroundProjectionInput {
  /** Physical preview point. The helper never mutates this vector. */
  point: Vec3;
  floorId: FloorId;
  roomId?: RoomId | null;
  manifest: ManifestIndex;
  sceneIndex?: SceneIndex | null;
  /** Presentation offset applied to loaded model roots, if one is active. */
  presentationOffsetY?: number;
}

/**
 * Resolve an elevated point to the ground that a user would expect to see below it.
 *
 * Interior placements use their room floor datum because that remains stable while the model is
 * exploded and because the room footprint is the source of truth for the interior floor. Outside
 * a room we raycast down through loaded floor/paving/terrain surfaces. A floor datum is the honest
 * fallback when the site geometry is unloaded or a ray misses it.
 */
export function projectGroundReference(input: GroundProjectionInput): GroundReference {
  const { point, floorId, roomId, manifest, sceneIndex } = input;
  const room = roomId ? manifest.rooms.get(roomId) : undefined;
  if (room) {
    return {
      point: [point[0], room.floorElevation, point[2]],
      label: `${room.name} floor`,
      source: "surface",
    };
  }

  const offsetY = input.presentationOffsetY ?? 0;
  if (sceneIndex) {
    const hit = downwardGroundHit(point, sceneIndex, offsetY);
    if (hit) {
      return {
        point: [hit.point.x, hit.point.y - offsetY, hit.point.z],
        label: groundLabel(hit.surfaceId, manifest),
        source: "surface",
        surfaceId: hit.surfaceId,
      };
    }
  }

  const floorY = manifest.floors.get(floorId)?.elevation;
  return {
    point: [point[0], floorY ?? point[1], point[2]],
    label: "Floor datum",
    source: "floor-datum",
  };
}

interface GroundHit {
  point: THREE.Vector3;
  surfaceId: SurfaceId;
}

function downwardGroundHit(
  point: Vec3,
  sceneIndex: SceneIndex,
  presentationOffsetY: number,
): GroundHit | null {
  const meshes: THREE.Mesh[] = [];
  for (const [surfaceId, mesh] of sceneIndex.surfaceMesh) {
    const surface = sceneIndex.manifest.surfaces.get(surfaceId);
    if (!surface || !isGroundSurface(surface, sceneIndex.manifest)) continue;
    meshes.push(mesh);
  }
  if (meshes.length === 0) return null;

  // Start just above the preview. This allows a point flush with an exterior surface to find the
  // ground below it and avoids a coplanar self-hit when an outdoor mesh is also the source hit.
  const ray = new THREE.Raycaster(
    new THREE.Vector3(point[0], point[1] + presentationOffsetY + 1e-4, point[2]),
    new THREE.Vector3(0, -1, 0),
    0,
    Number.POSITIVE_INFINITY,
  );
  const hit = ray.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const surfaceId = sceneIndex.meshSurfaceId.get(hit.object) ?? hit.object.userData.surfaceId;
  return typeof surfaceId === "string" ? { point: hit.point, surfaceId } : null;
}

function isGroundSurface(
  surface: { kind: string; role?: string; elementId?: string },
  manifest: ManifestIndex,
): boolean {
  if (surface.kind === "floor") return true;
  const elementKind = surface.elementId ? manifest.elements.get(surface.elementId)?.kind : undefined;
  if (elementKind === "terrain" || elementKind === "paving") return true;
  const role = surface.role?.toLowerCase();
  if (role === "ground" || role === "terrain" || role === "paving") return true;
  return false;
}

function groundLabel(surfaceId: SurfaceId, manifest: ManifestIndex): string {
  const surface = manifest.surfaces.get(surfaceId);
  const element = surface?.elementId ? manifest.elements.get(surface.elementId) : undefined;
  if (element?.kind === "paving" || surface?.role?.toLowerCase() === "paving") return "Paving";
  if (element?.kind === "terrain" || surface?.role?.toLowerCase() === "terrain") return "Terrain";
  return "Ground";
}
