/**
 * Exploded floors.
 *
 * Two categories of object move together, by the same offset: the shell nodes of a group, and the
 * app-owned overlay group that hosts that group's markers, routes and anchors. Overlay **children
 * keep physical coordinates** — the offset lives only on the group — so nothing in the data ever
 * encodes a presentation transform.
 *
 * Every node has an identity transform in the shipped package, so writing `.position.y` is safe
 * and exactly reversible. Because `matrixAutoUpdate` is off for static nodes, each moved node's
 * matrix is updated explicitly.
 */
import type * as THREE from "three";
import { buildGroupOrder, explodeOffset } from "@/house/model/explodeGroups";
import { nodeKey } from "@/house/model/manifestIndex";
import type { ExplodeGroup } from "@/house/model/types";
import { explodeGroupOf } from "@/house/model/explodeGroups";
import type { SceneIndex } from "./SceneIndex";

export interface ExplodeState {
  enabled: boolean;
  gap: number;
}

export interface ExplodeApplied {
  offsets: Map<ExplodeGroup, number>;
  moved: number;
}

/** The objects that must move for each group: the top-level nodes plus the asset's edges node. */
export function explodeTargets(index: SceneIndex): Map<ExplodeGroup, THREE.Object3D[]> {
  const out = new Map<ExplodeGroup, THREE.Object3D[]>();
  for (const entry of index.assets.values()) {
    const names = [
      ...entry.inventory.floorNodes,
      ...entry.inventory.floorlessElementNodes,
      ...(entry.inventory.edgesNode ? [entry.inventory.edgesNode] : []),
    ];
    for (const name of names) {
      const node = entry.nodes.get(name);
      if (!node) continue;
      const group = explodeGroupOf(index.manifest, entry.id, name);
      if (!group) continue;
      const list = out.get(group);
      if (list) list.push(node);
      else out.set(group, [node]);
    }
    // An asset with no container children at all (nothing but surfaces) moves as a whole.
    if (names.length === 0) {
      const group = explodeGroupOf(index.manifest, entry.id, entry.id) ?? "site";
      const list = out.get(group);
      if (list) list.push(entry.root);
      else out.set(group, [entry.root]);
    }
  }
  return out;
}

export function applyExplode(
  index: SceneIndex,
  state: ExplodeState,
  invalidate?: () => void,
): ExplodeApplied {
  const order = buildGroupOrder(index.manifest);
  const gap = state.enabled ? state.gap : 0;
  const targets = explodeTargets(index);
  const offsets = new Map<ExplodeGroup, number>();
  let moved = 0;

  for (const group of new Set([...targets.keys(), ...index.overlay.floorGroups.keys()])) {
    const offset = explodeOffset(order, group, gap);
    offsets.set(group, offset);

    for (const node of targets.get(group) ?? []) {
      if (node.position.y === offset) continue;
      node.position.y = offset;
      node.updateMatrix();
      node.updateMatrixWorld(true);
      moved++;
    }
    const overlay = index.overlay.floorGroups.get(group);
    if (overlay && overlay.position.y !== offset) {
      overlay.position.y = offset;
      overlay.updateMatrixWorld(true);
      moved++;
    }
  }

  if (moved && invalidate) invalidate();
  return { offsets, moved };
}

export function offsetsFor(index: SceneIndex, state: ExplodeState): Map<ExplodeGroup, number> {
  const order = buildGroupOrder(index.manifest);
  const gap = state.enabled ? state.gap : 0;
  const out = new Map<ExplodeGroup, number>();
  for (const group of order.keys()) out.set(group, explodeOffset(order, group, gap));
  return out;
}

/** World Y of an indexed node, for the test hook's explode assertions. */
export function worldY(index: SceneIndex, assetId: string, nodeName: string): number | null {
  const node = index.assets.get(assetId)?.nodes.get(nodeName);
  if (!node) return null;
  node.updateWorldMatrix(true, false);
  return node.matrixWorld.elements[13] ?? 0;
}

export const nodeKeyOf = nodeKey;
