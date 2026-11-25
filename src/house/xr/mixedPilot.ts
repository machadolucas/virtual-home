import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room } from "../model/types";
import { MixedRealityCalibration, calibrationFeatures, type CalibrationFeature } from "./mixed";
import { buildMixedRealityOverlay, type MixedRealityRouteFilter, type MixedRealityRoutePick } from "./mixedOverlay";
import type { PanelPage } from "./panel";

export class MixedPilot {
  readonly scene = new THREE.Scene();
  readonly rooms: Room[];
  room: Room | null = null;
  calibration: MixedRealityCalibration | null = null;
  overlay: ReturnType<typeof buildMixedRealityOverlay> | null = null;
  filter: MixedRealityRouteFilter = "both";
  selectedRoute: MixedRealityRoutePick | null = null;
  private choosingRoom = true;
  private features = new Map<string, CalibrationFeature[]>();

  constructor(private runtime: HouseRuntime, private session: XRSession, private space: XRReferenceSpace) {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8896a3, 2));
    this.rooms = [...runtime.manifest!.rooms.values()].filter(r => r.kind !== "void" && r.kind !== "attic");
    const laundry = (r: Room) => [r.name, ...(r.aliases ?? []), runtime.store.getState().labelPreferences.names[r.id]]
      .some(n => n?.toLowerCase().includes("laundry"));
    this.rooms.sort((a, b) => Number(laundry(b)) - Number(laundry(a)) || a.name.localeCompare(b.name));
  }
  private enter(room: Room) {
    this.calibration?.dispose(); this.overlay?.dispose();
    this.room = room; this.choosingRoom = false; this.filter = "both"; this.selectedRoute = null;
    const state = this.runtime.store.getState();
    this.overlay = buildMixedRealityOverlay(this.runtime.manifest!, state.routes, room.floorId);
    this.scene.add(this.overlay.group);
    this.calibration = new MixedRealityCalibration({ session: this.session, referenceSpace: this.space,
      userId: this.runtime.userId!, floorId: room.floorId, fingerprint: state.fingerprint!,
      onState: s => { if (this.overlay && s.phase !== "ready") this.overlay.group.visible = false; } });
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
      return { title: "Choose a calibration room", lines: ["Stand in the real room and select its model counterpart."],
        rows: this.rooms.map(room => ({ label: `${room.name} · ${model.floors.get(room.floorId)?.name ?? room.floorId}`, act: () => this.enter(room) })) };
    }
    const room = this.room, cal = this.calibration, state = cal.state;
    const checkRoom = state.phase === "verify" && state.selected?.roomId ? model.rooms.get(state.selected.roomId) : undefined;
    const featureRoom = checkRoom ?? room;
    const features = this.roomFeatures(featureRoom);
    const error = state.errorM === null ? "" : `Third point: ${(100 * state.errorM).toFixed(1)} cm`;
    const reset = { label: "Realign from the first point", act: () => { this.selectedRoute = null; cal.reset(); } };
    const change = { label: "Choose another room", act: () => {
      this.calibration?.dispose(); this.calibration = null; this.overlay?.dispose(); this.overlay = null;
      this.room = null; this.choosingRoom = true; this.selectedRoute = null;
    } };
    if (state.phase !== "ready") {
      return { title: `Align · ${featureRoom.name}`, lines: [error, state.message].filter(Boolean), corners: features.map(f => f.point),
        rows: [...(state.phase === "select" ? features.map(f => ({
          label: `${state.selected?.id === f.id ? "Selected · " : ""}${f.planLabel ?? f.label}`, act: () => cal.select(f),
        })) : []), reset, change] };
    }
    return { title: room.name, lines: [error + (state.persistence === "saved" ? " · Anchor saved" : " · Session alignment"),
      fans, this.selectedRoute?.label ?? "Dashed paths: approximate concealed route."],
      rows: [...(["pipes", "ducts", "both"] as const).map(filter => ({ label: (filter === this.filter ? "✓ " : "") + filter[0]!.toUpperCase() + filter.slice(1),
        act: () => { this.filter = filter; this.selectedRoute = null; this.overlay?.setFilter(filter); } })),
        { label: "Capture model fix · overlay only", act: capture }, reset, change] };
  }
  frame(frame: XRFrame, delta: number, motion: boolean, fanRates: { supply: number; extract: number }) {
    if (!this.overlay || !this.calibration) return;
    const matrix = this.calibration.frame(frame);
    this.overlay.applyTransform(matrix);
    if (!matrix) return;
    this.overlay.setRoutes(this.runtime.store.getState().routes);
    this.overlay.tick(delta, motion, fanRates);
  }
  select(frame: XRFrame, source: XRInputSource, ray: THREE.Ray) {
    if (this.calibration?.state.phase === "ready") this.selectedRoute = this.overlay?.pick(ray) ?? null;
    else this.calibration?.capture(frame, source.gripSpace);
  }
  dispose() { this.calibration?.dispose(); this.overlay?.dispose(); this.scene.clear(); }
}
