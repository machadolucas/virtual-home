import * as THREE from "three";
import { pointInFootprint } from "@/house/model/geometry2d";
import type { Furnishing, Placement, Room, Vec3 } from "@/house/model/types";
import { equipmentPreviewShape } from "@/house/scene/equipmentPlacement";
import { furnishingGeometry } from "@/house/scene/furnishingGeometry";
import type { HouseRuntime } from "../runtime";
import { getRoomSurvey, getRoomSurveyGeometry, listRoomSurveys, proposeRoomSurveyMove,
  recordRoomSurveyObservation, saveRoomSurvey } from "../roomSurveyApi";
import { reviewRoomSurveyMove } from "../roomSurveyReview";
import {
  MAX_ROOM_SURVEY_BODY_BYTES, MAX_ROOM_SURVEY_RESIDUAL_M,
  surveyDistanceM, surveyHeadingChange,
  type RoomSurveyCapture, type RoomSurveyGeometry, type RoomSurveyMeasurement, type RoomSurveyMove, type RoomSurveyMoveInput,
  type RoomSurveyObservation, type RoomSurveyObservationInput, type RoomSurveyPose, type RoomSurveySummary,
} from "../roomSurveyTypes";
import type { PanelPage, PanelRow } from "./panel";
import { canOpenHeadsetRoomSetup, openHeadsetRoomSetup, QUEST_ROOM_SETUP_GUIDE } from "./headsetRoomSetup";
import { modelSurveyFaces, suggestSurveyDiscrepancies, type SurveyDiscrepancy } from "./surveyDiscrepancies";
import { SurveyDisplay } from "./surveyDisplay";
import { SurveyAimInput } from "./surveyInput";
import {
  fitsSurveyUpload, localToSurveyPoint, measurementLength, readFullRoomSurfaces, readRoomSurfaces, surveyBounds,
  surveyExtent, surveyHeading,
} from "./surveyGeometry";

type Page = "main" | "measure" | "references" | "targets" | "move" | "observation" | "saved" | "discrepancies" | "discrepancy";
type Target =
  | { kind: "equipment"; item: Placement }
  | { kind: "furnishing"; item: Furnishing };
type MeasureKind = RoomSurveyMeasurement["kind"];
type ManualObservation = Extract<RoomSurveyObservationInput, { description: string }>;
type SensorScope = "full" | "bounded";
type PointMode = "aim" | "touch";
type Sample =
  | { kind: "point" }
  | { kind: "measurement"; measure: MeasureKind; a?: Vec3 }
  | { kind: "move_position" }
  | { kind: "move_heading" }
  | { kind: "observation"; observation: ManualObservation["kind"] };

type DiscrepancyReview = SurveyDiscrepancy & { requestId: string; fixId?: string };

const MEASURE_KINDS: Record<MeasureKind, string> = {
  distance: "Distance", ceiling_height: "Ceiling height", opening_width: "Opening width", opening_height: "Opening height",
};
const emptyGeometry = (): RoomSurveyGeometry => ({ scope: "manual", surfaces: [], measurements: [] });
const dateLabel = (ms: number) => new Date(ms).toLocaleString();
const back = (act: () => void): PanelRow => ({ label: "Survey tools", act });
const BLOCKED_MOVE = "The mounting surface needs manual review. The measurement is saved.";
const SETUP_GUIDE = `${QUEST_ROOM_SETUP_GUIDE} You can also mark points manually.`;

export class RoomSurveyPilot {
  readonly display: SurveyDisplay;
  private readonly bounds: THREE.Box3;
  private readonly inverse = new THREE.Matrix4();
  private readonly trackingFromModel = new THREE.Matrix4();
  private readonly aim: SurveyAimInput;
  private geometry = emptyGeometry();
  private extent: ReturnType<typeof surveyExtent>;
  private page: Page = "main";
  private busy = false;
  private alive = true;
  private notice = "";
  private errorM: number | null = null;
  private captureErrorM: number | null = null;
  private plannedPreview: SensorScope | null = null;
  private missingSensorGeometry = false;
  private openingRoomSetup = false;
  private pointMode: PointMode = "touch";
  private preferredPointMode: PointMode | null = null;
  private sample: Sample | null = null;
  private readonly fingerprint: string;
  private saved: RoomSurveySummary | null = null;
  private saveCapture: RoomSurveyCapture | null = null;
  private references: RoomSurveySummary[] = [];
  private referencesCursor: string | null = null;
  private targets: Target[] = [];
  private chosen: Target | null = null;
  private draft: RoomSurveyMoveInput | null = null;
  private draftPointSource: "manual" | "hit-test" = "manual";
  private move: RoomSurveyMove | null = null;
  private reopenedMoves: RoomSurveyMove[] = [];
  private observationRequest: (ManualObservation & { surveyId: string }) | null = null;
  private discrepancies: DiscrepancyReview[] = [];
  private selectedDiscrepancy: DiscrepancyReview | null = null;
  private reopenedObservations: RoomSurveyObservation[] = [];
  private discrepancyHome: "main" | "saved" = "main";

