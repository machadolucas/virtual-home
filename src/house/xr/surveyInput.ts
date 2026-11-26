import { Ray, Vector3, type Matrix4 } from "three";
import type { Vec3 } from "@/house/model/types";
import { AlignmentRays } from "./roomAlignmentRay";
import { readAlignmentEvidence, type AlignmentEvidence } from "./roomAlignmentEvidence";

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

interface SurveyPreview {
  point: Vec3;
  shownAt: number;
}

const MAX_PREVIEW_AGE_MS = 140;
const MAX_AIM_MOVEMENT_M = 0.05;

/** Retain only the latest rendered point per tracked source so the gesture confirms that exact point. */
export class SurveyAimInput {
  private readonly rays: AlignmentRays;
  private readonly previews = new Map<XRInputSource, SurveyPreview>();
  private readonly ray = new Ray();
  private readonly viewer = new Vector3();
  private readonly point = new Vector3();
  private evidence: AlignmentEvidence | null = null;
  private nextScan = -Infinity;
  private nextPresenceCheck = -Infinity;
  private hasScene = false;
  private enabled = false;

  constructor(private readonly session: XRSession, private readonly space: XRReferenceSpace) {
    this.rays = new AlignmentRays(session, space);
  }

  get available(): boolean {
    if (this.hasScene) return true;
    const features = this.session.enabledFeatures;
    if (features) return features.some((value) =>
      value === "hit-test" || value === "plane-detection" || value === "mesh-detection");
    return typeof this.session.requestHitTestSource === "function";
  }

  frame(frame: XRFrame, enabled: boolean): void {
    const now = performance.now();
    if (now >= this.nextPresenceCheck) {
      this.hasScene = this.sceneAvailable(frame);
      this.nextPresenceCheck = now + 500;
    }
    if (!enabled) {
      if (this.enabled) this.reset();
      return;
    }
    this.enabled = true;
    const inputs = Array.from(this.session.inputSources ?? []);
    this.rays.sync(inputs);
    for (const source of this.previews.keys()) if (!inputs.includes(source)) this.previews.delete(source);
    if (!this.hasScene) {
      this.evidence = null;
      this.nextScan = -Infinity;
      return;
    }
    if (now < this.nextScan) return;
    this.nextScan = now + 500;
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition) { this.evidence = null; return; }
    const { x, y, z } = viewer.transform.position;
    this.evidence = readAlignmentEvidence(frame, this.space, this.viewer.set(x, y, z));
  }

  preview(frame: XRFrame, source: XRInputSource, trackingFromModel: Matrix4, target: Vector3,
    toModel: (point: Vector3) => Vec3 | null): Vector3 | null {
    this.previews.delete(source);
    if (!this.enabled) return null;
    const hit = this.rays.hit(frame, source, this.evidence, this.point);
    const point = hit && toModel(hit);
    if (!point) return null;
    this.previews.set(source, { point, shownAt: performance.now() });
    return target.fromArray(point).applyMatrix4(trackingFromModel);
  }

  take(frame: XRFrame, source: XRInputSource, trackingFromModel: Matrix4): Vec3 | null {
    const preview = this.previews.get(source);
    this.previews.delete(source);
    if (!this.enabled || !preview || performance.now() - preview.shownAt > MAX_PREVIEW_AGE_MS ||
      !this.rays.trackedRay(frame, source, this.ray)) return null;
    const point = this.point.fromArray(preview.point).applyMatrix4(trackingFromModel);
    if (this.ray.distanceSqToPoint(point) > MAX_AIM_MOVEMENT_M ** 2 ||
      this.ray.direction.dot(point.sub(this.ray.origin)) <= 0.025) return null;
    this.previews.clear();
    return preview.point;
  }

  hide(source: XRInputSource): void { this.previews.delete(source); }

  reset(): void {
    this.previews.clear();
    this.rays.clear();
    this.evidence = null;
    this.nextScan = -Infinity;
    this.enabled = false;
  }

  private sceneAvailable(frame: XRFrame): boolean {
    try { if (frame.detectedPlanes?.size) return true; } catch { /* Optional feature. */ }
    try { return !!frame.detectedMeshes?.size; } catch { return false; }
  }
}
