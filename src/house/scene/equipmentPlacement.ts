import * as THREE from "three";
import type { EditDraft } from "../store/slices/edit";
import { defaultSymbol, isPlacementSymbol, symbolGeometry } from "./symbols";
import { equipmentSymbolScale } from "../model/equipmentScale";
import { DEFAULT_SOLAR_PANEL_CONFIG } from "../model/solarPanel";
import { furnishingWallCollision, wallTriangles } from "./furnishingPlacement";
import type { SceneIndex } from "./SceneIndex";
import type { Furnishing } from "../model/types";

export function equipmentPreviewShape(draft: EditDraft) {
  const symbol = isPlacementSymbol(draft.symbol) ? draft.symbol : defaultSymbol({
    category: draft.category, entityId: draft.entityId, mountKind: draft.mount.kind, isOutdoor: !draft.roomId });
  const geometry = symbolGeometry(symbol);
  const panel = symbol === "solar_panel" ? draft.solarPanel ?? DEFAULT_SOLAR_PANEL_CONFIG : null;
  const scale = new THREE.Vector3(...equipmentSymbolScale({ ...draft, symbol }));
  return { geometry, scale, tilt: THREE.MathUtils.degToRad(panel?.tiltDeg ?? 0) };
}

/** Test the model's physical envelope; mounting contact with its own surface is intentional. */
export function equipmentWallError(draft: EditDraft, index: SceneIndex): string | null {
  const { geometry, scale, tilt } = equipmentPreviewShape(draft);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
  bounds.applyMatrix4(new THREE.Matrix4().makeRotationX(tilt));
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  center.y = bounds.min.y;
  center.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(draft.rotationYDeg)).add(new THREE.Vector3(...draft.physical));
  const box = { position: center.toArray(), rotationYDeg: draft.rotationYDeg,
    widthM: size.x, heightM: size.y, depthM: size.z } as Furnishing;
  return furnishingWallCollision(box, wallTriangles(index), draft.surfaceId) ? "Overlaps a wall or door. Move or rotate the equipment." : null;
}
