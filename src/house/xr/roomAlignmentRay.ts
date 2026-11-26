import { Matrix4, Ray, Vector3 } from "three";
import { intersectAlignmentEvidence, type AlignmentEvidence } from "./roomAlignmentEvidence";

/** Optional native hit testing on each tracked input ray. Scanned geometry provides another source. */
export class AlignmentRays {
  private readonly sources = new Map<XRInputSource, { hit: XRHitTestSource | null }>();
  private readonly matrix = new Matrix4();
  private readonly ray = new Ray();

  constructor(private readonly session: XRSession, private readonly space: XRReferenceSpace) {}

  get available() { return [...this.sources.values()].some(({ hit }) => !!hit); }

  sync(inputs: readonly XRInputSource[]): void {
    for (const [input, source] of this.sources) {
      if (inputs.includes(input)) continue;
      this.cancel(source.hit);
      this.sources.delete(input);
    }
    if (!this.session.requestHitTestSource) return;
    for (const input of inputs) {
      if (input.targetRayMode !== "tracked-pointer" || this.sources.has(input)) continue;
      const source = { hit: null };
      this.sources.set(input, source);
      void this.subscribe(input, source);
    }
  }

  private async subscribe(input: XRInputSource, entry: { hit: XRHitTestSource | null }) {
    try {
      const hit = await this.session.requestHitTestSource?.({ space: input.targetRaySpace, entityTypes: ["plane", "mesh"] })
        ?.catch(() => this.session.requestHitTestSource?.({ space: input.targetRaySpace }));
      if (!hit) return;
      if (this.sources.get(input) === entry) entry.hit = hit;
      else this.cancel(hit);
    } catch { /* Optional capability denied or disconnected. */ }
  }

  hit(frame: XRFrame, input: XRInputSource, evidence: AlignmentEvidence | null, target: Vector3): Vector3 | null {
    if (!this.trackedRay(frame, input, this.ray)) return null;
    const source = this.sources.get(input)?.hit;
    if (source) {
      try {
        for (const hit of frame.getHitTestResults(source)) {
          const position = hit.getPose(this.space);
          if (!position || position.emulatedPosition) continue;
          const { x, y, z } = position.transform.position;
          if (![x, y, z].every(Number.isFinite)) continue;
          const d = target.set(x, y, z).distanceToSquared(this.ray.origin);
          if (d > 0.025 ** 2 && d < 9 ** 2) return target;
        }
      } catch { /* Try the scanned geometry if the provider currently cannot resolve the ray. */ }
    }
    return evidence ? intersectAlignmentEvidence(evidence, this.ray, target) : null;
  }

  trackedRay(frame: XRFrame, input: XRInputSource, target: Ray): Ray | null {
    if (frame.session !== this.session || this.session.visibilityState !== "visible") return null;
    const pose = frame.getPose(input.targetRaySpace, this.space);
    if (!pose || pose.emulatedPosition || !pose.transform.matrix.every(Number.isFinite)) return null;
    this.matrix.fromArray(pose.transform.matrix);
    target.origin.setFromMatrixPosition(this.matrix);
    target.direction.set(0, 0, -1).transformDirection(this.matrix);
    return target;
  }

  clear(): void {
    for (const source of this.sources.values()) this.cancel(source.hit);
    this.sources.clear();
  }

  private cancel(source: XRHitTestSource | null) {
    try { source?.cancel(); } catch { /* The session may already have ended. */ }
  }
}
