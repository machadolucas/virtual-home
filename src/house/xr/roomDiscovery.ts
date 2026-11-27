import { Vector3 } from "three";
import { pointInFootprint } from "../model/geometry2d";
import type { Room, Vec2 } from "../model/types";
import {
  matchRoomAlignment,
  roomPoseDrift,
  trackedFloorHeightAllowed,
  uniqueRoomAlignment,
  type AlignmentCandidate,
  type AlignmentModel,
  type AlignmentWall,
  type RoomEvidence,
} from "./roomAlignment";
import { floorEdges, outlinesAgree, type Edge } from "./roomOutline";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";
import { confirmsRecessedFloor } from "./distinctiveRoom";

export interface RoomDiscoveryChoice {
  room: Room;
  candidates: readonly AlignmentCandidate[];
  orientation: AlignmentCandidate | null;
  sameExtent: boolean;
}

export interface RoomDiscoveryState {
  phase: "waiting" | "checking" | "confirming" | "ambiguous" | "recognized" | "unmatched";
  options: readonly RoomDiscoveryChoice[];
  match: RoomDiscoveryChoice | null;
}


type Extent = "same" | "different" | "unknown";
type NativeEvidence = RoomEvidence & { floor: NonNullable<RoomEvidence["floor"]> };
interface Pass {
  evidence: NativeEvidence;
  viewer: Vector3;
  capturedAtMs: number;
  next: number;
  unavailable: boolean;
  contradicted: boolean;
  options: RoomDiscoveryChoice[];
  proofs: Map<string, AlignmentCandidate[]>;
}
interface Corroboration {
  choice: RoomDiscoveryChoice;
  proofs: AlignmentCandidate[];
  capturedAtMs: number;
}

const EXTENT_LIMIT_M = MAX_CALIBRATION_ERROR_M + 1e-8;
const MIN_PASS_GAP_MS = 350;
const MAX_PASS_GAP_MS = 6_000;
const MAX_ROOMS_PER_STEP = 2;
const SOFT_STEP_BUDGET_MS = 2.5;
const WALL_ALIGN = Math.cos((3 * Math.PI) / 180);

function enclosingWall([a, b]: Edge, observed: readonly AlignmentWall[], nativeOutline: boolean): boolean {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    span = Math.hypot(dx, dz);
  const x = dx / span,
    z = dz / span;
  const station = (p: Vec2) => (p[0] - a[0]) * x + (p[1] - a[1]) * z;
  const offset = (p: Vec2) => Math.abs((p[0] - a[0]) * z - (p[1] - a[1]) * x);
  // Mesh floors use convex hulls. Only actual adjoining wall endpoints may certify their extent.
  const overhang = nativeOutline ? 0.3 : 0.1;
  const intervals = observed
    .flatMap((wall) => {
      const p = wall.b[0] - wall.a[0],
        q = wall.b[1] - wall.a[1],
        size = Math.hypot(p, q);
      if (
        size < 0.1 ||
        Math.abs((p * x + q * z) / size) < WALL_ALIGN ||
        offset(wall.a) > EXTENT_LIMIT_M ||
        offset(wall.b) > EXTENT_LIMIT_M
      )
        return [];
      const sa = station(wall.a),
        sb = station(wall.b),
        lo = Math.min(sa, sb),
        hi = Math.max(sa, sb);
      return hi > 0 && lo < span && lo >= -overhang && hi <= span + overhang ? [{ lo, hi }] : [];
    })
    .sort((a, b) => a.lo - b.lo);
  const join = nativeOutline ? Math.min(0.16, span * 0.12) : EXTENT_LIMIT_M;
  let covered = 0;
  for (const { lo, hi } of intervals) {
    if (lo > covered + join) break;
    covered = Math.max(covered, hi);
    if (covered >= span - join) return true;
  }
  return false;
}

