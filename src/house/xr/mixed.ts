import { Matrix4, Vector3 } from "three";
import type { Vec3 } from "@/house/model/types";
import {
  calibrationError,
  fitCalibration,
  independentCheck,
  MAX_CALIBRATION_ERROR_M,
  type CalibrationFeature,
  type CalibrationFit,
  type CalibrationPair,
} from "./mixedCalibration";

export { calibrationFeatures, type CalibrationFeature } from "./mixedCalibration";

/** The displayed probe lies this far forward along the controller's tracked grip. */
export const MIXED_REALITY_PROBE_OFFSET: Readonly<Vec3> = [0, 0, -0.08];

export interface MixedRealityState {
  phase: "select" | "restoring" | "verify" | "ready" | "tracking-lost";
  sampleCount: number;
  selected: CalibrationFeature | null;
  message: string;
  persistence: "session" | "saved";
  errorM: number | null;
}

interface SavedAlignment {
  handle: string;
  modelOrigin: Vec3;
  check: CalibrationFeature;
}

interface MixedRealityCalibrationOptions {
  session: XRSession;
  referenceSpace: XRReferenceSpace;
  userId: string;
  fingerprint: string;
  floorId: string;
  roomId?: string;
  onState: (state: MixedRealityState) => void;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  probeOffset?: Readonly<Vec3>;
}

const INITIAL_STATE: MixedRealityState = {
  phase: "select",
  sampleCount: 0,
  selected: null,
  message: "Choose the first model corner, touch its physical location with the controller probe, then press the trigger.",
  persistence: "session",
  errorM: null,
};

const isPoint = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((n: unknown) => typeof n === "number" && Number.isFinite(n));

function readAlignment(raw: string | null | undefined): SavedAlignment | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as Partial<SavedAlignment> | null;
  if (typeof value?.handle !== "string" || !value.handle || !isPoint(value.modelOrigin) ||
    typeof value.check?.id !== "string" || typeof value.check.label !== "string" ||
    !isPoint(value.check.point)) return null;
  return { handle: value.handle, modelOrigin: value.modelOrigin, check: value.check };
}

export class MixedRealityCalibration {
  private current = INITIAL_STATE;
  private readonly key: string;
  private readonly storage: MixedRealityCalibrationOptions["storage"];
  private readonly probeOffset: Readonly<Vec3>;
  private pairs: CalibrationPair[] = [];
  private fit: CalibrationFit | null = null;
  private check: CalibrationFeature | null = null;
  private anchor: XRAnchor | null = null;
  private saved: SavedAlignment | null = null;
  private haveViewer = false;
  private createPending = false;
  private generation = 0;
  private disposed = false;
  private readonly anchorMatrix = new Matrix4();
  private readonly anchorOffset = new Matrix4();
  private readonly gripMatrix = new Matrix4();

  constructor(private readonly options: MixedRealityCalibrationOptions) {
    this.key = `vh:mr-anchor:v1:${JSON.stringify([options.userId, options.fingerprint, options.floorId])}`;
    this.probeOffset = options.probeOffset ?? MIXED_REALITY_PROBE_OFFSET;
    try {
      const storage = options.storage ?? window.localStorage;
      const raw = storage.getItem(this.key);
      this.storage = storage;
      this.saved = readAlignment(raw);
    } catch {
      // Storage can be disabled in private browsing or by the embedded browser.
    }
    options.referenceSpace.addEventListener("reset", this.referenceReset);
    options.session.addEventListener("visibilitychange", this.visibilityChanged);
    if (this.saved && options.session.restorePersistentAnchor) {
      this.current = { ...INITIAL_STATE, phase: "restoring", message: "Looking for the saved room anchor. Look around the room, or reset to align manually." };
      void this.restore(this.saved);
    }
  }

  get state(): MixedRealityState {
    return this.current;
  }
  get tracking(): boolean { return this.haveViewer; }

  /** A same-floor anchor can be out of range in a different room. A checked local scan can replace it. */
  get awaitingForeignAnchor(): boolean {
    return this.current.phase === "restoring" && !!this.options.roomId &&
      this.saved?.check.roomId !== this.options.roomId;
  }

