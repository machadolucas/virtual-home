import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room } from "../model/types";
import { MixedRealityCalibration, calibrationFeatures, type CalibrationFeature } from "./mixed";
import { buildMixedRealityOverlay, type MixedRealityRouteFilter, type MixedRealityRoutePick } from "./mixedOverlay";
import type { PanelPage } from "./panel";
import { RoomSurveyPilot } from "./roomSurvey";
import { HandConfirmation, trackedIndexTip } from "./surveyInput";

export class MixedPilot {
  readonly scene = new THREE.Scene();
  readonly rooms: Room[];
  room: Room | null = null;
  calibration: MixedRealityCalibration | null = null;
  readyTransform: THREE.Matrix4 | null = null;
  overlay: ReturnType<typeof buildMixedRealityOverlay> | null = null;
  filter: MixedRealityRouteFilter = "both";
  selectedRoute: MixedRealityRoutePick | null = null;
  private choosingRoom = true;
  private features = new Map<string, CalibrationFeature[]>();
  private survey: RoomSurveyPilot | null = null;
  private readonly hand = new HandConfirmation();
  private readonly samplePoint = new THREE.Vector3();

  constructor(private runtime: HouseRuntime, private session: XRSession, private space: XRReferenceSpace,
    private mode: "mr" | "survey" = "mr") {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8896a3, 2));
    this.rooms = [...runtime.manifest!.rooms.values()].filter(r => r.kind !== "void" && r.kind !== "attic");
    const laundry = (r: Room) => [r.name, ...(r.aliases ?? []), runtime.store.getState().labelPreferences.names[r.id]]
      .some(n => n?.toLowerCase().includes("laundry"));
    this.rooms.sort((a, b) => Number(laundry(b)) - Number(laundry(a)) || a.name.localeCompare(b.name));
  }
  private enter(room: Room) {
    this.clearRoom();
    this.room = room; this.choosingRoom = false; this.filter = "both"; this.selectedRoute = null;
    const state = this.runtime.store.getState();
    if (this.mode === "survey") {
      this.survey = new RoomSurveyPilot(this.runtime, this.session, this.space, room);
      this.scene.add(this.survey.display.group);
    } else {
      this.overlay = buildMixedRealityOverlay(this.runtime.manifest!, state.routes, room.floorId);
      this.scene.add(this.overlay.group);
    }
    this.calibration = new MixedRealityCalibration({ session: this.session, referenceSpace: this.space,
      userId: this.runtime.userId!, floorId: room.floorId, fingerprint: state.fingerprint!,
      onState: s => {
        if (s.phase === "ready") return;
        this.readyTransform = null;
        this.overlay?.applyTransform(null);
        this.survey?.pause();
      } });
  }
  private roomFeatures(room: Room): CalibrationFeature[] {
    let features = this.features.get(room.id);
    if (!features) {
      features = calibrationFeatures(this.runtime.manifest!.manifest, room.floorId, room.id);
      this.features.set(room.id, features);
    }
    return features;
  }
  menu(fans: string, capture: () => void): PanelPage {
    const model = this.runtime.manifest!;
    if (this.choosingRoom || !this.room || !this.calibration) {
      return { title: this.mode === "survey" ? "Choose a room to survey" : "Choose a calibration room",
        lines: ["Stand in the real room and select its model counterpart."],
        rows: this.rooms.map(room => ({ label: `${room.name} · ${model.floors.get(room.floorId)?.name ?? room.floorId}`, act: () => this.enter(room) })) };
    }
    const room = this.room, cal = this.calibration, state = cal.state;
    const checkRoom = state.phase === "verify" && state.selected?.roomId ? model.rooms.get(state.selected.roomId) : undefined;
    const featureRoom = checkRoom ?? room;
    const features = this.roomFeatures(featureRoom);
    const error = state.errorM === null ? "" : `Third point: ${(100 * state.errorM).toFixed(1)} cm`;
    const reset = { label: "Realign from the first point", act: () => { this.selectedRoute = null; this.hand.clear(); cal.reset(); } };
    const change = { label: "Choose another room", act: () => {
      this.clearRoom();
      this.room = null; this.choosingRoom = true; this.selectedRoute = null;
    } };
    const handNotice = this.hand.aiming
      ? `Aim with your ${this.hand.aiming.handedness} index finger. Confirm with the other hand or controller.`
      : "Hands: pinch once with the measuring hand, then use the opposite hand to confirm.";
    const handsAvailable = this.mode === "survey" || this.session.enabledFeatures?.includes("hand-tracking") ||
      Array.from(this.session.inputSources).some((input) => !!input.hand);
    if (state.phase !== "ready") {
      return { title: `Align · ${featureRoom.name}`,
        lines: [this.hand.aiming ? handNotice : "", error, state.message,
          handsAvailable && !this.hand.aiming ? handNotice : ""].filter(Boolean),
        corners: features.map(f => f.point),
        rows: [...(state.phase === "select" ? features.map(f => ({
          label: `${state.selected?.id === f.id ? "Selected · " : ""}${f.planLabel ?? f.label}`, act: () => cal.select(f),
        })) : []), reset, change] };
    }
    if (this.survey) {
      const menu = this.survey.menu();
      if (this.survey.sampling || this.hand.aiming) menu.lines.unshift(handNotice);
      menu.rows.push(reset, change);
      return menu;
    }
    return { title: room.name, lines: [error + (state.persistence === "saved" ? " · Anchor saved" : " · Session alignment"),
      fans, this.selectedRoute?.label ?? "Dashed paths: approximate concealed route."],
      rows: [...(["pipes", "ducts", "both"] as const).map(filter => ({ label: (filter === this.filter ? "✓ " : "") + filter[0]!.toUpperCase() + filter.slice(1),
        act: () => { this.filter = filter; this.selectedRoute = null; this.overlay?.setFilter(filter); } })),
        { label: "Capture model fix · overlay only", act: capture }, reset, change] };
  }
  frame(frame: XRFrame, delta: number, motion: boolean, fanRates: { supply: number; extract: number }) {
    if (!this.calibration) return;
    if (this.hand.aiming && !Array.from(this.session.inputSources).includes(this.hand.aiming)) this.hand.clear();
    const matrix = this.calibration.frame(frame);
    this.readyTransform = matrix;
    this.survey?.frame(frame, matrix, this.calibration.state.errorM);
    this.overlay?.applyTransform(matrix);
    if (!matrix || !this.overlay) return;
    this.overlay.setRoutes(this.runtime.store.getState().routes);
    this.overlay.tick(delta, motion, fanRates);
  }
  probePosition(frame: XRFrame, source: XRInputSource, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.calibration) return null;
    return source.hand ? trackedIndexTip(frame, this.space, source, target)
      : this.calibration.pointerPosition(frame, source.gripSpace, target);
  }
  select(frame: XRFrame, source: XRInputSource, ray: THREE.Ray | null) {
    const calibration = this.calibration;
    if (!calibration) return;
    const { phase, selected } = calibration.state;
    if (phase === "ready" && this.overlay) {
      this.selectedRoute = ray ? this.overlay.pick(ray) : null;
      return;
    }
    if (!(phase === "ready" ? this.survey?.sampling : selected)) return;
    if (this.survey?.samplingWithHit && phase === "ready") {
      this.survey.capture(null);
      return;
    }
    const input = this.hand.select(source);
    if (!input) return;
    const position = this.probePosition(frame, input, this.samplePoint);
    if (phase === "ready") this.survey?.capture(position);
    else calibration.capturePosition(frame, position);
  }
  home(): void {
    this.selectedRoute = null;
    this.survey?.home();
  }
  private clearRoom() {
    this.calibration?.dispose(); this.calibration = null;
    this.overlay?.dispose(); this.overlay = null;
    this.survey?.dispose(); this.survey = null;
    this.readyTransform = null;
    this.hand.clear();
  }
  dispose() { this.clearRoom(); this.scene.clear(); }
}