function extentOf(model: AlignmentModel, evidence: NativeEvidence, candidate: AlignmentCandidate): Extent {
  const { footprint, floorElevation, ceilingHeight } = model.room;
  const p = new Vector3();
  const transformed = footprint.outer.map(([x, z]): Vec2 => {
    p.set(x, floorElevation, z).applyMatrix4(candidate.fit.matrix);
    return [p.x, p.z];
  });
  const nativeOutline = evidence.floor.source === "plane";
  if (nativeOutline && !outlinesAgree(transformed, evidence.floor.outline)) return "different";
  if (footprint.holes?.length) return "unknown";
  const minHeight = Math.min(1.2, (ceilingHeight ?? 2.6) * 0.65);
  const observed = evidence.walls.filter(
    (wall) =>
      !wall.baseOnly &&
      wall.high - wall.low >= minHeight &&
      Math.abs(wall.low - evidence.floor.y) <= (nativeOutline ? 0.35 : EXTENT_LIMIT_M),
  );
  const perimeter = floorEdges(transformed).filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.1);
  let checked = 0, perimeterM = 0, unmeasuredM = 0;
  for (const edge of perimeter) {
    const [a, b] = edge, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    perimeterM += length;
    if (enclosingWall(edge, observed, nativeOutline)) { checked++; continue; }
    // Door reveals and short returns can be present in the measured floor outline but
    // too narrow to be classified as separate wall faces (minimum wall span 28 cm).
    if (!nativeOutline || length >= .28) return "unknown";
    unmeasuredM += length;
  }
  return checked >= 3 && unmeasuredM <= Math.min(1, perimeterM * .08) ? "same" : "unknown";
}

function posesAgree(room: Room, a: AlignmentCandidate, b: AlignmentCandidate): boolean {
  return roomPoseDrift(room, a.fit.matrix, b.fit.matrix) <= EXTENT_LIMIT_M;
}

function isNative(evidence: RoomEvidence, viewer: Vector3): evidence is NativeEvidence {
  const { floor } = evidence;
  return (
    (floor?.source === "plane" || floor?.source === "mesh") &&
    trackedFloorHeightAllowed(floor.y, floor.semanticFloor) &&
    floor.outline.length >= 3 &&
    floor.outline.length <= 128 &&
    [viewer.x, viewer.y, viewer.z].every(Number.isFinite) &&
    pointInFootprint(viewer.x, viewer.z, { outer: floor.outline }) &&
    evidence.walls.filter((wall) => !wall.baseOnly).length >= 2
  );
}

const idle = (phase: RoomDiscoveryState["phase"]): RoomDiscoveryState => ({
  phase,
  options: [],
  match: null,
});

/** Each pass keeps a single scan and only publishes results after every eligible room has been considered. */
export class RoomDiscovery {
  private result: RoomDiscoveryState = idle("waiting");
  private pass: Pass | null = null;
  private prior: Corroboration | null = null;
  private lastEvidence: RoomEvidence | null = null;
  private lastCapturedAtMs = -Infinity;

  constructor(
    private readonly rooms: readonly Room[],
    private readonly modelFor: (room: Room) => AlignmentModel | null,
  ) {}

  get state(): RoomDiscoveryState {
    return this.result;
  }

  submit(evidence: RoomEvidence, viewer: Vector3, capturedAtMs: number): boolean {
    if (
      this.pass ||
      this.result.match ||
      evidence === this.lastEvidence ||
      !Number.isFinite(capturedAtMs) ||
      capturedAtMs - this.lastCapturedAtMs < MIN_PASS_GAP_MS
    )
      return false;
    this.lastCapturedAtMs = capturedAtMs;
    this.lastEvidence = evidence;
    if (!isNative(evidence, viewer)) {
      this.prior = null;
      this.result = idle("unmatched");
      return false;
    }
    this.pass = {
      evidence: {
        floor: { ...evidence.floor, outline: evidence.floor.outline.map(([x, z]) => [x, z]) },
        walls: evidence.walls
          .filter((wall) => !wall.baseOnly)
          .map((wall) => ({ ...wall, a: [...wall.a], b: [...wall.b] })),
        landmarks: evidence.landmarks.map((mark) => ({ ...mark, center: [...mark.center] })),
      },
      viewer: viewer.clone(),
      capturedAtMs,
      next: 0,
      unavailable: false,
      contradicted: false,
      options: [],
      proofs: new Map(),
    };
    this.result = idle("checking");
    return true;
  }