  /** Adopt a rigid fit independently verified against the room scan. */
  acceptScanned(frame: XRFrame, fit: CalibrationFit, check: CalibrationFeature, errorM: number): boolean {
    if (!this.canUseScan(frame, errorM) || !this.isLocalFeature(check) ||
      (!this.awaitingForeignAnchor && this.current.phase !== "select") ||
      this.pairs.length > 0 || this.current.selected) return false;
    if (this.awaitingForeignAnchor) this.clear();
    this.fit = fit;
    this.check = check;
    this.createPending = true;
    this.update({
      phase: "ready", sampleCount: 3, errorM, selected: null, persistence: "session",
      message: "Alignment checked against independent room geometry.",
    });
    return true;
  }

  /** Rechecking an anchor requires agreement across independent points in the selected room. */
  verifyScanned(
    frame: XRFrame, fit: CalibrationFit, errorM: number, features: CalibrationFeature[], check?: CalibrationFeature,
  ): boolean {
    if (!this.canUseScan(frame, errorM) || this.current.phase !== "verify" || !this.check ||
      features.length < 3 || features.some((feature) => !this.isLocalFeature(feature))) return false;
    const matrix = this.anchor ? this.trackedMatrix(frame, false) : this.fit?.matrix;
    if (!matrix) return false;
    const p = new Vector3(), q = new Vector3();
    let drift = 0;
    for (const { point } of features) {
      drift = Math.max(drift, p.fromArray(point).applyMatrix4(matrix)
        .distanceTo(q.fromArray(point).applyMatrix4(fit.matrix)));
    }
    // Both the scan's residual and disagreement with it contribute to the verification bound.
    const disagreement = errorM + drift;
    if (!Number.isFinite(disagreement) || disagreement > MAX_CALIBRATION_ERROR_M) return false;
    if (check && features.some(({ id }) => id === check.id) && this.isLocalFeature(check)) this.check = check;
    this.update({ phase: "ready", errorM: disagreement, selected: null, message: "Alignment rechecked against room geometry." });
    return true;
  }

  private canUseScan(frame: XRFrame, errorM: number): boolean {
    return !this.disposed && frame.session === this.options.session && this.haveViewer &&
      this.options.session.visibilityState === "visible" && Number.isFinite(errorM) &&
      errorM >= 0 && errorM <= MAX_CALIBRATION_ERROR_M;
  }

  /** Called from an active animation frame. A null result always hides mapped geometry. */
  frame(frame: XRFrame): Matrix4 | null {
    if (this.disposed || frame.session !== this.options.session) return null;
    const viewer = frame.getViewerPose(this.options.referenceSpace);
    this.haveViewer = !!viewer && !viewer.emulatedPosition && this.options.session.visibilityState === "visible";
    if (!this.haveViewer) {
      this.loseTracking();
      return null;
    }
    const currentMatrix = this.anchor ? this.trackedMatrix(frame, true) : this.fit?.matrix ?? null;
    if (this.anchor && !currentMatrix) {
      this.loseTracking();
      return null;
    }
    if (this.current.phase === "tracking-lost" || (this.current.phase === "restoring" && this.anchor)) {
      this.requestCheck();
    }
    if (this.current.phase !== "ready") return null;
    if (this.createPending) {
      this.createPending = false;
      void this.createAnchor(frame);
    }
    return currentMatrix;
  }

  select(feature: CalibrationFeature): void {
    if (this.current.phase !== "select" || !this.isLocalFeature(feature) ||
      this.pairs.some((pair) => pair.feature.id === feature.id)) return;
    this.update({ selected: feature, message: `Touch ${feature.label} with the controller probe, then press the trigger.`, errorM: null });
  }

  /** Use the same point for the visible probe and for a physical touch sample. */
  pointerPosition(frame: XRFrame, gripSpace: XRSpace | undefined | null, target: Vector3): Vector3 | null {
    if (!gripSpace || frame.session !== this.options.session) return null;
    const pose = frame.getPose(gripSpace, this.options.referenceSpace);
    if (!pose || pose.emulatedPosition) return null;
    return target.fromArray(this.probeOffset).applyMatrix4(this.gripMatrix.fromArray(pose.transform.matrix));
  }

  /** Call with the active select-event frame to sample exactly when the physical trigger fires. */
  capture(frame: XRFrame, gripSpace: XRSpace | undefined | null): void {
    this.capturePosition(frame, this.pointerPosition(frame, gripSpace, new Vector3()));
  }

