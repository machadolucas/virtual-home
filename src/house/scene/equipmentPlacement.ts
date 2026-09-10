import * as THREE from "three";
import type { EditDraft } from "../store/slices/edit";
import { defaultSymbol, isPlacementSymbol, symbolGeometry } from "./symbols";
import { equipmentSymbolScale } from "../model/equipmentScale";
import { DEFAULT_SOLAR_PANEL_CONFIG } from "../model/solarPanel";
import { collisionShapeFromGeometry, collidesWithPlacementShape, furnishingCollisionShape, furnishingWallCollision, wallTriangles, type PlacementCollisionShape, type PlacementEnvelope } from "./furnishingPlacement";
import type { SceneIndex } from "./SceneIndex";
import type { Furnishing, Placement } from "../model/types";

export function equipmentPreviewShape(draft: EditDraft | Placement) {
  const symbol = isPlacementSymbol(draft.symbol) ? draft.symbol : defaultSymbol({
    category: draft.category, entityId: draft.entityId, mountKind: draft.mount.kind, isOutdoor: !draft.roomId });
  const geometry = symbolGeometry(symbol);
  const panel = symbol === "solar_panel" ? draft.solarPanel ?? DEFAULT_SOLAR_PANEL_CONFIG : null;
  const scale = new THREE.Vector3(...equipmentSymbolScale({ ...draft, symbol }));
  return { geometry, scale, tilt: THREE.MathUtils.degToRad(panel?.tiltDeg ?? 0) };
}

/** Extra distance needed to put the symbol's back, rather than merely its origin, on a face. */
export function equipmentFaceOffset(draft: EditDraft | Placement): number {
  const { geometry, scale, tilt } = equipmentPreviewShape(draft);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
  bounds.applyMatrix4(new THREE.Matrix4().makeRotationX(tilt));
  return Math.max(0, -bounds.min.z);
}

/** Physical render geometry used for mutual object collisions. Floor heating is an underlay. */
export function equipmentCollisionShape(draft: EditDraft | Placement): PlacementCollisionShape | null {
  const { geometry, scale, tilt } = equipmentPreviewShape(draft);
  const symbol = isPlacementSymbol(draft.symbol) ? draft.symbol : defaultSymbol({
    category: draft.category, entityId: draft.entityId, mountKind: draft.mount.kind, isOutdoor: !draft.roomId });
  if (symbol === "floor_heating") return null;
  const physical = "physical" in draft ? draft.physical : draft.position;
  return collisionShapeFromGeometry("placementId" in draft ? draft.placementId ?? "" : draft.id,
    geometry, physical, draft.rotationYDeg, scale, tilt);
}

/** The rendered symbol's yaw-only physical envelope, retaining non-centred mount anchors. */
export function equipmentPlacementEnvelope(draft: EditDraft | Placement): PlacementEnvelope {
  const { geometry, scale, tilt } = equipmentPreviewShape(draft);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
  bounds.applyMatrix4(new THREE.Matrix4().makeRotationX(tilt));
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  center.y = bounds.min.y;
  const physical = "physical" in draft ? draft.physical : draft.position;
  center.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(draft.rotationYDeg)).add(new THREE.Vector3(...physical));
  return { id: "placementId" in draft ? draft.placementId ?? "" : draft.id,
    position: center.toArray(), rotationYDeg: draft.rotationYDeg,
    widthM: size.x, heightM: size.y, depthM: size.z } as PlacementEnvelope;
}

/** Test the model and placed-object envelopes; contact with the supporting face is intentional. */
export function equipmentWallError(
  draft: EditDraft,
  index: SceneIndex,
  furnishings: readonly Furnishing[] = [],
  placements: readonly Placement[] = [],
): string | null {
  const box = equipmentPlacementEnvelope(draft);
  if (furnishingWallCollision(box, wallTriangles(index), draft.surfaceId))
    return "Overlaps a wall or door. Move or rotate the equipment.";
  if (collidesWithPlacementShape(equipmentCollisionShape(draft), [
    ...furnishings.map(furnishingCollisionShape),
    ...placements.filter((placement) => placement.id !== draft.placementId).map(equipmentCollisionShape),
  ])) return "Overlaps furniture or equipment. Move or rotate the equipment.";
  return null;
}
