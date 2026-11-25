import type { Vector3 } from "three";

export function trackedIndexTip(
  frame: XRFrame,
  reference: XRReferenceSpace,
  input: XRInputSource,
  out: Vector3,
): Vector3 | null {
  const joint = input.hand?.get("index-finger-tip");
  if (!joint) return null;
  const pose = frame.getJointPose?.(joint, reference);
  if (!pose || pose.emulatedPosition) return null;
  const { x, y, z } = pose.transform.position;
  return [x, y, z].every(Number.isFinite) ? out.set(x, y, z) : null;
}

/** Arming a finger and reading that finger require separate inputs. */
export class HandConfirmation {
  aiming: XRInputSource | null = null;

  select(input: XRInputSource): XRInputSource | null {
    if (!this.aiming) {
      if (!input.hand) return input;
      this.aiming = input;
      return null;
    }
    if (input === this.aiming || input.handedness === this.aiming.handedness) return null;
    return this.aiming;
  }

  clear(): void { this.aiming = null; }
}