  /** A separately confirmed hand joint and a controller probe share the same fit and checks. */
  capturePosition(frame: XRFrame, position: Vector3 | null): void {
    const { phase, selected } = this.current;
    if (this.disposed || frame.session !== this.options.session || !selected || (phase !== "select" && phase !== "verify")) return;
    const tracking = this.haveViewer && this.options.session.visibilityState === "visible";
    const touch = tracking && position && isPoint(position.toArray()) ? position : null;
    if (!touch) {
      this.update({ message: "The tracked point is unavailable. Bring your hand or controller into tracking view." });
      return;
    }
    const pair = { feature: selected, observed: touch.toArray() };
    if (phase === "verify") {
      // Input-event frames expose XRPose, even when the anchor set only updates on render frames.
      const matrix = this.anchor ? this.trackedMatrix(frame, false) : this.fit?.matrix;
      if (!matrix) {
        this.loseTracking();
        return;
      }
      if (this.checkPoint(matrix, pair)) {
        this.update({ phase: "ready", message: "Alignment checked. The overlay shows approximate documented paths." });
      }
      return;
    }

    const [first, second] = this.pairs;
    if (!first) {
      this.pairs.push(pair);
      this.update({ selected: null, sampleCount: 1, message: "Choose a second floor feature at least 1.5 m from the first." });
      return;
    }
    if (!second) {
      const result = fitCalibration(first, pair);
      if (!result.fit) {
        this.update({ message: result.message });
        return;
      }
      this.fit = result.fit;
      this.pairs.push(pair);
      this.update({ selected: null, sampleCount: 2, message: "Choose a third feature away from the line between the first two touches." });
      return;
    }
    if (!this.fit || !independentCheck(first, second, pair)) {
      this.update({ message: "Choose a third feature at least 30 cm to the side of the line between the first two." });
      return;
    }
    if (!this.checkPoint(this.fit.matrix, pair)) return;
    this.check = selected;
    this.createPending = true;
    this.update({ phase: "ready", sampleCount: 3, message: "Alignment checked. The overlay shows approximate documented paths." });
  }

  reset(): void {
    if (this.disposed) return;
    const handle = this.saved?.handle;
    this.clear();
    this.saved = null;
    try {
      this.storage?.removeItem(this.key);
    } catch { /* Manual calibration still works when storage is unavailable. */ }
    if (handle) void this.deletePersistent(handle);
    this.update(INITIAL_STATE);
  }

  /** Begin a full local registration while keeping the saved handle available for later sessions. */
  startManualHere(): void {
    if (this.disposed) return;
    this.clear();
    this.update(INITIAL_STATE);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.referenceSpace.removeEventListener("reset", this.referenceReset);
    this.options.session.removeEventListener("visibilitychange", this.visibilityChanged);
    this.clear();
  }

  private clear(): void {
    this.generation++;
    this.pairs = [];
    this.fit = null;
    this.check = null;
    this.createPending = false;
    this.releaseAnchor(this.anchor);
    this.anchor = null;
  }

  private checkPoint(matrix: Matrix4, pair: CalibrationPair): boolean {
    const errorM = calibrationError(matrix, pair);
    if (!Number.isFinite(errorM)) {
      this.update({ errorM: null, message: "The tracked point is invalid. Try the same feature again." });
      return false;
    }
    if (errorM > MAX_CALIBRATION_ERROR_M) {
      this.update({ errorM, message: `The check missed by ${Math.round(errorM * 100)} cm. Touch the same feature again or reset the alignment.` });
      return false;
    }
    this.update({ errorM });
    return true;
  }

  private trackedMatrix(frame: XRFrame, checkTracked: boolean): Matrix4 | null {
    if (!this.anchor || (checkTracked && frame.trackedAnchors && !frame.trackedAnchors.has(this.anchor))) return null;
    const pose = frame.getPose(this.anchor.anchorSpace, this.options.referenceSpace);
    const origin = this.fit?.modelOrigin ?? this.saved?.modelOrigin;
    if (!pose || pose.emulatedPosition || !origin) return null;
    const m = pose.transform.matrix;
    // Keep the calibration leveled to gravity. XR anchors can introduce small pitch/roll corrections.
    return this.anchorMatrix.makeRotationY(Math.atan2(m[8]!, m[10]!))
      .setPosition(m[12]!, m[13]!, m[14]!)
      .multiply(this.anchorOffset.makeTranslation(-origin[0], -origin[1], -origin[2]));
  }