  get sampling() { return this.sample !== null; }
  get aiming() { return this.sampling && this.pointMode === "aim"; }

  constructor(
    private readonly runtime: HouseRuntime,
    private readonly session: XRSession,
    private readonly reference: XRReferenceSpace,
    private readonly room: Room,
  ) {
    this.display = new SurveyDisplay(room);
    this.bounds = surveyBounds(room);
    this.aim = new SurveyAimInput(session, reference);
    this.extent = surveyExtent(this.geometry, room);
    this.fingerprint = runtime.store.getState().fingerprint!;
  }

  frame(frame: XRFrame, matrix: THREE.Matrix4 | null, errorM: number | null): void {
    if (this.openingRoomSetup || frame.session !== this.session || !matrix || errorM === null || !Number.isFinite(errorM) ||
      errorM < 0 || errorM > MAX_ROOM_SURVEY_RESIDUAL_M || this.session.visibilityState !== "visible" ||
      this.runtime.store.getState().fingerprint !== this.fingerprint) {
      this.pause();
      return;
    }
    this.display.apply(matrix);
    this.errorM = errorM;
    this.trackingFromModel.copy(matrix);
    this.inverse.copy(matrix).invert();
    this.aim.frame(frame, this.aiming);
    const scope = this.plannedPreview;
    if (!scope) return;
    this.plannedPreview = null;
    this.previewSensors(frame, scope);
  }

  private previewSensors(frame: XRFrame, scope: SensorScope): void {
    this.missingSensorGeometry = false;
    const detected = scope === "full" ? readFullRoomSurfaces(frame, this.reference, this.inverse)
      : { kind: "bounded" as const, surfaces: readRoomSurfaces(frame, this.reference, this.inverse, this.bounds) };
    if (detected.kind === "too-large") {
      this.notice = "Full scene exceeds capture limits. Choose the separate bounded preview for a smaller reference.";
      return;
    }
    if (!("surfaces" in detected) || !detected.surfaces.length) {
      this.missingSensorGeometry = detected.kind === "unavailable" || detected.kind === "bounded";
      this.notice = detected.kind === "untracked" ? "Some scene geometry has lost tracking. Scan the area and try again."
        : detected.kind === "invalid" ? "The headset supplied incomplete geometry. Try the bounded preview."
          : this.canOpenRoomSetup() ? "No room geometry was detected. Open headset room setup or mark points manually."
            : `No room geometry was detected. ${SETUP_GUIDE}`;
      return;
    }
    const geometry: RoomSurveyGeometry = {
      ...this.geometry, scope,
      surfaces: [...this.geometry.surfaces.filter((s) => s.source === "manual" || s.source === "hit-test"), ...detected.surfaces],
    };
    if (!fitsSurveyUpload(geometry)) {
      this.notice = "Full scene exceeds upload limits. Choose the separate bounded preview for a smaller reference.";
      return;
    }
    this.updateGeometry(geometry);
    this.notice = scope === "full"
      ? "Review the full headset scene. It may contain adjoining spaces."
      : "Review the bounded, simplified geometry and its extent.";
  }

  private canOpenRoomSetup(): boolean {
    return this.missingSensorGeometry && canOpenHeadsetRoomSetup(this.session);
  }

  private async openRoomSetup(): Promise<void> {
    if (!this.canOpenRoomSetup() || !this.aligned() || this.busy) return;
    this.openingRoomSetup = true;
    this.pause();
    try {
      // Start directly in the menu activation. Wait for the next tracked frame after returning.
      const opened = await openHeadsetRoomSetup(this.session);
      if (this.alive) this.notice = opened
        ? "When room setup is complete, return here and preview geometry again."
        : `Headset room setup did not open. ${SETUP_GUIDE}`;
    } finally {
      this.openingRoomSetup = false;
    }
  }

