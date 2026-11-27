import * as THREE from "three";
import type { HouseRuntime } from "../runtime";
import type { Room } from "../model/types";
import { signedClearance } from "../model/geometry2d";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { RoomDiscovery, type RoomDiscoveryState } from "./roomDiscovery";
import { MixedRealityCalibration, calibrationFeatures, type CalibrationFeature } from "./mixed";
import { buildMixedRealityOverlay, type MixedRealityRouteFilter, type MixedRealityRoutePick } from "./mixedOverlay";
import type { PanelPage } from "./panel";
import { RoomSurveyPilot } from "./roomSurvey";
import { HandConfirmation, trackedIndexTip } from "./surveyInput";
import {
  applyAlignmentHint, buildAlignmentModel, checkAnchoredCorner, roomPoseDrift, matchRoomAlignment, uniqueRoomAlignment, viableRoomAlignments,
  type AlignmentCandidate, type AlignmentHint, type AlignmentModel,
} from "./roomAlignment";
import { readAlignmentEvidence, snapScannedCorner, type AlignmentEvidence } from "./roomAlignmentEvidence";
import { AlignmentRays } from "./roomAlignmentRay";
import { triangulateFloorCorner } from "./roomAlignmentTriangulation";
import { canOpenHeadsetRoomSetup, openHeadsetRoomSetup, QUEST_ROOM_SETUP_GUIDE } from "./headsetRoomSetup";
import { WallInspector } from "./wallInspector";