  private async restore(saved: SavedAlignment): Promise<void> {
    const generation = this.generation;
    let anchor: XRAnchor | undefined;
    try {
      anchor = await this.options.session.restorePersistentAnchor?.(saved.handle);
    } catch {
      // A browser can reject expired or removed anchors.
    }
    if (generation !== this.generation) {
      if (anchor) this.releaseAnchor(anchor);
      return;
    }
    if (!anchor) {
      this.update({ phase: "select", message: "The saved anchor is unavailable. Align manually using three floor features." });
      return;
    }
    this.anchor = anchor;
    this.check = saved.check;
    this.update({ persistence: "saved", sampleCount: 3 });
  }

  private async createAnchor(frame: XRFrame): Promise<void> {
    const { fit, check, storage } = this;
    if (!fit || !check || !frame.createAnchor) return;
    const generation = this.generation;
    try {
      const [x, y, z] = fit.anchorPosition;
      const pose = new XRRigidTransform({ x, y, z }, { y: Math.sin(fit.yaw / 2), w: Math.cos(fit.yaw / 2) });
      const anchor = await frame.createAnchor(pose, this.options.referenceSpace);
      if (generation !== this.generation) {
        this.releaseAnchor(anchor);
        return;
      }
      this.anchor = anchor;
      const { session } = this.options;
      // Only allocate a persistent handle if we have the means to restore and retire it.
      if (!storage || !anchor.requestPersistentHandle || !session.restorePersistentAnchor ||
        !session.deletePersistentAnchor) return;
      const handle = await anchor.requestPersistentHandle();
      if (generation !== this.generation) {
        await this.deletePersistent(handle);
        return;
      }
      const saved = { handle, check, modelOrigin: fit.modelOrigin };
      try {
        storage.setItem(this.key, JSON.stringify(saved));
      } catch {
        // The handle cannot be recovered. Retire it and keep the manually verified fit.
        // Deleting a persistent handle deletes its live anchor too.
        this.anchor = null;
        await this.deletePersistent(handle);
        this.releaseAnchor(anchor);
        return;
      }
      const previous = this.saved?.handle;
      this.saved = saved;
      if (previous && previous !== handle) void this.deletePersistent(previous);
      this.update({ persistence: "saved" });
    } catch {
      // Browser anchors are optional. The verified session transform remains available.
    }
  }

  private async deletePersistent(handle: string): Promise<void> {
    try {
      await this.options.session.deletePersistentAnchor?.(handle);
    } catch { /* The browser may already have removed the anchor. */ }
  }

  private releaseAnchor(anchor: XRAnchor | null): void {
    try {
      anchor?.delete();
    } catch { /* The session may have ended. */ }
  }

  private requestCheck(): void {
    if (!this.check) return;
    const local = this.isLocalFeature(this.check);
    this.update({
      phase: "verify",
      selected: local ? this.check : null,
      message: local ? `Touch ${this.check.label} with the controller probe to check the alignment.`
        : "Checking the saved alignment against this room. You can also align manually here.",
      errorM: null,
    });
  }

  private isLocalFeature(feature: CalibrationFeature): boolean {
    return !this.options.roomId || feature.roomId === this.options.roomId;
  }

  private loseTracking(): void {
    if (this.current.phase === "select" && this.pairs.length > 0) {
      this.clear();
      this.update({ ...INITIAL_STATE, message: "Tracking was interrupted during alignment. Start again with the first touch." });
      return;
    }
    if (this.current.phase !== "ready" && this.current.phase !== "verify") return;
    this.update({ phase: "tracking-lost", message: "Tracking lost. Routes are hidden until tracking returns and you recheck the alignment." });
  }

  private referenceReset = (): void => {
    this.haveViewer = false;
    if (this.anchor && this.check) {
      this.loseTracking();
      return;
    }
    this.clear();
    this.update({ ...INITIAL_STATE, message: "The headset reset its tracking origin. Align again using three floor features." });
  };

  private visibilityChanged = (): void => {
    if (this.options.session.visibilityState === "visible") return;
    this.haveViewer = false;
    this.loseTracking();
  };

  private update(changes: Partial<MixedRealityState>): void {
    this.current = { ...this.current, ...changes };
    this.options.onState(this.current);
  }
}