  pause(): void {
    if (this.sample) this.notice = "Tracking stopped. Recheck alignment before starting a new measurement.";
    this.errorM = null;
    this.clearSample();
    this.plannedPreview = null;
    this.display.apply(null);
  }

  /** The event is deliberate. The supplied point comes from the controller or the separately confirmed index finger. */
  capture(local: THREE.Vector3 | null) {
    if (!this.sampling || this.aiming || !this.aligned()) return;
    const position = local && localToSurveyPoint(local, this.inverse, this.bounds);
    if (!position) {
      this.notice = "Touch a tracked point inside the survey extent.";
      return;
    }
    return this.capturePoint(position, "manual");
  }

  previewAim(frame: XRFrame, source: XRInputSource, target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.aiming || !this.aligned()) return null;
    return this.aim.preview(frame, source, this.trackingFromModel, target, (hit) => {
      const point = localToSurveyPoint(hit, this.inverse, this.bounds);
      if (!point || (this.sample?.kind === "move_position" && !pointInFootprint(point[0], point[2], this.room.footprint)))
        return null;
      return point;
    });
  }

  hideAimPreview(source: XRInputSource): void { this.aim.hide(source); }

  captureAim(frame: XRFrame, source: XRInputSource) {
    if (!this.aiming || !this.aligned()) return;
    const point = this.aim.take(frame, source, this.trackingFromModel);
    if (!point) {
      this.notice = "Aim until the orange point is steady, then confirm. Choose touch if a surface is unavailable.";
      return;
    }
    return this.capturePoint(point, "hit-test");
  }

  private capturePoint(position: Vec3, source: "manual" | "hit-test") {
    const sample = this.sample!;
    if (sample.kind === "measurement" && !sample.a) {
      this.sample = { ...sample, a: position };
      this.display.showHit(position);
      this.notice = "Point A marked in blue. Confirm point B.";
      return true;
    }
    return this.applySample(sample, position, source);
  }

  private applySample(sample: Sample, position: Vec3, source: "manual" | "hit-test") {
    switch (sample.kind) {
      case "point":
        if (!this.recordPoint(position, source)) return;
        this.notice = "Point included in the room reference.";
        break;
      case "measurement": {
        const measurement: RoomSurveyMeasurement = { kind: sample.measure, a: sample.a!, b: position };
        const distance = measurementLength(measurement);
        if (distance < 0.01) { this.notice = "Choose a second point at least 1 cm away on the measured axis."; return; }
        if (this.geometry.measurements.length >= 64) { this.notice = "This reference already has 64 measurements."; return; }
        this.updateGeometry({ ...this.geometry, measurements: [...this.geometry.measurements, measurement] });
        this.notice = `${MEASURE_KINDS[sample.measure]} · ${distance.toFixed(3)} m`;
        break;
      }
      case "move_position": {
        if (!this.chosen || !pointInFootprint(position[0], position[2], this.room.footprint)) {
          this.notice = "The sampled object position must be within this room.";
          return;
        }
        const { kind, item } = this.chosen;
        const yawDeg = this.draft?.sample.yawDeg;
        this.draftPointSource = source;
        this.draft = {
          requestId: crypto.randomUUID(), target: { kind, id: item.id },
          before: { position: item.position, yawDeg: item.rotationYDeg },
          sample: { position, ...(yawDeg === undefined ? {} : { yawDeg }) }, registrationErrorM: this.errorM!,
        };
        this.showDraft();
        this.notice = "Compare the original amber pose with the proposed green pose.";
        break;
      }
      case "move_heading": {
        if (!this.draft) return;
        const yawDeg = surveyHeading(this.draft.sample.position, position);
        if (yawDeg === null) { this.notice = "Mark a heading point at least 15 cm forward in the horizontal plane."; return; }
        this.draft.sample.yawDeg = yawDeg;
        this.draft.requestId = crypto.randomUUID();
        this.showDraft();
        this.notice = "Heading added. Compare both poses before saving or applying.";
        break;
      }
      case "observation": {
        if (!this.saved) return;
        const description = sample.observation === "structure"
          ? "Structure observation from a room survey. Review the marked point and add details."
          : "New object observed during a room survey. Review the marked point and add details.";
        this.observationRequest = {
          requestId: crypto.randomUUID(), surveyId: this.saved.id, kind: sample.observation, position, description,
        };
        this.notice = "Point marked. Save it as a pending model fix.";
        break;
      }
    }
    this.clearSample();
    return true;
  }

  private recordPoint(position: Vec3, source: "manual" | "hit-test" = "manual"): boolean {
    if (this.geometry.surfaces.length >= 120) { this.notice = "This reference already has the maximum number of sample groups."; return false; }
    this.updateGeometry({ ...this.geometry, surfaces: [...this.geometry.surfaces, { source, points: [position] }] });
    return true;
  }

  private aligned() {
    return this.errorM !== null && this.session.visibilityState === "visible" &&
      this.runtime.store.getState().fingerprint === this.fingerprint;
  }

  private begin(sample: Sample) {
    if (!this.aligned()) return;
    this.sample = sample;
    this.pointMode = this.preferredPointMode ?? (this.aim.available ? "aim" : "touch");
    this.describeSampling();
  }

  private describeSampling() {
    const point = this.sample?.kind === "measurement" ? this.sample.a ? "point B" : "point A"
      : this.sample?.kind === "move_position" ? "the object's placement point on its support"
        : this.sample?.kind === "move_heading" ? "a point at least 15 cm in the object's forward direction" : "the physical reference";
    this.notice = this.aiming ? `Aim at ${point} from where you stand. Confirm the orange point.`
      : `Touch ${point} with the tracked probe or fingertip, then confirm.`;
  }

  private clearSample(): void {
    this.sample = null;
    this.aim.reset();
    this.display.showHit(null);
  }
  private cancelSample = (): void => {
    this.clearSample();
    this.notice = "";
  };

  private updateGeometry(geometry: RoomSurveyGeometry) {
    this.captureErrorM = Math.max(this.captureErrorM ?? 0, this.errorM ?? 0);
    this.geometry = geometry;
    this.saved = null;
    this.saveCapture = null;
    this.reopenedMoves = [];
    this.reopenedObservations = [];
    this.discrepancies = [];
    this.selectedDiscrepancy = null;
    this.renderGeometry();
  }

  private renderGeometry() {
    this.extent = surveyExtent(this.geometry, this.room);
    this.display.showGeometry(this.geometry, this.extent.bounds);
  }

  private async task(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.notice = "Working…";
    try { await action(); }
    catch (error) {
      if (this.alive) this.notice = error instanceof Error ? error.message : "The survey request failed.";
    } finally { this.busy = false; }
  }

  private async saveReference() {
    if (!this.aligned()) return;
    if (!this.geometry.surfaces.length && !this.geometry.measurements.length) {
      this.notice = "Preview detected geometry or mark at least one physical point.";
      return;
    }
    return this.task(async () => {
      await this.persistReference();
      if (this.alive) this.notice = "Room reference saved.";
    });
  }

  private async persistReference() {
    if (this.saved) return this.saved;
    this.saveCapture ??= {
      requestId: crypto.randomUUID(), fingerprint: this.fingerprint,
      floorId: this.room.floorId, roomId: this.room.id, registrationErrorM: this.captureErrorM ?? this.errorM!,
      geometry: this.geometry,
    };
    if (new TextEncoder().encode(JSON.stringify(this.saveCapture)).byteLength > MAX_ROOM_SURVEY_BODY_BYTES)
      throw new Error("This preview exceeds the upload limit. Choose the bounded preview.");
    const result = await saveRoomSurvey(this.runtime.base, this.saveCapture);
    if (this.alive) this.saved = result;
    return result;
  }

  private async listReferences(more = false) {
    return this.task(async () => {
      const page = await listRoomSurveys(this.runtime.base, this.room.id, more ? this.referencesCursor ?? undefined : undefined);
      if (!this.alive) return;
      this.references = more ? [...this.references, ...page.items] : page.items;
      this.referencesCursor = page.nextCursor;
      this.page = "references";
      this.notice = this.references.length ? "Choose a reference to reopen." : "No saved references for this room.";
    });
  }

  private async openReference(reference: RoomSurveySummary) {
    if (reference.fingerprint !== this.fingerprint) {
      this.notice = "This survey was captured against a different model revision. Review it in House.";
      return;
    }
    return this.task(async () => {
      const [saved, geometry] = await Promise.all([
        getRoomSurvey(this.runtime.base, reference.id),
        getRoomSurveyGeometry(this.runtime.base, reference.id),
      ]);
      if (!this.alive) return;
      this.saved = saved;
      this.captureErrorM = saved.registrationErrorM;
      this.saveCapture = null;
      this.reopenedMoves = saved.moves;
      this.reopenedObservations = saved.observations;
      this.discrepancies = [];
      this.selectedDiscrepancy = null;
      this.geometry = geometry;
      this.chosen = null;
      this.draft = null;
      this.move = null;
      this.observationRequest = null;
      this.display.compare(null);
      this.renderGeometry();
      this.page = "saved";
      this.notice = "Saved geometry shown as a translucent room reference.";
    });
  }

  private async loadTargets() {
    this.page = "targets";
    const belongs = (item: Placement | Furnishing) => item.floorId === this.room.floorId &&
      (item.roomId === this.room.id || (item.roomId === null && pointInFootprint(item.position[0], item.position[2], this.room.footprint)));
    const equipment: Target[] = this.runtime.store.getState().placements.filter(belongs).map((item) => ({ kind: "equipment", item }));
    this.targets = equipment;
    return this.task(async () => {
      const response = await fetch(`${this.runtime.base}/furnishings`, { cache: "no-store" });
      if (!response.ok) throw new Error("Furniture list unavailable. Equipment can still be reviewed.");
      const { furnishings } = await response.json() as { furnishings: Furnishing[] };
      if (!this.alive) return;
      this.targets = [...equipment, ...furnishings.filter(belongs).map((item): Target => ({ kind: "furnishing", item }))]
        .sort((a, b) => a.item.name.localeCompare(b.item.name));
      this.notice = this.targets.length ? "Choose the model object you want to correct." : "There are no placed objects in this room.";
    });
  }

  private selectTarget(target: Target) {
    this.chosen = target;
    this.draft = null;
    this.move = null;
    this.page = "move";
    const { item } = target;
    this.display.compare({ position: item.position, yawDeg: item.rotationYDeg }, undefined, this.shape());
    this.notice = "Amber shows the recorded pose. Mark the corresponding physical placement point.";
  }

  private shape() {
    if (!this.chosen) return undefined;
    if (this.chosen.kind === "equipment") return equipmentPreviewShape(this.chosen.item);
    const { kind, widthM, heightM, depthM } = this.chosen.item;
    return { geometry: furnishingGeometry(kind), scale: new THREE.Vector3(widthM, heightM, depthM) };
  }

  private proposedPose(): RoomSurveyPose | undefined {
    return this.draft ? { position: this.draft.sample.position,
      yawDeg: this.draft.sample.yawDeg ?? this.draft.before.yawDeg } : undefined;
  }

  private showDraft() {
    if (this.draft) this.display.compare(this.draft.before, this.proposedPose(), this.shape());
  }

  private async saveMove() {
    if (!this.aligned() || !this.saved || !this.draft) return;
    const { id } = this.saved;
    const draft = this.draft;
    return this.task(async () => {
      const move = await proposeRoomSurveyMove(this.runtime.base, id, draft);
      if (!this.alive) return;
      this.showMove(move);
      this.notice = move.applyBlockedReason ? BLOCKED_MOVE : "Move saved for review.";
    });
  }

  private showMove(move: RoomSurveyMove) {
    this.move = move;
    this.reopenedMoves = [...this.reopenedMoves.filter((m) => m.id !== move.id), move];
    this.page = "move";
    this.display.compare(move.before, move.after, this.shape());
  }

  private async applyOrUndo(move: RoomSurveyMove, mode: "apply" | "undo") {
    const survey = this.saved;
    if (!this.aligned() || !survey || survey.id !== move.surveyId) return;
    return this.task(async () => {
      const updated = await reviewRoomSurveyMove(this.runtime, survey, move, mode);
      if (this.alive) {
        this.showMove(updated);
        this.notice = mode === "apply" ? "Measured move applied. You can undo it here." : "Original pose restored.";
      }
    });
  }

  private async saveObservation() {
    const pending = this.observationRequest;
    if (!this.aligned() || !pending) return;
    return this.task(async () => {
      const { surveyId, ...input } = pending;
      await recordRoomSurveyObservation(this.runtime.base, surveyId, input);
      if (!this.alive) return;
      this.observationRequest = null;
      this.notice = "Pending model fix saved. Add details from Model fixes.";
      this.page = "main";
    });
  }

  private get hasScan() {
    return this.geometry.surfaces.some(({ source }) => source === "plane" || source === "mesh");
  }

  private async reviewDiscrepancies() {
    if (!this.aligned() || !this.hasScan) return;
    const index = this.runtime.index;
    if (!index) { this.notice = "Wait for the room model to load."; return; }
    this.discrepancyHome = this.page === "saved" ? "saved" : "main";
    this.display.compare(null);
    this.page = "discrepancies";
    return this.task(async () => {
      const response = await fetch(`${this.runtime.base}/furnishings`, { cache: "no-store" }).catch(() => null);
      if (!this.alive || !this.aligned()) return;
      const { furnishings } = response?.ok ? await response.json() as { furnishings: Furnishing[] } : { furnishings: [] };
      if (!this.alive || !this.aligned()) return;
      const recorded = this.reopenedObservations.flatMap(({ comparison, position, fixId }) =>
        comparison ? [{ comparison, position, fixId, requestId: fixId }] : []);
      const drafts = suggestSurveyDiscrepancies(this.geometry, this.room,
        modelSurveyFaces(index, this.room.id, this.runtime.store.getState().explode),
        furnishings.filter((item) => item.floorId === this.room.floorId && (item.roomId === this.room.id ||
          (item.roomId === null && pointInFootprint(item.position[0], item.position[2], this.room.footprint)))),
        this.captureErrorM ?? this.errorM!);
      const previous = this.discrepancies;
      this.discrepancies = [...recorded, ...drafts.filter(({ comparison: { target } }) =>
        !recorded.some(({ comparison }) => comparison.target.kind === target.kind && comparison.target.id === target.id))
        .map((draft) => ({ ...draft, requestId: previous.find(({ comparison }) =>
          comparison.target.kind === draft.comparison.target.kind && comparison.target.id === draft.comparison.target.id)?.requestId ?? crypto.randomUUID() }))];
      this.notice = this.discrepancies.length ? "Choose an outline pair to review." : "No clear discrepancies in the available scan.";
    });
  }

  private openDiscrepancy(review: DiscrepancyReview) {
    if (!this.aligned()) return;
    this.selectedDiscrepancy = review;
    this.page = "discrepancy";
    this.notice = review.fixId ? "Linked to a model fix." : "";
    this.display.showDiscrepancy(review.comparison);
  }

  private async saveDiscrepancy(review: DiscrepancyReview) {
    if (!this.aligned() || review.fixId) return;
    return this.task(async () => {
      const saved = await this.persistReference();
      if (!this.alive) return;
      if (!this.aligned()) {
        this.notice = "Room reference saved. Verify alignment to continue reviewing.";
        return;
      }
      const result = await recordRoomSurveyObservation(this.runtime.base, saved.id, {
        kind: "discrepancy", requestId: review.requestId, comparison: review.comparison, position: review.position,
      });
      if (!this.alive) return;
      review.fixId = result.fixId;
      this.reopenedObservations = [...this.reopenedObservations, result];
      this.notice = "Pending model fix saved with the scan and comparison outlines.";
    });
  }

  menu(): PanelPage {
    const { room, notice, sample } = this;
    const registration = this.errorM === null ? "" : `Registration ${(this.errorM * 100).toFixed(1)} cm`;
    const lines = [notice, registration].filter(Boolean);
    const home = back(() => this.home());
    const reviewScan = { label: "Review scan discrepancies", act: () => void this.reviewDiscrepancies() };
    if (this.openingRoomSetup) return { title: `Survey · ${room.name}`, lines: ["Complete headset room setup, then return to the survey."], rows: [] };
    if (this.busy) return { title: `Survey · ${room.name}`, lines, rows: [] };
    if (sample) return {
      title: sample.kind === "measurement" ? MEASURE_KINDS[sample.measure] : `Survey · ${room.name}`,
      lines, back: this.cancelSample, rows: [
        ...(this.aiming || this.aim.available ? [{
          label: this.aiming ? "Use touch instead" : "Aim from here",
          act: () => {
            this.pointMode = this.aiming ? "touch" : "aim";
            this.preferredPointMode = this.pointMode;
            this.aim.reset();
            this.describeSampling();
          },
        }] : []),
        { label: "Cancel point capture", act: this.cancelSample },
      ],
    };
    if (this.page === "measure") return {
      title: "Measure the room", lines, rows: [
        ...Object.entries(MEASURE_KINDS).map(([kind, label]) => ({ label, act: () => this.begin({ kind: "measurement", measure: kind as MeasureKind }) })),
        { label: "Mark a physical point", act: () => this.begin({ kind: "point" }) },
        home,
      ],
    };
    if (this.page === "references") return {
      title: "Saved room references", lines, rows: [
        ...this.references.map((ref) => ({ label: `${dateLabel(ref.capturedAtMs)} · ${ref.statistics.pointCount} points`, act: () => void this.openReference(ref) })),
        ...(this.referencesCursor ? [{ label: "Load older references", act: () => void this.listReferences(true) }] : []), home,
      ],
    };
    if (this.page === "saved") return {
      title: "Saved survey preview", lines: [...lines, this.extentLabel(), this.countLabel()],
      rows: [
        ...(this.hasScan ? [reviewScan] : []),
        ...this.reopenedMoves.map((move) => ({ label: `${move.target.name} · ${move.status}`, act: () => { this.chosen = null; this.showMove(move); } })),
        { label: "Correct another object", act: () => void this.loadTargets() }, home,
      ],
    };
    if (this.page === "discrepancies") {
      const leave = () => { this.page = this.discrepancyHome; this.notice = ""; };
      return { title: "Scan discrepancies", lines, back: leave, rows: [
        ...this.discrepancies.map((review) => ({ label: review.comparison.label,
          detail: review.fixId ? "Linked model fix" : `${(review.comparison.offsetM * 100).toFixed(1)} cm offset`,
          act: () => this.openDiscrepancy(review) })),
        { label: "Back to survey", act: leave },
      ] };
    }
    if (this.page === "discrepancy" && this.selectedDiscrepancy) {
      const review = this.selectedDiscrepancy;
      const { label, offsetM, scanUncertaintyM, target } = review.comparison;
      const leave = () => { this.page = "discrepancies"; this.notice = ""; this.display.compare(null); };
      return { title: label, back: leave, lines: [
        `${(offsetM * 100).toFixed(1)} cm ${target.kind === "surface" ? "surface" : "footprint"} offset`,
        `Capture alignment ${((this.captureErrorM ?? this.errorM ?? 0) * 100).toFixed(1)} cm · scan fit ±${(scanUncertaintyM * 100).toFixed(1)} cm`,
        "Blue scan outline · amber modeled outline", notice,
      ].filter(Boolean), rows: [
        ...(review.fixId ? [] : [{ label: "Save as pending model fix", detail: this.saved ? "Attach this comparison" : "Save room reference and attach comparison",
          act: () => void this.saveDiscrepancy(review) }]),
        { label: "Back to suggestions", act: leave },
      ] };
    }
    if (this.page === "targets") return {
      title: "Choose an existing object", lines, rows: [
        ...this.targets.map((target) => ({ label: target.item.name, act: () => this.selectTarget(target) })), home,
      ],
    };
    if (this.page === "move") return this.moveMenu(lines, home);
    if (this.page === "observation") return {
      title: "Record an observation", lines, rows: [
        ...(this.observationRequest ? [{ label: "Save as pending model fix", act: () => void this.saveObservation() }] : this.saved ? [
          { label: "Mark structure", act: () => this.begin({ kind: "observation", observation: "structure" }) },
          { label: "Mark a new object", act: () => this.begin({ kind: "observation", observation: "new_object" }) },
        ] : [{ label: "Save a room reference first", act: () => void this.saveReference() }]),
        home,
      ],
    };
    return {
      title: `Survey · ${room.name}`,
      lines: [...lines, this.extentLabel(), this.countLabel()].filter(Boolean),
      rows: [
        { label: "Preview full headset room / scene", act: () => this.planPreview("full") },
        { label: "Preview bounded, simplified room", act: () => this.planPreview("bounded") },
        ...(this.hasScan ? [reviewScan] : []),
        ...(this.canOpenRoomSetup() ? [{ label: "Open headset room setup", act: () => void this.openRoomSetup() }] : []),
        { label: "Measure or mark points", act: () => { this.page = "measure"; this.notice = ""; } },
        { label: this.saved ? "Room reference saved" : "Save the preview as a room reference",
          act: this.saved ? undefined : () => void this.saveReference() },
        { label: "Saved room references", act: () => void this.listReferences() },
        { label: "Correct an existing object", act: () => void this.loadTargets() },
        { label: "Record structure or a new object", act: () => { this.page = "observation"; this.notice = ""; } },
      ],
    };
  }

  private planPreview(scope: SensorScope) {
    if (!this.aligned()) return;
    this.plannedPreview = scope;
    this.notice = "Reading available room geometry…";
  }

  home() {
    if (this.busy) return;
    this.page = "main";
    this.clearSample();
    this.display.compare(null);
    this.notice = "";
  }

  private extentLabel() {
    const { size, adjoining, sources } = this.extent;
    if (!sources.size) return "Preview room geometry or measure manually.";
    const dimensions = [size.x, size.y, size.z].map((v) => v.toFixed(1)).join(" × ");
    return `${dimensions} m · ${adjoining ? "Includes adjoining space" : "Within room"} · ${[...sources].join(", ")}`;
  }

  private countLabel() {
    if (!this.geometry.surfaces.length && !this.geometry.measurements.length) return "";
    const coverage = this.geometry.scope === "full" ? "Full scene" : this.geometry.scope === "manual" ? "Manual" : "Bounded";
    let vertices = 0, triangles = 0, points = 0;
    for (const surface of this.geometry.surfaces) {
      if (surface.source === "plane" || surface.source === "mesh") vertices += surface.points.length;
      else points += surface.points.length;
      triangles += (surface.indices?.length ?? 0) / 3;
    }
    const labels = [coverage];
    if (vertices) labels.push(`${vertices} vertices`, `${triangles} mesh ${triangles === 1 ? "triangle" : "triangles"}`);
    if (points) labels.push(`${points} marked ${points === 1 ? "point" : "points"}`);
    const measurements = this.geometry.measurements.length;
    if (measurements) labels.push(`${measurements} ${measurements === 1 ? "measurement" : "measurements"}`);
    return labels.join(" · ");
  }

  private moveMenu(lines: string[], home: PanelRow): PanelPage {
    const { move, draft, chosen } = this;
    if (move) {
      lines.push(`${move.displacementCm.toFixed(1)} cm · ${move.headingChangeDeg.toFixed(1)}° · residual ${(move.registrationErrorM * 100).toFixed(1)} cm`);
      if (move.applyBlockedReason) lines.push(BLOCKED_MOVE);
      return {
        title: move.target.name, lines,
        rows: [
          ...(move.status === "applied" ? [{ label: "Undo measured move", act: () => void this.applyOrUndo(move, "undo") }]
            : move.status === "proposed" && !move.applyBlockedReason ? [{ label: "Apply measured move", act: () => void this.applyOrUndo(move, "apply") }] : []),
          { label: "Choose another object", act: () => void this.loadTargets() }, home,
        ],
      };
    }
    const after = this.proposedPose();
    if (draft && after) lines.push(`${(surveyDistanceM(draft.before.position, after.position) * 100).toFixed(1)} cm · ${surveyHeadingChange(draft.before.yawDeg, after.yawDeg).toFixed(1)}° · amber original, green proposed`);
    return {
      title: chosen?.item.name ?? "Compare model placement", lines, rows: [
        { label: draft ? "Mark position again" : "Mark the physical position", act: () => this.begin({ kind: "move_position" }) },
        ...(draft ? [
          { label: "Mark optional heading", act: () => this.begin({ kind: "move_heading" }) },
          ...(this.saved ? [
            { label: "Save as pending move", act: () => void this.saveMove() },
          ] : [{ label: "Mark and save a room reference first", act: () => {
            if (!this.geometry.surfaces.length && !this.geometry.measurements.length)
              this.recordPoint(draft.sample.position, this.draftPointSource);
            void this.saveReference();
          } }]),
        ] : []),
        home,
      ],
    };
  }

  dispose() {
    this.alive = false;
    this.clearSample();
    this.display.dispose();
  }
}
