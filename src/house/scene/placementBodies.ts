import * as THREE from "three";
import type { EditDraft } from "../store/slices/edit";
import type { Placement } from "../model/types";
import type { VisibilityPlan } from "../model/visibilityPlan";
import type { SceneIndex } from "./SceneIndex";

/** A package body belongs to its authored floor. Other floors and unloaded assets use the placement symbol. */
export function hasPlacementBody(index: SceneIndex, id: string, floorId: string): boolean {
  const entry = index.placementBodies.get(id);
  return !!entry && index.manifest.assets.get(entry.assetId)?.floorId === floorId;
}

export function applyPlacementBodies(index: SceneIndex, plan: VisibilityPlan, placements: readonly Placement[], draft: EditDraft | null): void {
  for (const [id, { assetId, pose }] of index.placementBodies) {
    const placement = draft?.placementId === id ? draft : placements.find(p => p.id === id);
    const asset = index.manifest.assets.get(assetId);
    const binding = asset?.placementBody;
    if (!placement || !binding || placement.floorId !== asset?.floorId) {
      plan.assets.set(assetId, false);
      continue;
    }
    const target = "physical" in placement ? placement.physical : placement.position;
    pose.rotation.y = THREE.MathUtils.degToRad(placement.rotationYDeg - binding.rotationYDeg);
    // Rotate around the authored mounting point, even when far from the scene origin.
    pose.position.fromArray(binding.anchor).applyQuaternion(pose.quaternion).negate();
    pose.position.x += target[0];
    pose.position.y += target[1];
    pose.position.z += target[2];
    pose.updateMatrixWorld(true);
  }
}
