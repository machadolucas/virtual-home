import CameraControlsImpl from "camera-controls";
import { describe, expect, it } from "vitest";
import { controlBindings } from "@/house/components/Rig";

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
