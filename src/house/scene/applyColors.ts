/**
 * Apply a pure colour plan to the scene.
 *
 * `material.color.set('#rrggbb')` is correct with three's default `ColorManagement.enabled`: the
 * hex is read as sRGB and converted into the linear working space, which is exactly how
 * GLTFLoader assigned `baseColorFactor`. No manual conversion, and `needsUpdate` is deliberately
 * not set — colour is a uniform.
 */
import type * as THREE from "three";
import type { NodeColorPlan } from "@/house/model/colorPlan";
import type { SurfaceId } from "@/house/model/types";
import type { SceneIndex } from "./SceneIndex";

export interface ApplyColorsResult {
  touched: number;
  /** Surfaces in the plan whose node carries no material (mesh-less by design). */
  skipped: SurfaceId[];
}

export function applyColors(
  plan: NodeColorPlan,
  index: SceneIndex,
  invalidate?: () => void,
): ApplyColorsResult {
  let touched = 0;
  const skipped: SurfaceId[] = [];
  for (const { surfaceId, hex } of plan) {
    const mesh = index.surfaceMesh.get(surfaceId);
    if (!mesh) {
      skipped.push(surfaceId);
      continue;
    }
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    if (!mat?.color) {
      skipped.push(surfaceId);
      continue;
    }
    mat.color.set(hex);
    touched++;
  }
  if (touched && invalidate) invalidate();
  return { touched, skipped };
}

/** Current sRGB hex of a surface's material, or `null` when the node has none. */
export function materialHex(index: SceneIndex, surfaceId: SurfaceId): string | null {
  const mat = index.surfaceMesh.get(surfaceId)?.material as THREE.MeshStandardMaterial | undefined;
  if (!mat?.color) return null;
  return `#${mat.color.getHexString()}`;
}

export function allMaterialHex(index: SceneIndex): Record<SurfaceId, string> {
  const out: Record<SurfaceId, string> = {};
  for (const sid of index.surfaceMesh.keys()) {
    const hex = materialHex(index, sid);
    if (hex) out[sid] = hex;
  }
  return out;
}
