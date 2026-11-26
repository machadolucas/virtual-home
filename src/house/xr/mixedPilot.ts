import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room } from "../model/types";
import { MixedRealityCalibration, calibrationFeatures, type CalibrationFeature } from "./mixed";
import { buildMixedRealityOverlay, type MixedRealityRouteFilter, type MixedRealityRoutePick } from "./mixedOverlay";
import type { PanelPage } from "./panel";
import { RoomSurveyPilot } from "./roomSurvey";
import { HandConfirmation, trackedIndexTip } from "./surveyInput";
import {
  applyAlignmentHint, buildAlignmentModel, matchRoomAlignment, uniqueRoomAlignment,
  type AlignmentCandidate, type AlignmentHint, type AlignmentModel,
} from "./roomAlignment";
import { readAlignmentEvidence, snapScannedCorner, type AlignmentEvidence } from "./roomAlignmentEvidence";
import { AlignmentRays } from "./roomAlignmentRay";
import { triangulateFloorCorner } from "./roomAlignmentTriangulation";
import { canOpenHeadsetRoomSetup, openHeadsetRoomSetup, QUEST_ROOM_SETUP_GUIDE } from "./headsetRoomSetup";
import { WallInspector } from "./wallInspector";

const ROOM_SETUP_GRACE_MS = 3_000;

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
  private wallInspector: WallInspector | null = null;
  private readonly hand = new HandConfirmation();
  private readonly samplePoint = new THREE.Vector3();
  private readonly viewerPoint = new THREE.Vector3();
  private readonly rays: AlignmentRays;
  private alignmentModel: AlignmentModel | null = null;
  private evidence: AlignmentEvidence | null = null;
  private candidates: AlignmentCandidate[] = [];
  private nextScan = -Infinity;
  private hint: AlignmentHint | null = null;
  private scanStatus = "";
  private pointMode: "auto" | "aim" | "touch" = "auto";
  private manual = false;
  private scanStarted = 0;
  private setupGeneration = 0;
  private setupOpen = false;
  private setupNotice = "";
  private firstRay: THREE.Ray | null = null;
  private readonly aimingRay = new THREE.Ray();

  get aimingAtRoom(): boolean {
    const state = this.calibration?.state;
    return !this.setupOpen && !!state && (state.phase === "ready"
      ? this.survey?.aiming === true || this.inspectingWall
      : !!(this.hint || (this.manual && state.selected && this.remotePoints())));
  }
  get inspectingWall(): boolean { return this.wallInspector?.aiming === true; }
  get showHouseTools(): boolean {
    return this.mode === "mr" && this.calibration?.state.phase === "ready" && !this.wallInspector?.active;
  }

  constructor(private runtime: HouseRuntime, private session: XRSession, private space: XRReferenceSpace,
    private mode: "mr" | "survey" = "mr", private onAlignmentLost?: () => void) {
    this.rays = new AlignmentRays(session, space);
    this.space.addEventListener("reset", this.invalidateScan);
    this.session.addEventListener("visibilitychange", this.visibilityChanged);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8896a3, 2));
    this.rooms = [...runtime.manifest!.rooms.values()].filter(r => r.kind !== "void" && r.kind !== "attic");
    const laundry = (r: Room) => [r.name, ...(r.aliases ?? []), runtime.store.getState().labelPreferences.names[r.id]]
      .some(n => n?.toLowerCase().includes("laundry"));
    this.rooms.sort((a, b) => Number(laundry(b)) - Number(laundry(a)) || a.name.localeCompare(b.name));
  }
  enter(room: Room) {
    this.clearRoom();
    this.room = room; this.choosingRoom = false; this.filter = "both"; this.selectedRoute = null;
    const state = this.runtime.store.getState();
    this.alignmentModel = buildAlignmentModel(room, this.roomFeatures(room), this.runtime.index, state.explode);
    this.scanStarted = performance.now();
    this.scanStatus = "Looking for room geometry. Stay inside the selected room.";
    if (this.mode === "survey") {
      this.survey = new RoomSurveyPilot(this.runtime, this.session, this.space, room);
      this.scene.add(this.survey.display.group);
    } else {
      this.overlay = buildMixedRealityOverlay(this.runtime.manifest!, state.routes, room.floorId);
      this.scene.add(this.overlay.group);
      this.wallInspector = new WallInspector(room, this.alignmentModel.walls, this.overlay);
      this.scene.add(this.wallInspector.group);
    }
    this.calibration = new MixedRealityCalibration({ session: this.session, referenceSpace: this.space,
      userId: this.runtime.userId!, floorId: room.floorId, roomId: room.id, fingerprint: state.fingerprint!,
      onState: s => {
        if (s.phase === "ready") return;
        const previouslyVerified = this.readyTransform !== null;
        this.readyTransform = null;
        if (previouslyVerified) this.onAlignmentLost?.();
        this.overlay?.applyTransform(null);
        this.selectedRoute = null;
        this.survey?.pause();
        this.wallInspector?.frame(null);
        if (s.phase === "tracking-lost") this.clearScan();
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
      const names = this.runtime.store.getState().labelPreferences.names;
      return { title: this.mode === "survey" ? "Choose a room to survey" : "Choose a calibration room",
        lines: ["Stand in the real room and select its model counterpart."],
        rows: this.rooms.map(room => ({
          id: room.id, label: names[room.id] ?? room.name, detail: model.floors.get(room.floorId)?.name ?? room.floorId,
          act: () => this.enter(room),
        })) };
    }
    const room = this.room, cal = this.calibration, state = cal.state;
    const features = this.roomFeatures(room);
    const error = state.errorM === null ? "" : `Alignment error: ${(100 * state.errorM).toFixed(1)} cm`;
    const reset = { label: "Realign the room", act: () => {
      this.clearRouteFocus();
      this.hand.clear();
      this.manual = false;
      this.pointMode = "auto";
      this.scanStarted = performance.now();
      this.setupNotice = "";
      this.clearScan();
      cal.reset();
    } };
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
      const verify = state.phase === "verify";
      const localCheck = verify && !!state.selected;
      const mayChoose = state.phase === "select" || verify;
      const remote = this.remotePoints();
      const title = verify ? `Recheck · ${room.name}` : `Align · ${room.name}`;
      if (this.setupOpen) return { title, lines: ["Complete headset room setup, then return here."], rows: [] };
      if (this.hint) return { title: this.hintLabel(this.hint), lines: [this.scanStatus],
        corners: features.map(f => f.point),
        rows: [{ label: "Choose another feature", act: () => { this.hint = null; this.scanStatus = ""; } }, change] };
      if (!this.manual || !mayChoose) {
        const needsHint = !this.manual && mayChoose && this.candidates.length > 1;
        const maySetup = !this.hasSceneGeometry() && performance.now() - this.scanStarted >= ROOM_SETUP_GRACE_MS;
        const manualEntry = { label: localCheck ? "Point to recheck" : "Point to align manually", act: () => {
          this.manual = true; this.pointMode = "aim"; this.scanStatus = ""; this.hint = null; this.firstRay = null;
          if ((verify && !localCheck) || state.phase === "restoring") cal.startManualHere();
        } };
        const status = needsHint ? "Identify one wall or doorway to check which way the room faces."
          : localCheck ? "Checking the saved alignment. You can point at the check corner instead."
            : verify ? state.message
              : mayChoose ? this.scanStatus || "Looking for room geometry. Stay inside the selected room." : state.message;
        return { title, lines: [this.setupNotice || status].filter(Boolean),
          ...(needsHint ? { corners: features.map(f => f.point) } : {}),
          rows: [
            ...(maySetup && mayChoose && canOpenHeadsetRoomSetup(this.session)
              ? [{ label: "Open headset room setup", act: () => void this.openRoomSetup() }] : []),
            ...(needsHint ? this.hintChoices() : []),
            ...(mayChoose || state.phase === "restoring" ? [manualEntry] : []),
            ...(verify || state.phase === "restoring" ? [reset] : []), change,
          ],
        };
      }
      const info = state.selected && remote ? this.scanStatus || (state.errorM !== null ? state.message
        : `Aim at ${state.selected.label} and confirm. Keep your feet still.`) : state.message;
      return { title, lines: [error, info, handsAvailable && !remote ? handNotice : ""].filter(Boolean),
        corners: features.map(f => f.point), rows: [
          ...(state.phase === "select" ? features.map(f => ({
            label: `${state.selected?.id === f.id ? "Selected · " : ""}${f.planLabel ?? f.label}`,
            act: () => { this.scanStatus = ""; this.firstRay = null; cal.select(f); },
          })) : []),
          ...(this.firstRay ? [{ label: "Restart the two aims", act: () => { this.firstRay = null; this.scanStatus = ""; } }] : []),
          { label: remote ? "Touch with controller or fingertip" : "Point remotely instead",
            act: () => { this.pointMode = remote ? "touch" : "aim"; this.firstRay = null; this.scanStatus = ""; this.hand.clear(); } },
          reset, change,
        ] };
    }
    if (this.survey) {
      const menu = this.survey.menu();
      if (this.survey.sampling && !this.survey.aiming) menu.lines.unshift(handNotice);
      menu.rows.push(reset, change);
      return menu;
    }
    if (this.wallInspector?.active && state.errorM !== null)
      return this.wallInspector.menu(state.errorM, () => this.closeWallInspector());
    const focused = this.overlay?.focusedId != null;
    return { title: room.name, lines: [error + (state.persistence === "saved" ? " · Anchor saved" : " · Session alignment"),
      fans, focused ? this.selectedRoute?.label ?? "Tracing one route" : "Trigger a route to trace it. Dashed paths are approximate."],
      rows: [
        ...(focused ? [{ label: "Show all routes", act: () => this.clearRouteFocus() }] : []),
        ...(["pipes", "ducts", "both"] as const).map(filter => ({ label: (filter === this.filter ? "✓ " : "") + filter[0]!.toUpperCase() + filter.slice(1),
          act: () => { this.filter = filter; this.selectedRoute = null; this.overlay?.setFilter(filter); } })),
        { label: "Inspect a wall patch", style: "primary", act: () => {
          this.clearRouteFocus();
          this.wallInspector?.start();
        } },
        { label: "Capture model fix · overlay only", act: capture }, reset, change] };
  }
  clearRouteFocus(): void {
    this.overlay?.clearFocus();
    this.selectedRoute = null;
  }
  frame(frame: XRFrame, delta: number, motion: boolean, fanRates: { supply: number; extract: number }) {
    if (!this.calibration) return;
    const inputs = Array.from(this.session.inputSources);
    if (this.hand.aiming && !inputs.includes(this.hand.aiming)) this.hand.clear();
    const matrix = this.calibration.frame(frame);
    if (this.calibration.state.phase === "ready") {
      this.rays.clear();
      if (this.evidence) this.clearScan();
    }
    else if (!this.setupOpen) {
      this.rays.sync(inputs);
      this.updateScan(frame);
    }
    this.readyTransform = matrix;
    this.survey?.frame(frame, matrix, this.calibration.state.errorM);
    this.overlay?.applyTransform(matrix);
    if (!matrix || !this.overlay) {
      this.wallInspector?.frame(null);
      this.selectedRoute = null;
      return;
    }
    this.overlay.setRoutes(this.runtime.store.getState().routes);
    this.wallInspector?.frame(matrix);
    if (this.selectedRoute?.id !== this.overlay.focusedId) this.selectedRoute = null;
    this.overlay.tick(delta, motion, fanRates);
  }
  probePosition(frame: XRFrame, source: XRInputSource, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.calibration) return null;
    if (this.survey?.aiming && this.calibration.state.phase === "ready") return this.survey.previewAim(frame, source, target);
    if (this.inspectingWall && this.readyTransform) {
      const ray = this.rays.trackedRay(frame, source, this.aimingRay);
      return ray ? this.wallInspector!.probe(ray, this.readyTransform, target) : null;
    }
    if (this.aimingAtRoom) return this.pointAtScan(frame, source, target);
    return source.hand ? trackedIndexTip(frame, this.space, source, target)
      : this.calibration.pointerPosition(frame, source.gripSpace, target);
  }
  hideAimPreview(source: XRInputSource): void { this.survey?.hideAimPreview(source); }
  select(frame: XRFrame, source: XRInputSource, ray: THREE.Ray | null) {
    const calibration = this.calibration;
    if (!calibration || this.setupOpen) return;
    const { phase, selected } = calibration.state;
    if (phase === "ready" && this.overlay) {
      if (this.inspectingWall && this.readyTransform) {
        const tracked = this.rays.trackedRay(frame, source, this.aimingRay);
        if (tracked) this.wallInspector!.confirm(tracked, this.readyTransform);
        return;
      }
      if (!ray || !this.overlay.group.visible) return;
      const hit = this.overlay.pick(ray);
      const focused = this.overlay.toggleFocus(hit?.id ?? null);
      this.selectedRoute = focused && hit?.id === focused ? hit : null;
      return;
    }
    if (this.hint && this.alignmentModel && (phase === "select" || phase === "verify")) {
      const position = this.pointAtScan(frame, source, this.samplePoint);
      if (!position) {
        this.scanStatus = "No tracked surface on the ray. Point at the visible wall or door and try again.";
        return;
      }
      const match = applyAlignmentHint(this.alignmentModel, this.candidates, this.hint, position);
      if (match && this.useCandidate(frame, match)) {
        this.hint = null;
        this.scanStatus = "";
      } else this.scanStatus = "That point did not identify a unique checked match. Aim farther from the corner or choose a different feature.";
      return;
    }
    if (!(phase === "ready" ? this.survey?.sampling : selected)) return;
    if (phase !== "ready" && !this.manual) return;
    if (this.survey?.aiming && phase === "ready") {
      this.survey.captureAim(frame, source);
      return;
    }
    if (phase !== "ready" && this.remotePoints()) {
      const position = this.firstRay ? this.pointByTwoAims(frame, source) : this.pointAtScan(frame, source, this.samplePoint) ??
        this.pointByTwoAims(frame, source);
      if (position) {
        const before = calibration.state.sampleCount;
        calibration.capturePosition(frame, position);
        this.scanStatus = calibration.state.sampleCount === before && calibration.state.phase !== "ready" ? calibration.state.message : "";
      }
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
    this.closeWallInspector();
  }
  private closeWallInspector() {
    this.wallInspector?.clear();
    this.selectedRoute = null;
  }
  private remoteAvailable(): boolean {
    return this.rays.available || !!(this.evidence?.patches.length || this.evidence?.triangles.length);
  }
  private hasSceneGeometry(): boolean {
    return !!(this.evidence?.patches.length || this.evidence?.triangles.length);
  }
  private remotePoints(): boolean {
    return this.pointMode === "aim" || (this.pointMode === "auto" && this.remoteAvailable());
  }
  private pointAtScan(frame: XRFrame, source: XRInputSource, target: THREE.Vector3): THREE.Vector3 | null {
    const evidence = performance.now() <= this.nextScan + 200 ? this.evidence : null;
    const point = this.rays.hit(frame, source, evidence, target);
    if (point && evidence && !this.hint) snapScannedCorner(evidence, point);
    return point;
  }
  private pointByTwoAims(frame: XRFrame, source: XRInputSource): THREE.Vector3 | null {
    const ray = this.rays.trackedRay(frame, source, this.aimingRay);
    if (!ray) { this.scanStatus = "Aim at the floor corner with a tracked pointer and confirm again."; return null; }
    if (!this.firstRay) {
      this.firstRay = ray.clone();
      this.scanStatus = "First aim marked. Keep your feet still, move your aiming hand sideways 30 cm or more, then confirm the same corner.";
      return null;
    }
    const result = triangulateFloorCorner(this.firstRay, ray);
    if (!result.point) { this.scanStatus = result.message; return null; }
    this.firstRay = null;
    return this.samplePoint.copy(result.point);
  }
  private hintLabel(hint: AlignmentHint): string {
    if (hint.kind === "landmark") {
      const mark = this.alignmentModel?.landmarks[hint.index];
      const nearest = this.alignmentModel?.corners.reduce<{ index: number; distance: number }>((best, feature, index) => {
        const distance = Math.hypot(feature.point[0] - (mark?.center[0] ?? 0), feature.point[2] - (mark?.center[2] ?? 0));
        return distance < best.distance ? { index, distance } : best;
      }, { index: 0, distance: Infinity });
      return `${mark?.kind === "window" ? "Window" : "Door"} ${hint.index + 1} near corner ${(nearest?.index ?? 0) + 1}`;
    }
    const wall = this.alignmentModel?.walls[hint.index], corners = this.alignmentModel?.corners ?? [];
    const corner = (point?: [number, number]) =>
      corners.findIndex(({ point: [x, , z] }) => point?.[0] === x && point[1] === z) + 1;
    return `Wall between corners ${corner(wall?.a)} and ${corner(wall?.b)}`;
  }
  private hintChoices() {
    const model = this.alignmentModel;
    if (!model) return [];
    const doors = model.landmarks.map((_, index) => ({ kind: "landmark" as const, index })).slice(0, 2);
    const walls = model.walls.map((wall, index) => ({ index, length: Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]) }))
      .sort((a, b) => b.length - a.length);
    const hints: AlignmentHint[] = [...doors, ...walls.slice(0, doors.length ? 1 : 2)
      .map(({ index }) => ({ kind: "wall" as const, index }))];
    return hints.map((hint) => ({ label: `Aim at ${this.hintLabel(hint)}`, act: () => {
      this.hint = hint;
      this.scanStatus = "Aim at that feature in the real room and confirm away from the menu.";
    } }));
  }
  private updateScan(frame: XRFrame) {
    const model = this.alignmentModel, calibration = this.calibration;
    if (!model || !calibration) return;
    if (!calibration.tracking) {
      this.clearScan();
      return;
    }
    const now = performance.now();
    if (now < this.nextScan) return;
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition) return;
    this.nextScan = now + 500;
    const { x, y, z } = viewer.transform.position;
    this.viewerPoint.set(x, y, z);
    this.evidence = readAlignmentEvidence(frame, this.space, this.viewerPoint);
    const { phase, sampleCount, selected } = calibration.state;
    if (this.manual || (phase !== "verify" && !calibration.awaitingForeignAnchor &&
      (phase !== "select" || sampleCount > 0 || selected))) return;
    this.candidates = matchRoomAlignment(model, this.evidence, this.viewerPoint);
    const match = uniqueRoomAlignment(this.candidates);
    if (match && this.useCandidate(frame, match)) {
      this.hint = null;
      this.scanStatus = "";
    } else if (!this.hint) {
      this.scanStatus = phase === "verify" ? "" : now - this.scanStarted < ROOM_SETUP_GRACE_MS
        ? "Looking for room geometry. Stay inside the selected room."
        : this.hasSceneGeometry()
          ? "A checked room match is unavailable. Point to align from where you stand."
          : canOpenHeadsetRoomSetup(this.session)
            ? "No room geometry found. Open room setup or point to align from here."
            : `No room geometry found. ${QUEST_ROOM_SETUP_GUIDE} You can also point to align from here.`;
    }
  }
  private useCandidate(frame: XRFrame, candidate: AlignmentCandidate) {
    const cal = this.calibration;
    if (!cal || !this.alignmentModel) return false;
    return cal.state.phase === "verify"
      ? cal.verifyScanned(frame, candidate.fit, candidate.errorM, this.alignmentModel.corners, candidate.check)
      : cal.acceptScanned(frame, candidate.fit, candidate.check, candidate.errorM);
  }
  private clearScan() {
    this.nextScan = -Infinity;
    this.evidence = null;
    this.candidates = [];
    this.hint = null;
    this.firstRay = null;
    this.scanStatus = "";
  }
  private async openRoomSetup() {
    if (this.setupOpen || this.hasSceneGeometry() || !canOpenHeadsetRoomSetup(this.session) ||
      performance.now() - this.scanStarted < ROOM_SETUP_GRACE_MS) return;
    const generation = ++this.setupGeneration;
    this.setupOpen = true;
    this.setupNotice = "";
    this.clearScan();
    const opened = await openHeadsetRoomSetup(this.session);
    if (generation !== this.setupGeneration) return;
    this.setupOpen = false;
    this.scanStarted = performance.now();
    this.setupNotice = opened ? "" : `Room setup did not open. ${QUEST_ROOM_SETUP_GUIDE} You can point to align from here.`;
    this.clearScan();
  }
  private invalidateScan = (): void => { this.clearScan(); };
  private visibilityChanged = (): void => {
    if (this.session.visibilityState !== "visible") this.clearScan();
  };
  private clearRoom() {
    this.calibration?.dispose(); this.calibration = null;
    this.wallInspector?.dispose(); this.wallInspector = null;
    this.overlay?.dispose(); this.overlay = null;
    this.selectedRoute = null;
    this.survey?.dispose(); this.survey = null;
    this.readyTransform = null;
    this.hand.clear();
    this.rays.clear();
    this.clearScan();
    this.alignmentModel = null;
    this.setupGeneration++;
    this.setupOpen = false;
    this.setupNotice = "";
    this.manual = false;
    this.pointMode = "auto";
  }
  dispose() {
    this.space.removeEventListener("reset", this.invalidateScan);
    this.session.removeEventListener("visibilitychange", this.visibilityChanged);
    this.clearRoom();
    this.scene.clear();
  }
}
