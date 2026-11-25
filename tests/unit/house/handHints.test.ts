import { Group, InstancedMesh, Matrix4, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { HandHints } from "@/house/xr/handHints";

const reference = {} as XRReferenceSpace;
const wrist = {} as XRJointSpace;
const thumb = {} as XRJointSpace;
const finger = {} as XRJointSpace;
const gripSpace = {} as XRSpace;
const hand = { handedness: "left", hand: new Map([
  ["wrist", wrist], ["thumb-metacarpal", thumb], ["index-finger-metacarpal", finger],
]) } as unknown as XRInputSource;
const controller = { handedness: "left", gripSpace } as XRInputSource;
const pose = (x: number, y: number, z: number, emulatedPosition = false) => ({
  emulatedPosition,
  transform: { position: { x, y, z }, matrix: new Matrix4().makeTranslation(x, y, z).toArray() },
});
const frame = (opts: { visible?: boolean; wristTracked?: boolean; gripTracked?: boolean } = {}) => ({
  session: { visibilityState: opts.visible === false ? "hidden" : "visible" },
  getJointPose: (joint: XRJointSpace) => {
    if (joint === wrist) return opts.wristTracked === false ? undefined : pose(0, 1, 0);
    return joint === thumb ? pose(0.04, 1, 0) : pose(0, 1.06, 0);
  },
  getPose: (space: XRSpace) => space === gripSpace ? pose(0.1, 1.2, -0.3, opts.gripTracked === false) : undefined,
}) as unknown as XRFrame;

it("batches tracked bones in local-floor and clears the hand when its wrist is lost", () => {
  const hints = new HandHints();
  const skeleton = hints.group.getObjectByName("vh-left-hand-skeleton") as InstancedMesh;
  const grip = hints.group.getObjectByName("vh-left-controller-grip")!;
  hints.update(frame(), reference, [hand]);
  expect(skeleton.visible).toBe(true);
  expect(skeleton.count).toBe(2);
  expect(grip.visible).toBe(false);
  const matrix = new Matrix4();
  skeleton.getMatrixAt(0, matrix);
  const midpoint = new Vector3().setFromMatrixPosition(matrix);
  expect(midpoint.x).toBeCloseTo(0.02);
  expect(midpoint.y).toBeCloseTo(1);
  hints.update(frame({ wristTracked: false }), reference, [hand]);
  expect(skeleton.visible).toBe(false);
  expect(skeleton.count).toBe(0);
  hints.dispose();
});

it("shows the controller grip after switching sources and clears it when its pose is hidden or emulated", () => {
  const hints = new HandHints();
  const skeleton = hints.group.getObjectByName("vh-left-hand-skeleton")!;
  const grip = hints.group.getObjectByName("vh-left-controller-grip")!;
  hints.update(frame(), reference, [hand]);
  hints.update(frame(), reference, [controller]);
  expect(skeleton.visible).toBe(false);
  expect(grip.visible).toBe(true);
  expect(new Vector3().setFromMatrixPosition(grip.matrix).toArray()).toEqual([0.1, 1.2, -0.3]);
  hints.update(frame({ gripTracked: false }), reference, [controller]);
  expect(grip.visible).toBe(false);
  hints.update(frame({ visible: false }), reference, [hand]);
  expect(skeleton.visible).toBe(false);
  hints.dispose();
});

it("detaches and releases the batched geometry at exit", () => {
  const parent = new Group();
  const hints = new HandHints();
  parent.add(hints.group);
  const skeleton = hints.group.getObjectByName("vh-left-hand-skeleton") as InstancedMesh;
  const geometryDispose = vi.spyOn(skeleton.geometry, "dispose");
  const instanceDispose = vi.spyOn(skeleton, "dispose");
  hints.dispose();
  hints.dispose();
  expect(parent.children).toHaveLength(0);
  expect(instanceDispose).toHaveBeenCalledOnce();
  expect(geometryDispose).toHaveBeenCalledOnce();
});