  step(currentViewer?: Vector3): RoomDiscoveryState {
    const pass = this.pass;
    if (!pass) return this.result;
    const start = performance.now();
    let checked = 0;
    while (
      pass.next < this.rooms.length &&
      checked < MAX_ROOMS_PER_STEP &&
      (checked === 0 || performance.now() - start < SOFT_STEP_BUDGET_MS)
    ) {
      const room = this.rooms[pass.next++]!;
      checked++;
      if (room.kind === "void") continue;
      const model = this.modelFor(room);
      if (!model) {
        pass.unavailable = true;
        continue;
      }
      const shaped = matchRoomAlignment(model, pass.evidence, pass.viewer)
        .map((candidate) => ({ candidate, extent: extentOf(model, pass.evidence, candidate) }))
        .filter(({ extent }) => extent !== "different");
      const plausible = shaped.filter(({ candidate }) => !candidate.landmarkConflict);
      if (shaped.length && !plausible.length) pass.contradicted = true;
      if (plausible.length) {
        const candidates = plausible.map(({ candidate }) => candidate);
        const proofs = plausible
          .filter(({ extent }) => extent === "same")
          .map(({ candidate }) => candidate);
        if (!proofs.length && shaped.length === 1 && confirmsRecessedFloor(model, pass.evidence, pass.viewer, candidates[0]!))
          proofs.push(candidates[0]!);
        pass.proofs.set(room.id, proofs);
        pass.options.push({
          room,
          candidates,
          orientation: uniqueRoomAlignment(shaped.map(({ candidate }) => candidate)),
          sameExtent: !!proofs.length,
        });
      }
    }
    if (pass.next === this.rooms.length) this.complete(pass, currentViewer);
    return this.result;
  }

  private complete(pass: Pass, currentViewer?: Vector3) {
    this.pass = null;
    const options = pass.options;
    const choice = options[0];
    const proofs = choice && pass.proofs.get(choice.room.id);
    if (
      options.length !== 1 ||
      !choice ||
      !proofs?.length ||
      pass.unavailable ||
      (pass.contradicted && !proofs.some(({ landmarkCount }) => landmarkCount > 0))
    ) {
      this.prior = null;
      this.result = { phase: options.length ? "ambiguous" : "unmatched", options, match: null };
      return;
    }
    const viewerStillInRoom =
      !currentViewer ||
      (currentViewer.distanceTo(pass.viewer) <= 0.45 &&
        proofs.some(({ fit }) => {
          const p = currentViewer.clone().applyMatrix4(fit.matrix.clone().invert());
          return pointInFootprint(p.x, p.z, choice.room.footprint);
        }));
    if (!viewerStillInRoom) {
      this.prior = null;
      this.result = idle("waiting");
      return;
    }
    const first = this.prior;
    this.prior = { choice, proofs, capturedAtMs: pass.capturedAtMs };
    if (
      !first ||
      first.choice.room.id !== choice.room.id ||
      first.choice.room.floorId !== choice.room.floorId ||
      pass.capturedAtMs - first.capturedAtMs > MAX_PASS_GAP_MS ||
      !first.proofs.some((a) => proofs.some((b) => posesAgree(choice.room, a, b)))
    ) {
      this.result = { phase: "confirming", options, match: null };
      return;
    }
    // Two passes can agree on room identity while still leaving multiple orientations.
    const a = first.choice.orientation,
      b = choice.orientation;
    const orientation =
      a && b && first.proofs.includes(a) && proofs.includes(b) && posesAgree(choice.room, a, b) ? b : null;
    const match = { ...choice, orientation };
    this.result = { phase: "recognized", options: [match], match };
  }

  reset(): void {
    this.pass = null;
    this.prior = null;
    this.lastEvidence = null;
    this.lastCapturedAtMs = -Infinity;
    this.result = idle("waiting");
  }
}
