import CameraControlsImpl from "camera-controls";
import { describe, expect, it } from "vitest";
import { controlBindings } from "@/house/components/Rig";
import { createHouseStore } from "@/house/store/createHouseStore";

const ACTION = CameraControlsImpl.ACTION;

describe("viewer control bindings", () => {
  it.each(["select", "place"] as const)(
    "%s gives up only the left button while preserving wheel zoom and right-button pan",
    (tool) => {
      const perspective = controlBindings("overview", "perspective", tool, false);
      expect(perspective.left).toBe(ACTION.NONE);
      expect(perspective.right).toBe(ACTION.TRUCK);
      expect(perspective.wheel).toBe(ACTION.DOLLY);
      expect(perspective.oneTouch).toBe(ACTION.NONE);

      const ortho = controlBindings("floor", "ortho", tool, false);
      expect(ortho.left).toBe(ACTION.NONE);
      expect(ortho.right).toBe(ACTION.TRUCK);
      expect(ortho.wheel).toBe(ACTION.ZOOM);
    },
  );

  it("restores the appropriate left gesture while orbiting or holding Space", () => {
    expect(controlBindings("overview", "perspective", "orbit", false).left).toBe(ACTION.ROTATE);
    expect(controlBindings("plan", "ortho", "orbit", false).left).toBe(ACTION.TRUCK);
    expect(controlBindings("overview", "perspective", "select", true).left).toBe(ACTION.ROTATE);
    expect(controlBindings("plan", "ortho", "place", true).left).toBe(ACTION.TRUCK);
  });
});

describe("wall display presets", () => {
  it("keeps the roof and ceiling switches synchronized with the four wall modes", () => {
    const store = createHouseStore();
    store.getState().setWallMode("contextual");
    expect(store.getState()).toMatchObject({
      wallMode: "contextual",
      roofVisible: false,
      ceilingsVisible: false,
      wallModeExplicit: true,
    });

    store.getState().setWallMode("closed");
    expect(store.getState()).toMatchObject({
      wallMode: "closed",
      roofVisible: true,
      ceilingsVisible: true,
    });

    store.getState().setCeilingsVisible(false);
    expect(store.getState()).toMatchObject({
      wallMode: "up",
      roofVisible: true,
      ceilingsVisible: false,
    });
  });

  it("opens a floor focus after a closed shell, then honors a later close", () => {
    const automatic = createHouseStore();
    automatic.getState().setFocusSelection({ kind: "room", id: "r-upper" });
    automatic.getState().isolateFloor("f-upper");
    expect(automatic.getState()).toMatchObject({
      activeFloorId: "f-upper",
      selection: { kind: "floor", id: "f-upper" },
      focusSelection: null,
      wallMode: "contextual",
      wallModeExplicit: false,
    });

    const explicit = createHouseStore();
    explicit.getState().setWallMode("closed");
    explicit.getState().isolateFloor("f-upper");
    expect(explicit.getState()).toMatchObject({
      wallMode: "contextual",
      wallModeExplicit: false,
      roofVisible: false,
      ceilingsVisible: false,
    });
    explicit.getState().setWallMode("closed");
    expect(explicit.getState()).toMatchObject({
      wallMode: "closed",
      wallModeExplicit: true,
      roofVisible: true,
      ceilingsVisible: true,
    });
  });

  it("clears a stale framed selection when returning to all floors", () => {
    const store = createHouseStore();
    store.getState().setSelection({ kind: "equipment", id: "equipment-upstairs" });
    store.getState().setFocusSelection({ kind: "equipment", id: "equipment-upstairs" });
    store.getState().isolateFloor(null);
    expect(store.getState()).toMatchObject({
      activeFloorId: null,
      selection: null,
      focusSelection: null,
      viewMode: "overview",
    });
  });
});

describe("viewer rendering defaults", () => {
  it("starts with occlusion and batched lighting enabled for a 64-light total budget", () => {
    const store = createHouseStore();
    expect(store.getState()).toMatchObject({
      equipmentOcclusion: true,
      detailedLightBatched: true,
      detailedLightLimit: 64,
      detailedLightHardwareMax: 12,
      detailedLightExperimental: false,
      detailedLightError: null,
    });
  });

  it("lets experimental limits exceed the recommendation and restores it when disabled", () => {
    const store = createHouseStore();
    store.getState().setDetailedLightBatched(false);
    store.getState().setDetailedLightExperimental(true);
    expect(store.getState().detailedLightLimit).toBe(12);
    store.getState().setDetailedLightLimit(48);
    expect(store.getState().detailedLightLimit).toBe(48);
    store.getState().setDetailedLightExperimental(false);
    expect(store.getState().detailedLightLimit).toBe(12);
    store.getState().setDetailedLightError("Rejected");
    store.getState().setDetailedLightLimit(10);
    expect(store.getState().detailedLightError).toBeNull();
  });

  it("restores the conservative single-pass state when batching is disabled", () => {
    const store = createHouseStore();
    store.getState().setDetailedLightBatched(false);
    store.getState().setDetailedLightExperimental(true);
    store.getState().setDetailedLightLimit(48);
    store.getState().setDetailedLightBatched(true);
    store.getState().setDetailedLightLimit(64);
    store.getState().setDetailedLightError("Rejected");

    store.getState().setDetailedLightBatched(false);

    expect(store.getState()).toMatchObject({
      detailedLightBatched: false,
      detailedLightLimit: 12,
      detailedLightExperimental: false,
      detailedLightError: null,
    });
  });

  it("rounds and clamps requested and hardware light counts", () => {
    const store = createHouseStore();
    store.getState().setDetailedLightLimit(8.6);
    store.getState().setDetailedLightHardwareMax(100);
    expect(store.getState()).toMatchObject({
      detailedLightLimit: 9,
      detailedLightHardwareMax: 64,
    });

    store.getState().setDetailedLightLimit(Number.NaN);
    store.getState().setDetailedLightHardwareMax(-4);
    expect(store.getState()).toMatchObject({
      detailedLightLimit: 0,
      detailedLightHardwareMax: 0,
    });
  });
});
