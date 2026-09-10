import { describe, expect, it } from "vitest";
import { equipmentCollisionShape, equipmentFaceOffset, equipmentPlacementEnvelope } from "@/house/scene/equipmentPlacement";
import { placementShapeCollision } from "@/house/scene/furnishingPlacement";
import type { Placement } from "@/house/model/types";

const placement: Placement = {
  id: "sensor", modelId: "synthetic", equipmentId: "equipment", name: "Remote",
  position: [1, 1, 1], rotationYDeg: 0, mount: { kind: "free", height: 1 },
  floorId: "floor", roomId: "room", surfaceId: null, locationNote: "", photoId: null,
  entityId: null, symbol: "sensor", category: null,
};

describe("equipment placement envelope", () => {
  it("keeps the rendered symbol dimensions and mount anchor", () => {
    const envelope = equipmentPlacementEnvelope(placement);
    expect(envelope.id).toBe("sensor");
    expect(envelope.position[1]).toBeCloseTo(1);
    expect(envelope.widthM).toBeCloseTo(.08);
    expect(envelope.heightM).toBeCloseTo(.1);
    expect(envelope.depthM).toBeCloseTo(.04);
  });

  it("adds the symbol's rear extent when attaching its outward face", () => {
    expect(equipmentFaceOffset(placement)).toBeGreaterThan(0);
    expect(equipmentFaceOffset(placement)).toBeLessThan(.03);
  });

  it("blocks overlapping fridge/freezer bodies and ignores floor-heating underlays", () => {
    const fridge = equipmentCollisionShape({ ...placement, id: "fridge", symbol: "fridge", position: [0, 0, 0] })!;
    const freezer = equipmentCollisionShape({ ...placement, id: "freezer", symbol: "freezer", position: [.4, 0, 0] })!;
    expect(placementShapeCollision(fridge, freezer)).toBe(true);
    expect(equipmentCollisionShape({ ...placement, symbol: "floor_heating" })).toBeNull();
  });

  it("allows a remote against the fridge door while rejecting penetration into it", () => {
    const fridge = equipmentCollisionShape({ ...placement, id: "fridge", symbol: "fridge", position: [0, 0, 0] })!;
    const remote = { ...placement, symbol: "remote_control" as const };
    // The body is shallower than its protruding handles: a remote can sit between them.
    const front = .085 * (.65 / .182);
    const attached = equipmentCollisionShape({ ...remote, position: [0, .9, front + equipmentFaceOffset(remote) + .005] })!;
    expect(placementShapeCollision(fridge, attached)).toBe(false);
    const embedded = equipmentCollisionShape({ ...remote, position: [0, .9, front - .02] })!;
    expect(placementShapeCollision(fridge, embedded)).toBe(true);
  });
});
