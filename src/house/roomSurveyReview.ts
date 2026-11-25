import type { Furnishing } from "./model/types";
import { roomAt } from "./model/manifestIndex";
import type { HouseRuntime } from "./runtime";
import { equipmentCollisionShape, equipmentWallError } from "./scene/equipmentPlacement";
import { clearFurnishingCollisionCache, furnishingCollisionShape, furnishingPlacementError } from "./scene/furnishingPlacement";
import { applyRoomSurveyMove, undoRoomSurveyMove } from "./roomSurveyApi";
import type { RoomSurveyMove, RoomSurveySummary } from "./roomSurveyTypes";

/** Use the normal editors' physical wall and placement collision checks before an approved write. */
export async function reviewRoomSurveyMove(
  runtime: HouseRuntime, survey: RoomSurveySummary, move: RoomSurveyMove, action: "apply" | "undo",
) {
  const state = runtime.store.getState();
  if (state.fingerprint !== survey.fingerprint || !state.modelId) throw new Error("This survey uses a different model revision.");
  if (move.applyBlockedReason) throw new Error("The measured point is saved for manual review of its mounting surface.");
  if (!runtime.index || !runtime.manifest || state.tier0AssetIds.some((id) => !state.loadedAssetIds.includes(id)))
    throw new Error("Wait for the room model to finish loading before approving the move.");
  if (state.explode.locked) throw new Error("Finish the current placement edit before approving this move.");

  const modelId = state.modelId;
  const [placements, furnitureResponse] = await Promise.all([
    runtime.dataApi.listPlacements(modelId),
    fetch(`${runtime.base}/furnishings`, { cache: "no-store" }),
  ]);
  if (!furnitureResponse.ok) throw new Error("Could not load the current furniture placements.");
  const { furnishings } = await furnitureResponse.json() as { furnishings: Furnishing[] };
  const index = runtime.index;
  const current = runtime.store.getState();
  if (!index || current.fingerprint !== survey.fingerprint)
    throw new Error("The room model changed during review.");
  if (current.explode.locked || current.editing || current.routeDraft || current.furnishingsEditing)
    throw new Error("Finish the current placement edit before approving this move.");
  const pose = action === "apply" ? move.after : move.before;
  const roomId = roomAt(index.manifest, survey.floorId, pose.position[0], pose.position[2]);
  // The normal checks consume world matrices. Assemble and restore synchronously, including when
  // validation throws. No frame or network write needs to see this temporary presentation state.
  const restoreExplode = current.explode.enabled && current.explode.gap > 0;
  if (restoreExplode) current.setExplode({ enabled: false });
  clearFurnishingCollisionCache(index);
  try {
    let error: string | null;
    if (move.target.kind === "equipment") {
      const target = placements.find((item) => item.id === move.target.id);
      if (!target) throw new Error("The equipment placement is no longer available.");
      error = equipmentWallError({ ...target, position: pose.position, rotationYDeg: pose.yawDeg, roomId }, index, furnishings, placements);
    } else {
      const target = furnishings.find((item) => item.id === move.target.id);
      if (!target) throw new Error("The furniture placement is no longer available.");
      error = furnishingPlacementError({ ...target, position: pose.position, rotationYDeg: pose.yawDeg, roomId }, index, [
        ...furnishings.filter((item) => item.id !== target.id).map(furnishingCollisionShape),
        ...placements.map(equipmentCollisionShape),
      ]);
    }
    if (error) throw new Error(error);
  } finally {
    if (restoreExplode) {
      current.setExplode({ enabled: true });
      clearFurnishingCollisionCache(index);
    }
  }
  const write = action === "apply" ? applyRoomSurveyMove : undoRoomSurveyMove;
  return write(runtime.base, survey.id, move.id);
}
