import { Matrix4, Mesh, MeshBasicMaterial, Ray, SphereGeometry, Vector3 } from "three";
import { signedClearance } from "../model/geometry2d";
import type { Room, Vec3 } from "../model/types";
import type { RouteMeasurement } from "../modelFixTypes";
import type { MixedRealityRoutePick } from "./mixedOverlay";
import type { PanelPage } from "./panel";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { AlignmentRays } from "./roomAlignmentRay";
import { triangulateFeature } from "./roomAlignmentTriangulation";
import { SurveyAimInput } from "./surveyInput";

/** Keep a confirmed observation in model metres. Unconfirmed rays belong to one tracked session space. */
export class RouteFixMeasurement {
  readonly marker = new Mesh(new SphereGeometry(0.023, 12, 8), new MeshBasicMaterial({color: 0xffad48, depthTest: false}));
  measurement: RouteMeasurement | null = null;
  private readonly surface: SurveyAimInput;
  private readonly rays: AlignmentRays;
  private readonly matrix = new Matrix4();
  private readonly inverse = new Matrix4();
  private readonly ray = new Ray();
  private readonly outside = new Set<XRInputSource>();
  private first: Ray | null = null;
  private twoAims = false;
  private errorM: number | null = null;
  private message = "";
  constructor(private readonly session: XRSession, private readonly space: XRReferenceSpace,
    readonly room: Room, readonly route: MixedRealityRoutePick, readonly fingerprint: string) {
    this.surface = new SurveyAimInput(session, space);
    this.rays = new AlignmentRays(session, space);
    this.marker.name = "vh-measured-route-point";
    this.marker.renderOrder = 10;
    this.marker.visible = false;
  }

  frame(frame: XRFrame, matrix: Matrix4 | null, errorM: number | null) {
    if (!matrix || errorM === null || !(errorM >= 0 && errorM <= MAX_CALIBRATION_ERROR_M) ||
      this.session.visibilityState !== "visible" || frame.session !== this.session) { this.pause(); return; }
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition) { this.pause(); return; }
    this.errorM = errorM;
    this.matrix.copy(matrix);
    this.inverse.copy(matrix).invert();
    this.surface.frame(frame, !this.measurement && !this.twoAims && !this.first);
    this.marker.visible = this.measurement !== null;
    if (this.measurement) this.marker.position.fromArray(this.measurement.position).applyMatrix4(matrix);
  }

  preview(frame: XRFrame, input: XRInputSource, target: Vector3) {
    this.outside.delete(input);
    if (this.errorM === null || this.measurement || this.twoAims || this.first) return null;
    return this.surface.preview(frame, input, this.matrix, target, hit => {
      const p = target.copy(hit).applyMatrix4(this.inverse);
      if (this.inside(p)) return p.toArray();
      this.outside.add(input);
      return null;
    });
  }
  hide(input: XRInputSource) { this.surface.hide(input); this.outside.delete(input); }

  select(frame: XRFrame, input: XRInputSource) {
    if (frame.session !== this.session || this.session.visibilityState !== "visible") { this.pause(); return false; }
    if (this.errorM === null || this.measurement || input.targetRayMode !== "tracked-pointer" ||
      !this.rays.trackedRay(frame, input, this.ray)) return false;
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition) { this.pause(); return false; }
    let point: Vec3 | null = null;
    let method: RouteMeasurement["method"] = "tracked_surface";
    if (!this.twoAims && !this.first) point = this.surface.take(frame, input, this.matrix);
    if (!point) {
      method = "two_aims";
      this.ray.applyMatrix4(this.inverse);
      if (!this.first) {
        this.first = this.ray.clone();
        this.message = (this.outside.has(input) ? "Surface depth falls outside this room. " : "First aim marked. ") +
          "Move your hand sideways about 30 cm and click the same spot again.";
        return true;
      }
      const result = triangulateFeature(this.first, this.ray);
      if (!result.point) { this.message = result.message.replaceAll("corner", "spot"); return false; }
      if (!this.inside(result.point)) {
        this.first = null;
        this.message = "That point falls outside this room. Aim at the visible part again.";
        return false;
      }
      point = result.point.toArray();
    }
    this.first = null;
    this.measurement = { routeId: this.route.id, roomId: this.room.id, floorId: this.room.floorId, position: point,
      selectedSpan: [ [...this.route.segment[0]], [...this.route.segment[1]] ], method, registrationErrorM: this.errorM };
    this.marker.visible = true;
    this.marker.position.fromArray(point).applyMatrix4(this.matrix);
    return true;
  }

  private inside(p: Vector3) {
    // Model wall faces, slab elevation, or ceiling offset can themselves be the discrepancy.
    const marginM = 0.35;
    return Number.isFinite(p.y) && p.y >= this.room.floorElevation - marginM &&
      p.y <= this.room.floorElevation + (this.room.ceilingHeight ?? 2.7) + marginM &&
      signedClearance(p.x, p.z, this.room.footprint) >= -marginM;
  }
  menu(save: (measurement: RouteMeasurement) => void, close: () => void): PanelPage {
    const mark = this.measurement;
    const reset = () => { this.measurement = null; this.first = null; this.message = ""; this.marker.visible = false; this.surface.reset(); };
    return {
      title: mark ? "Review measured point" : "Measure real position",
      lines: [this.route.name, mark
        ? `Orange marks your point. Room alignment check ${(mark.registrationErrorM * 100).toFixed(1)} cm.`
        : this.message || (this.twoAims ? "Aim at the centre of the visible fitting and click once."
          : "Aim at the real fitting and click. An orange dot shows measured surface depth. Without a dot, use two aims.")],
      rows: [...(mark ? [
        {label: "Save measured fix", detail: "Add the point and overlay image to pending fixes", style: "primary" as const, act: () => save(mark)},
        {label: "Measure again", act: reset},
      ] : [{
        label: this.first ? "Restart aim" : this.twoAims ? "Use surface depth" : "Use two aims",
        detail: this.first ? "Start at the real fitting again" : this.twoAims ? "Use a tracked surface dot" : "Useful when the dot sits on the wrong surface",
        act: () => { if (!this.first) this.twoAims = !this.twoAims; reset(); },
      }]), {label: "Cancel measurement", act: close}],
    };
  }
  pause() {
    this.outside.clear();
    if (this.first) this.message = "Tracking changed. Aim at the fitting again to start a new pair.";
    this.first = null;
    this.surface.reset();
    this.errorM = null;
    this.marker.visible = false;
  }
  dispose() {
    this.pause();
    this.marker.geometry.dispose(); this.marker.material.dispose(); this.marker.removeFromParent();
  }
}
