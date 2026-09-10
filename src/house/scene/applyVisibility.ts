/**
 * Apply a `VisibilityPlan` to the scene and rebuild the pickable list.
 *
 * The plan is re-resolved in full on every change, so this writes `.visible` on every indexed
 * asset root and node rather than trying to diff. Rebuilding `pickables` here, once per change,
 * rather than traversing on every click is what keeps selection under 100 ms.
 */
import type * as THREE from "three";
import { nodeKey } from "@/house/model/manifestIndex";
import type { VisibilityPlan } from "@/house/model/visibilityPlan";
import type { SceneIndex } from "./SceneIndex";

export interface ApplyVisibilityResult {
  pickables: number;
  changed: number;
}

export function applyVisibility(
  plan: VisibilityPlan,
  index: SceneIndex,
  invalidate?: () => void,
): ApplyVisibilityResult {
  let changed = 0;

  for (const [assetId, entry] of index.assets) {
    const visible = plan.assets.get(assetId) ?? true;
    if (entry.root.visible !== visible) {
      entry.root.visible = visible;
      changed++;
    }
    for (const [name, node] of entry.nodes) {
      if (node.userData.vhInvalidWallCap) {
        if (node.visible) { node.visible = false; changed++; }
        continue;
      }
      const decision = plan.nodes.get(nodeKey(assetId, name));
      if (decision === undefined) {
        if (!node.visible && node !== entry.root) {
          // Nothing in the plan mentions this node, so it is unconditionally visible.
          node.visible = true;
          changed++;
        }
        continue;
      }
      if (node.visible !== decision) {
        node.visible = decision;
        changed++;
      }
    }
  }

  rebuildPickables(index);
  if (changed && invalidate) invalidate();
  return { pickables: index.pickables.length, changed };
}

/** Visible meshes whose every ancestor is visible, flattened for `intersectObjects(list, false)`. */
export function rebuildPickables(index: SceneIndex): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const entry of index.assets.values()) {
    if (!entry.root.visible) continue;
    for (const mesh of entry.meshes) {
      if (isVisibleUp(mesh)) out.push(mesh);
    }
  }
  index.pickables = out;
  return out;
}

export function isVisibleUp(object: THREE.Object3D): boolean {
  let o: THREE.Object3D | null = object;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}