import { chooseFacing, FACING_HOLD_ANGLE, FacingHold, FacingProgress, facingTargets, sameFacing, type FacingTarget } from "./roomFacing";
import { floorAim, WallTrace } from "./wallTrace";

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
  private discovering = true;
  private readonly sceneUnavailable: boolean;
  private readonly discovery: RoomDiscovery;
  private readonly floorAnchors = new Map<string, MixedRealityCalibration>();
  private readonly models = new Map<string, AlignmentModel>();
  private modelAssetCount = -1;
  private suggested: Room[] = [];
  private discoveryPhase: RoomDiscoveryState["phase"] = "waiting";
  private previousAnchorRoom: { room: Room; at: number; matrix: THREE.Matrix4 } | null = null;
  private previousMeasurement: { at: number; matrix: THREE.Matrix4 } | null = null;
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
  private trace: WallTrace | null = null;
  private implicitTrace = false;
  private facing: FacingTarget | null = null;
  private facingOptions: FacingTarget[] = [];
  private facingPrompted: FacingTarget | null = null;
  private readonly facingHold = new FacingHold();
  private facingProgress: FacingProgress | null = null;
  private facingScan = 0;
  private readonly facingRay = new THREE.Ray();
  private confirmBearing = false;
  private chooseDirection = false;
  private replacementNeeded = false;
  private readonly gaze = new THREE.Vector3();
  private readonly headRotation = new THREE.Quaternion();
  private firstRay: THREE.Ray | null = null;
  private readonly aimingRay = new THREE.Ray();

  get aimingAtRoom(): boolean {
    const state = this.calibration?.state;
    return !this.setupOpen && !!state && (state.phase === "ready"
      ? this.survey?.aiming === true || this.inspectingWall
      : !!(this.hint || this.tracingWalls || (this.manual && state.selected && this.remotePoints())));
  }
  get inspectingWall(): boolean { return this.wallInspector?.aiming === true; }
  get showHouseTools(): boolean {
    return this.mode === "mr" && this.calibration?.state.phase === "ready" && !this.wallInspector?.active;
  }

  constructor(private runtime: HouseRuntime, private session: XRSession, private space: XRReferenceSpace,
    private mode: "mr" | "survey" = "mr", private onAlignmentLost?: () => void) {
    this.sceneUnavailable = !!session.enabledFeatures && !session.enabledFeatures.some(
      feature => feature === "plane-detection" || feature === "mesh-detection");
    this.rays = new AlignmentRays(session, space);
    this.space.addEventListener("reset", this.invalidateScan);
    this.session.addEventListener("visibilitychange", this.visibilityChanged);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8896a3, 2));
    this.rooms = [...runtime.manifest!.rooms.values()].filter(r => r.kind !== "void" && r.kind !== "attic");
    const laundry = (r: Room) => [r.name, ...(r.aliases ?? []), runtime.store.getState().labelPreferences.names[r.id]]
      .some(n => n?.toLowerCase().includes("laundry"));
    this.rooms.sort((a, b) => Number(laundry(b)) - Number(laundry(a)) || a.name.localeCompare(b.name));
    this.discovery = new RoomDiscovery(this.rooms, room => this.modelFor(room));
    this.scanStarted = performance.now();
    // One stored pose per floor already maps all its rooms. Restore each existing handle once.
    if (session.restorePersistentAnchor) {
      for (const floorId of new Set(this.rooms.map(room => room.floorId))) {
        const probe = this.newCalibration(floorId);
        if (probe.state.phase === "restoring") this.floorAnchors.set(floorId, probe);
        else probe.dispose();
      }
    }
  }
  enter(room: Room) {
    this.clearRoom();
    this.discovering = false;
    this.resetDiscovery();
    this.room = room; this.filter = "both"; this.selectedRoute = null;
    const state = this.runtime.store.getState();
    this.alignmentModel = this.modelFor(room);
    this.facingOptions = facingTargets(this.alignmentModel, this.rooms, state.labelPreferences.names);
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
    this.calibration = this.floorAnchors.get(room.floorId) ?? this.newCalibration(room.floorId, room.id);
    this.floorAnchors.delete(room.floorId);
    this.calibration.bindRoom(room.id);
    this.disposeProbes();
  }
  private modelFor(room: Room) {
    const cached = this.models.get(room.id);
    if (cached) return cached;
    const model = buildAlignmentModel(
      room,
      this.roomFeatures(room),
      this.runtime.index,
      this.runtime.store.getState().explode,
    );
    this.models.set(room.id, model);
    return model;
  }
  private newCalibration(floorId: string, roomId?: string) {
    const cal: MixedRealityCalibration = new MixedRealityCalibration({
      session: this.session,
      referenceSpace: this.space,
      userId: this.runtime.userId!,
      floorId,
      roomId,
      fingerprint: this.runtime.store.getState().fingerprint!,
      onState: (s) => {
        if (this.calibration !== cal || s.phase === "ready") return;
        const previouslyVerified = this.readyTransform !== null;
        this.readyTransform = null;
        if (previouslyVerified) this.onAlignmentLost?.();
        this.overlay?.applyTransform(null);
        this.selectedRoute = null;
        this.survey?.pause();
        this.wallInspector?.frame(null);
        if (s.phase === "tracking-lost") this.clearScan();
      },
    });
    return cal;
  }
  private disposeProbes() {
    for (const cal of this.floorAnchors.values()) cal.dispose();
    this.floorAnchors.clear();
  }
  private resetDiscovery() {
    this.discovery.reset();
    this.previousAnchorRoom = null;
    this.suggested = [];
    this.discoveryPhase = "waiting";
    this.nextScan = -Infinity;
  }
  private roomFeatures(room: Room): CalibrationFeature[] {
    let features = this.features.get(room.id);
    if (!features) {
      features = calibrationFeatures(this.runtime.manifest!.manifest, room.floorId, room.id);
      this.features.set(room.id, features);
    }
    return features;
  }
  private discoveryMenu(): PanelPage {
    const names = this.runtime.store.getState().labelPreferences.names;
    const rows = (rooms: readonly Room[]) =>
      rooms.map((room) => ({
        id: room.id,
        label: names[room.id] ?? room.name,
        detail: this.runtime.manifest!.floors.get(room.floorId)?.name ?? room.floorId,
        act: () => this.enter(room),
      }));
    const allRooms = () => {
      this.discovering = false;
      this.resetDiscovery();
    };
    if (this.setupOpen)
      return { title: "Headset room setup", lines: ["Finish room setup and return to House."], rows: [] };
    const waited = performance.now() - this.scanStarted >= ROOM_SETUP_GRACE_MS;
    if (
      !this.discovering ||
      (this.sceneUnavailable && this.discoveryPhase !== "confirming") ||
      (waited && this.discoveryPhase === "unmatched")
    ) {
      let instruction = "Select your current room.";
      if (this.discovering)
        instruction = this.sceneUnavailable
          ? "Choose your room to trace its walls."
          : "Look around to keep searching, or choose your room.";
      return {
        title: "Which room are you in?",
        lines: [this.setupNotice || instruction],
        rows: [
          ...(this.discovering && waited && canOpenHeadsetRoomSetup(this.session)
            ? [{ label: "Open headset room setup", act: () => void this.openRoomSetup() }]
            : []),
          ...rows(this.rooms),
        ],
      };
    }
    if (this.discoveryPhase === "ambiguous" && this.suggested.length)
      return {
        title: "Which room are you in?",
        lines: ["These rooms fit the scan. Select yours or keep looking around."],
        rows: [...rows(this.suggested), { label: "Show all rooms", act: allRooms }],
      };
    return {
      title: "Finding your room",
      lines: [
        this.discoveryPhase === "confirming"
          ? "Checking the room’s position and orientation…"
          : "Look around from where you are. House checks the walls and openings.",
      ],
      rows: [{ label: "Choose room myself", act: allRooms }],
    };
  }
  menu(fans: string, capture: () => void): PanelPage {
    if (!this.room || !this.calibration) return this.discoveryMenu();
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
      this.room = null; this.discovering = false; this.resetDiscovery(); this.selectedRoute = null;
    } };
    const handNotice = this.hand.aiming
      ? `Aim with your ${this.hand.aiming.handedness} index finger. Confirm with the other hand or controller.`
      : "Hands: pinch once with the measuring hand, then use the opposite hand to confirm.";
    const handsAvailable = this.mode === "survey" || this.session.enabledFeatures?.includes("hand-tracking") ||
      Array.from(this.session.inputSources).some((input) => !!input.hand);
    if (state.phase !== "ready") {
      const verify = state.phase === "verify";
      const localCheck = verify && !!state.selected;
      const canReplace = state.phase === "restoring" || (state.phase === "tracking-lost" && cal.tracking);
      const mayChoose = state.phase === "select" || verify || canReplace;
      const remote = this.remotePoints();
      const title = verify ? `Recheck · ${room.name}` : `Align · ${room.name}`;
      if (this.setupOpen) return { title, lines: ["Complete headset room setup, then return here."], rows: [] };
      if (this.facing && !this.replacementNeeded) {
        const target = this.facing;
        this.facingPrompted = target;
        return {
          title: "Look toward " + target.label,
          ...(target.planEdge === undefined ? {} : { corners: features.map(f => f.point), planEdge: target.planEdge }),
          lines: [this.facingHold.progress > 0 ? "Hold your view until the ring fills." :
            this.scanStatus || "Turn toward the feature and hold your view. Already facing it? Look away and back, or click either trigger or pinch."],
          rows: [
            { label: "Use my facing direction", style: "primary", act: () => {
              if (this.facing === target) this.confirmBearing = true;
            } },
            { label: "Choose another direction", act: () => {
              if (this.facing !== target) return;
              this.setFacing(null); this.chooseDirection = true; this.scanStatus = "";
            } },
          ],
        };
      }
      if (this.replacementNeeded) return {
        title: this.previousMeasurement ? "Checking the new alignment" : "Use the new alignment?",
        lines: [this.previousMeasurement ? "Keep looking around. A second matching scan will finish alignment."
          : "The walls match the room. Its previous alignment could not be verified."],
        rows: [{ label: "Use the new room measurement", style: "primary", act: () => {
          cal.startManualHere(); this.replacementNeeded = false; this.nextScan = -Infinity;
        } }, reset, change],
      };
      if (this.hint) return { title: this.hintLabel(this.hint), lines: [this.scanStatus],
        corners: features.map(f => f.point),
        rows: [{ label: "Choose another feature", act: () => { this.hint = null; this.scanStatus = ""; } }, change] };
      if (!this.manual || !mayChoose) {
        const needsHint = !this.manual && mayChoose && this.needsBearing;
        const maySetup = !needsHint && !this.trace && performance.now() - this.scanStarted >= ROOM_SETUP_GRACE_MS;
        const manualEntry = { label: localCheck ? "Point to recheck" : "Point to align manually", act: () => {
          this.stopTracing(); this.manual = true; this.pointMode = "aim"; this.scanStatus = ""; this.hint = null; this.firstRay = null;
          if ((verify && !localCheck) || canReplace) cal.startManualHere();
        } };
        if (this.trace && !needsHint) {
          const count = this.trace.walls.length;
          return { title: count ? `Trace walls · ${count} marked` : "Trace a wall",
            lines: [this.trace.message || (count >= 3 && !this.candidates.length
              ? "Still checking the room. Add a different side, or undo a misplaced stroke."
              : count ? "Choose a different wall." : "Stay in one spot. Aim at the base of any wall."),
              "Hold the trigger or pinch and trace where the wall meets the floor. Release when the line turns green (about a metre)."],
            rows: [
              ...(count ? [{ label: "Undo last wall", act: () => { this.trace?.undo(); this.candidates = []; this.nextScan = -Infinity; } }] : []),
              { label: "Back to room scan", act: () => { this.stopTracing(); this.clearScan(); } }, change,
            ] };
        }
        const status = needsHint ? "The walls match. One direction will distinguish the room’s orientation."
          : localCheck ? this.scanStatus || "Look around while the headset rechecks this room."
            : verify ? this.scanStatus || state.message
              : mayChoose ? this.scanStatus || "Looking for room geometry. Stay inside the selected room." : state.message;
        return { title, lines: [this.setupNotice || status].filter(Boolean),
          rows: [
            ...(maySetup && mayChoose && canOpenHeadsetRoomSetup(this.session)
              ? [{ label: "Open headset room setup", act: () => void this.openRoomSetup() }] : []),
            ...(needsHint ? this.facingOptions.map((target,i) => ({
              label: "Look toward " + target.label, style: i === 0 ? "primary" as const : "choice" as const,
              act: () => { this.setFacing(target); this.scanStatus = ""; },
            })) : []),
            ...(needsHint && this.remoteAvailable() ? this.hintChoices() : []),
            ...(needsHint && this.trace?.walls.length ? [{ label: "Undo last wall", act: () => {
              this.trace?.undo(); this.candidates = []; this.nextScan = -Infinity;
            } }] : []),
            ...(!this.trace && mayChoose ? [{
              label: "Trace wall bases", detail: "From where you stand", style: "choice" as const, act: () => {
                this.trace = new WallTrace(); this.scene.add(this.trace.group); this.scanStatus = "";
                this.nextScan = -Infinity;
              },
            }] : []),
            ...(mayChoose ? [manualEntry] : []),
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
  frame(frame: XRFrame, delta: number, motion: boolean, fanRates: { supply: number; extract: number },
    lookingAtPanel?: (gaze: THREE.Ray) => boolean, promptAvailable = true) {
    if (!this.calibration) {
      if (this.discovering && !this.setupOpen) this.findRoom(frame);
      return;
    }
    const inputs = Array.from(this.session.inputSources);
    if (this.hand.aiming && !inputs.includes(this.hand.aiming)) this.hand.clear();
    const matrix = this.calibration.frame(frame);
    if (this.calibration.state.phase === "ready") {
      this.rays.clear();
      if (this.evidence) this.clearScan();
    }
    else if (!this.setupOpen) {
      this.rays.sync(inputs);
      if (this.trace?.source) {
        if (this.calibration.tracking && inputs.includes(this.trace.source))
          this.trace.sample(this.tracePoint(frame, this.trace.source, this.samplePoint));
        else this.trace.cancel();
      }
      this.updateScan(frame);
      if (this.confirmBearing) { this.confirmBearing = false; this.resolveFacing(frame); }
      this.updateFacingHold(frame, lookingAtPanel, promptAvailable);
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
    if (this.tracingWalls) return this.tracePoint(frame, source, target);
    if (this.aimingAtRoom) return this.pointAtScan(frame, source, target);
    return source.hand ? trackedIndexTip(frame, this.space, source, target)
      : this.calibration.pointerPosition(frame, source.gripSpace, target);
  }
  hideAimPreview(source: XRInputSource): void { this.survey?.hideAimPreview(source); }
  select(frame: XRFrame, source: XRInputSource, ray: THREE.Ray | null) {
    const calibration = this.calibration;
    if (!calibration || this.setupOpen) return;
    const { phase, selected } = calibration.state;
    if (this.facing && phase !== "ready") {
      this.resolveFacing(frame);
      return calibration.state.phase === "ready";
    }
    if (phase === "ready" && this.overlay) {
      if (this.inspectingWall && this.readyTransform) {
        const tracked = this.rays.trackedRay(frame, source, this.aimingRay);
        return !!tracked && this.wallInspector!.confirm(tracked, this.readyTransform);
      }
      if (!ray || !this.overlay.group.visible) return;
      const hit = this.overlay.pick(ray);
      const previous = this.overlay.focusedId;
      const focused = this.overlay.toggleFocus(hit?.id ?? null);
      this.selectedRoute = focused && hit?.id === focused ? hit : null;
      return previous !== focused;
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
        return true;
      } else this.scanStatus = "That point did not identify a unique checked match. Aim farther from the corner or choose a different feature.";
      return;
    }
    if (!(phase === "ready" ? this.survey?.sampling : selected)) return;
    if (phase !== "ready" && !this.manual) return;
    if (this.survey?.aiming && phase === "ready") {
      return this.survey.captureAim(frame, source);
    }
    if (phase !== "ready" && this.remotePoints()) {
      const awaitingSecondRay = !!this.firstRay;
      const position = this.firstRay ? this.pointByTwoAims(frame, source) : this.pointAtScan(frame, source, this.samplePoint) ??
        this.pointByTwoAims(frame, source);
      if (position) {
        const before = calibration.state.sampleCount;
        const accepted = calibration.capturePosition(frame, position);
        this.scanStatus = calibration.state.sampleCount === before && calibration.state.phase !== "ready" ? calibration.state.message : "";
        return accepted;
      }
      return !awaitingSecondRay && !!this.firstRay;
    }
    const input = this.hand.select(source);
    if (!input) return;
    const position = this.probePosition(frame, input, this.samplePoint);
    return phase === "ready" ? this.survey?.capture(position) : calibration.capturePosition(frame, position);
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
  private get needsBearing() {
    return this.candidates.length > 1 && this.candidates.some(candidate => !candidate.landmarkConflict);
  }
  private get tracingWalls() {
    return !!this.trace && !this.facing && !this.hint && !this.replacementNeeded &&
      !this.needsBearing && this.calibration?.state.phase !== "ready";
  }
  private tracePoint(frame: XRFrame, source: XRInputSource, target: THREE.Vector3) {
    const ray = this.rays.trackedRay(frame, source, this.aimingRay);
    return ray ? floorAim(ray, this.evidence?.floor?.y ?? 0, target) : null;
  }
  beginWallTrace(frame: XRFrame, source: XRInputSource) {
    if (!this.calibration?.tracking) return false;
    if (!this.trace && !this.manual && !this.setupOpen && !this.facing && !this.hint && !this.replacementNeeded &&
      !this.candidates.length && (this.calibration.state.phase === "select" || this.calibration.state.phase === "verify") &&
      (this.sceneUnavailable || performance.now() - this.scanStarted >= ROOM_SETUP_GRACE_MS) && this.tracePoint(frame, source, this.samplePoint)) {
      this.trace = new WallTrace();
      this.implicitTrace = true;
      this.scene.add(this.trace.group);
    }
    if (!this.tracingWalls || !this.trace?.begin(source)) return false;
    this.trace.sample(this.tracePoint(frame, source, this.samplePoint));
    return true;
  }
  finishWallTrace(frame: XRFrame, source: XRInputSource) {
    if (!this.trace || this.trace.source !== source) return false;
    this.trace.sample(this.tracePoint(frame, source, this.samplePoint));
    const marked = this.trace.finish(source);
    if (marked) this.implicitTrace = false;
    else if (this.implicitTrace) this.stopTracing();
    this.nextScan = -Infinity;
    return marked;
  }
  cancelWallTrace() {
    this.trace?.cancel();
    if (this.implicitTrace) this.stopTracing();
  }
  private stopTracing() { this.trace?.dispose(); this.trace = null; this.implicitTrace = false; }

  private resetFacingHold() {
    this.facingHold.reset();
    this.facingProgress?.hide();
  }

  private setFacing(target: FacingTarget | null) {
    this.facing = target;
    this.facingPrompted = null;
    this.confirmBearing = false;
    this.resetFacingHold();
  }

  private readFacingPose(frame: XRFrame) {
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition || this.session.visibilityState !== "visible") return false;
    this.headRotation.copy(viewer.transform.orientation);
    this.gaze.set(0, 0, -1).applyQuaternion(this.headRotation).normalize();
    this.facingRay.origin.copy(viewer.transform.position);
    this.facingRay.direction.copy(this.gaze);
    return true;
  }

  private updateFacingHold(
    frame: XRFrame,
    lookingAtPanel: ((gaze: THREE.Ray) => boolean) | undefined,
    promptAvailable: boolean,
  ) {
    const target = this.facing;
    if (
      !promptAvailable ||
      !target ||
      this.facingPrompted !== target ||
      this.replacementNeeded ||
      !this.calibration?.tracking ||
      this.calibration.state.phase === "ready" ||
      !this.readFacingPose(frame)
    ) {
      if (!promptAvailable) this.facingPrompted = null;
      this.resetFacingHold();
      return;
    }
    const eye = this.facingRay.origin;
    const candidate = chooseFacing(this.candidates, target, eye, this.gaze, FACING_HOLD_ANGLE);
    const checked = this.facingHold.update(
      target,
      candidate,
      eye,
      this.gaze,
      this.facingScan,
      performance.now(),
      lookingAtPanel?.(this.facingRay) ?? false,
    );
    if (checked) {
      this.resolveFacing(frame, checked);
    } else if (this.facingHold.progress > 0) {
      if (!this.facingProgress) {
        this.facingProgress = new FacingProgress();
        this.scene.add(this.facingProgress.group);
      }
      this.facingProgress.show(this.facingHold.progress, eye, this.headRotation);
    } else this.facingProgress?.hide();
  }

  private resolveFacing(frame: XRFrame, checked?: AlignmentCandidate) {
    const target = this.facing;
    if (!target || !this.calibration?.tracking) return;
    this.resetFacingHold();
    // Re-read native observations in the current reference space before accepting a heading.
    const before = this.facingScan;
    this.nextScan = -Infinity;
    this.updateScan(frame);
    if (this.facing !== target || this.calibration.state.phase === "ready" || this.facingScan === before || !this.readFacingPose(frame)) return;
    const match = chooseFacing(this.candidates, target, this.facingRay.origin, this.gaze, checked ? FACING_HOLD_ANGLE : undefined);
    if (match && (!checked || sameFacing(checked, match, target)) && this.useCandidate(frame, match)) this.setFacing(null);
    else this.scanStatus = this.replacementNeeded ? "" : "The direction is still ambiguous. Face the feature more directly or choose another direction.";
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
  private findRoom(frame: XRFrame) {
    if (frame.session !== this.session) return;
    const viewer = frame.getViewerPose(this.space);
    if (!viewer || viewer.emulatedPosition || this.session.visibilityState !== "visible") {
      this.resetDiscovery();
      return;
    }
    const now = performance.now();
    const { x, y, z } = viewer.transform.position;
    this.viewerPoint.set(x, y, z);
    const assets = this.runtime.index?.surfaceMesh.size ?? 0;
    if (assets !== this.modelAssetCount) {
      this.modelAssetCount = assets;
      this.models.clear();
      this.resetDiscovery();
    }
    if (now >= this.nextScan && this.discovery.state.phase !== "checking") {
      this.nextScan = now + 500;
      const evidence = readAlignmentEvidence(frame, this.space, this.viewerPoint);
      if (this.locateFromAnchors(frame, evidence, now)) return;
      this.discovery.submit(evidence, this.viewerPoint, now);
    }
    const result = this.discovery.step(this.viewerPoint);
    if (result.phase !== "checking") {
      this.suggested = result.options.map((choice) => choice.room);
      this.discoveryPhase = result.phase;
    }
    if (result.match) {
      // Room comparisons span several frames. Confirm the current observation before leaving the chooser.
      const fresh = readAlignmentEvidence(frame, this.space, this.viewerPoint);
      const model = this.modelFor(result.match.room);
      const poses = matchRoomAlignment(model, fresh, this.viewerPoint);
      if (
        !viableRoomAlignments(poses).some((current) =>
          result.match!.candidates.some(
            (previous) =>
              roomPoseDrift(model.room, current.fit.matrix, previous.fit.matrix) + current.errorM <=
              MAX_CALIBRATION_ERROR_M,
          ),
        )
      ) {
        this.resetDiscovery();
        return;
      }
      this.enter(result.match.room);
    }
  }

  private locateFromAnchors(frame: XRFrame, evidence: AlignmentEvidence, now: number) {
    const located: { room: Room; matrix: THREE.Matrix4; calibration: MixedRealityCalibration }[] = [];
    for (const [floorId, calibration] of this.floorAnchors) {
      calibration.frame(frame);
      const matrix = calibration.savedFloorPose(frame);
      if (!matrix || !evidence.floor) continue;
      const local = this.viewerPoint.clone().applyMatrix4(matrix.clone().invert());
      for (const room of this.rooms) {
        if (
          floorId !== room.floorId ||
          Math.abs(room.floorElevation + matrix.elements[13]! - evidence.floor.y) >
            MAX_CALIBRATION_ERROR_M ||
          signedClearance(local.x, local.z, room.footprint) <= 0.15
        )
          continue;
        located.push({ room, matrix, calibration });
      }
    }
    const target = located.length === 1 ? located[0] : null;
    if (!target) {
      this.previousAnchorRoom = null;
      return false;
    }
    const { room, matrix, calibration } = target;
    const model = this.modelFor(room);
    const checkId =
      calibration.state.selected?.roomId === room.id ? calibration.state.selected.id : undefined;
    const corner = checkAnchoredCorner(model, evidence, this.viewerPoint, matrix, checkId);
    const scan = matchRoomAlignment(model, evidence, this.viewerPoint);
    // A complete scan must agree even if a single measured corner happened to line up.
    const checked = scan.length
      ? viableRoomAlignments(scan).find(
          (candidate) =>
            roomPoseDrift(model.room, matrix, candidate.fit.matrix) + candidate.errorM <=
            MAX_CALIBRATION_ERROR_M,
        )
      : corner;
    if (!checked) {
      this.previousAnchorRoom = null;
      return false;
    }
    const previous = this.previousAnchorRoom;
    this.previousAnchorRoom = { room, matrix: matrix.clone(), at: now };
    if (
      !previous ||
      previous.room.id !== room.id ||
      now - previous.at < 350 ||
      now - previous.at > 2000 ||
      roomPoseDrift(model.room, previous.matrix, matrix) + checked.errorM > MAX_CALIBRATION_ERROR_M
    )
      return false;
    this.enter(room);
    calibration.verifyScanned(frame, checked.fit, checked.errorM, model.corners, checked.check);
    return true;
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
    if (this.manual || (phase !== "verify" && phase !== "restoring" && phase !== "tracking-lost" &&
      (phase !== "select" || sampleCount > 0 || selected))) return;
    const evidence = this.trace?.walls.length
      ? this.trace.evidence(this.evidence.floor?.y ?? 0, this.evidence) : this.evidence;
    this.candidates = matchRoomAlignment(model, evidence, this.viewerPoint);
    this.facingScan++;
    if (phase === "verify" && viableRoomAlignments(this.candidates).some(candidate =>
      calibration.verifyScanned(frame, candidate.fit, candidate.errorM, model.corners, candidate.check))) {
      this.clearScan();
      return;
    }
    if (!this.candidates.length && phase === "verify" && !this.trace) {
      const anchor = calibration.savedFloorPose(frame);
      const checkId = selected?.roomId === model.room.id ? selected.id : undefined;
      const measured = anchor && checkAnchoredCorner(model, evidence, this.viewerPoint, anchor, checkId);
      if (measured && calibration.verifyScanned(frame,measured.fit,measured.errorM,model.corners,measured.check)) {
        this.clearScan();
        return;
      }
    }
    if (this.facing && !viableRoomAlignments(this.candidates).length) this.setFacing(null);
    const match = uniqueRoomAlignment(this.candidates);
    const previous = this.previousMeasurement;
    const nativeFit = match && !this.trace && this.evidence.floor &&
      (this.evidence.floor.source === "plane" || this.evidence.floor.source === "mesh");
    const repeated = nativeFit && previous && now - previous.at >= 350 && now - previous.at <= 2000 &&
      roomPoseDrift(model.room, previous.matrix, match.fit.matrix) + match.errorM <= MAX_CALIBRATION_ERROR_M;
    this.previousMeasurement = nativeFit ? {at:now,matrix:match.fit.matrix.clone()} : null;
    if (repeated && this.replacementNeeded) {
      calibration.startManualHere();
      this.replacementNeeded = false;
    }
    if ((!this.facing || repeated) && match && this.useCandidate(frame, match)) {
      this.hint = null;
      this.scanStatus = "";
    } else if (!this.chooseDirection && !this.hint && !this.facing && !this.replacementNeeded && this.needsBearing && this.facingOptions.length) {
      this.setFacing(this.facingOptions[0]!);
      this.scanStatus = "";
    } else if (!this.hint && !this.facing) {
      this.scanStatus = now - this.scanStarted < ROOM_SETUP_GRACE_MS
        ? "Looking for room geometry. Stay inside the selected room."
        : this.hasSceneGeometry()
          ? "Keep looking around, or hold the trigger and trace along a wall base from here."
          : canOpenHeadsetRoomSetup(this.session)
            ? "No room scan is visible. Open headset room setup, or hold the trigger and trace a wall base."
            : `No room geometry found. ${QUEST_ROOM_SETUP_GUIDE} Or hold the trigger and trace a wall base.`;
    }
  }
  private useCandidate(frame: XRFrame, candidate: AlignmentCandidate) {
    const cal = this.calibration;
    if (!cal || !this.alignmentModel) return false;
    if (cal.state.phase === "verify") {
      if (cal.verifyScanned(frame, candidate.fit, candidate.errorM, this.alignmentModel.corners, candidate.check)) return true;
      this.replacementNeeded = true;
      this.setFacing(null);
      return false;
    }
    if (cal.acceptScanned(frame, candidate.fit, candidate.check, candidate.errorM)) return true;
    if (cal.state.phase === "restoring" || cal.state.phase === "tracking-lost") {
      this.replacementNeeded = true;
      this.setFacing(null);
    }
    return false;
  }
  private clearScan() {
    this.previousMeasurement = null;
    this.nextScan = -Infinity;
    this.evidence = null;
    this.stopTracing();
    this.setFacing(null);
    this.chooseDirection = false;
    this.replacementNeeded = false;
    this.candidates = [];
    this.hint = null;
    this.firstRay = null;
    this.scanStatus = "";
  }
  private async openRoomSetup() {
    if (this.setupOpen || !canOpenHeadsetRoomSetup(this.session) ||
      performance.now() - this.scanStarted < ROOM_SETUP_GRACE_MS) return;
    const generation = ++this.setupGeneration;
    this.setupOpen = true;
    this.resetDiscovery();
    this.setupNotice = "";
    this.clearScan();
    const opened = await openHeadsetRoomSetup(this.session);
    if (generation !== this.setupGeneration) return;
    this.setupOpen = false;
    this.scanStarted = performance.now();
    this.setupNotice = opened ? "" : `Room setup did not open. ${QUEST_ROOM_SETUP_GUIDE} You can trace the walls from here.`;
    this.clearScan();
  }
  private invalidateScan = (): void => { this.clearScan(); this.resetDiscovery(); };
  private visibilityChanged = (): void => {
    if (this.session.visibilityState !== "visible") this.invalidateScan();
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
    this.disposeProbes();
    this.facingProgress?.dispose();
    this.scene.clear();
  }
}
