import { z } from "zod";
import { modelFixFingerprint } from "./modelFixTypes";
import { ringBBox } from "./model/geometry2d";
import type { Room, Vec3 } from "./model/types";

export const MAX_ROOM_SURVEY_BODY_BYTES = 12 * 1024 * 1024;
export const MAX_ROOM_SURVEY_SURFACES = 160;
export const MAX_ROOM_SURVEY_POINTS = 150_000;
export const MAX_ROOM_SURVEY_INDICES = 450_000;
export const MAX_ROOM_SURVEY_MEASUREMENTS = 100;
export const MAX_ROOM_SURVEY_RESIDUAL_M = 0.05;
export const MAX_ROOM_SURVEY_MOVES = 40;
export const MAX_ROOM_SURVEY_OBSERVATIONS = 40;

const scalar = z.number().min(-100_000).max(100_000);
const vec = z.tuple([scalar, scalar, scalar]);
const semanticId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).max(240);
const yaw = z.number().min(-3600).max(3600);
const requestId = z.uuid();
const residual = z.number().min(0).max(MAX_ROOM_SURVEY_RESIDUAL_M);
const source = z.enum(["plane", "mesh", "hit-test", "manual"]);
const scope = z.enum(["full", "bounded", "manual"]);
const geometrySurface = z.strictObject({
  source,
  label: z.string().trim().min(1).max(100).optional(),
  orientation: z.enum(["horizontal", "vertical"]).optional(),
  points: z.array(vec).min(1).max(MAX_ROOM_SURVEY_POINTS),
  indices: z.array(z.number().int().nonnegative()).min(3).max(MAX_ROOM_SURVEY_INDICES).optional(),
}).refine((surface) => {
  if (surface.indices) {
    if (surface.indices.length % 3 !== 0 || surface.indices.some((index) => index >= surface.points.length)) return false;
  }
  if (surface.source === "mesh") return surface.indices !== undefined;
  return surface.source !== "plane" || surface.points.length >= 3;
}, "Surface indices must refer to complete triangles.");

const measurement = z.strictObject({
  kind: z.enum(["distance", "ceiling_height", "opening_width", "opening_height"]),
  a: vec,
  b: vec,
}).refine(({ a, b }) => a.some((value, index) => value !== b[index]), "Choose two distinct points.");

export const roomSurveyGeometry = z.strictObject({
  scope: scope.optional(),
  surfaces: z.array(geometrySurface).max(MAX_ROOM_SURVEY_SURFACES),
  measurements: z.array(measurement).max(MAX_ROOM_SURVEY_MEASUREMENTS),
}).refine((value) => value.surfaces.length + value.measurements.length > 0, "Capture some room geometry or measurements.")
  .refine((value) => value.surfaces.reduce((count, surface) => count + surface.points.length, 0) <= MAX_ROOM_SURVEY_POINTS &&
    value.surfaces.reduce((count, surface) => count + (surface.indices?.length ?? 0), 0) <= MAX_ROOM_SURVEY_INDICES,
  "Room survey geometry exceeds its point or index limit.")
  .refine((value) => value.scope !== "full" || value.surfaces.some((surface) => surface.source === "plane" || surface.source === "mesh"),
    "Full captures require headset-provided planes or meshes.");

export const roomSurveyCapture = z.strictObject({
  requestId,
  fingerprint: modelFixFingerprint,
  floorId: semanticId,
  roomId: semanticId,
  registrationErrorM: residual,
  geometry: roomSurveyGeometry,
});

export const roomSurveyMoveInput = z.strictObject({
  requestId,
  target: z.strictObject({ kind: z.enum(["equipment", "furnishing"]), id: semanticId }),
  before: z.strictObject({ position: vec, yawDeg: yaw }),
  sample: z.strictObject({ position: vec, yawDeg: yaw.optional() }),
  registrationErrorM: residual,
});

const manualObservation = z.strictObject({
  requestId,
  kind: z.enum(["structure", "new_object"]),
  position: vec,
  description: z.string().trim().min(1).max(4000),
});

const outline = z.array(vec).min(3).max(12);
export const roomSurveyComparison = z.strictObject({
  target: z.strictObject({ kind: z.enum(["surface", "furnishing"]), id: semanticId }),
  label: z.string().trim().min(1).max(240),
  sourceSurface: z.number().int().min(0).max(MAX_ROOM_SURVEY_SURFACES - 1),
  scanOutline: outline,
  modelOutline: outline,
  offsetM: z.number().positive().max(0.5),
  scanUncertaintyM: z.number().min(0).max(0.25),
});
export const roomSurveyObservationInput = z.union([
  manualObservation,
  z.strictObject({ requestId, kind: z.literal("discrepancy"), position: vec, comparison: roomSurveyComparison }),
]);

export const roomSurveyListInput = z.strictObject({
  modelId: semanticId.optional(),
  roomId: semanticId.optional(),
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(40).default(20),
});

export const roomSurveyGeometryPageInput = z.strictObject({
  id: z.uuid(),
  surface: z.number().int().nonnegative().max(MAX_ROOM_SURVEY_SURFACES - 1),
  section: z.enum(["points", "indices"]).default("points"),
  offset: z.number().int().nonnegative().max(MAX_ROOM_SURVEY_INDICES).default(0),
  limit: z.number().int().min(1).max(300).default(120),
});

export type RoomSurveyGeometry = z.infer<typeof roomSurveyGeometry>;
export type RoomSurveySurface = RoomSurveyGeometry["surfaces"][number];
export type RoomSurveyMeasurement = RoomSurveyGeometry["measurements"][number];
export type RoomSurveyCapture = z.infer<typeof roomSurveyCapture>;
export type RoomSurveyMoveInput = z.infer<typeof roomSurveyMoveInput>;
export type RoomSurveyObservationInput = z.infer<typeof roomSurveyObservationInput>;
export type RoomSurveyComparison = z.infer<typeof roomSurveyComparison>;
export type StoredRoomSurveyComparison = RoomSurveyComparison & { registrationErrorM: number };
export type RoomSurveyScope = z.infer<typeof scope>;
export type RoomSurveySurfaceSummary = Pick<RoomSurveySurface, "source" | "label" | "orientation"> & {
  pointCount: number;
  indexCount: number;
};
export interface RoomSurveyGeometryMetadata {
  scope?: RoomSurveyScope;
  surfaces: RoomSurveySurfaceSummary[];
  measurements: RoomSurveyMeasurement[];
}

export interface RoomSurveyStatistics {
  extent: { min: Vec3; max: Vec3 };
  includesAdjoining: boolean;
  scope: RoomSurveyScope;
  sources: Partial<Record<RoomSurveySurface["source"], number>>;
  pointCount: number;
  triangleCount: number;
  measurementCount: number;
}

export interface RoomSurveySummary {
  id: string;
  modelId: string;
  fingerprint: string;
  floorId: string;
  roomId: string;
  roomName: string;
  registrationErrorM: number;
  capturedAtMs: number;
  statistics: RoomSurveyStatistics;
}

export interface RoomSurveyPose {
  position: Vec3;
  yawDeg: number;
}

export interface RoomSurveyMove {
  id: string;
  surveyId: string;
  target: RoomSurveyMoveInput["target"] & { name: string };
  before: RoomSurveyPose;
  after: RoomSurveyPose;
  registrationErrorM: number;
  applyBlockedReason: "surface_support_unverified" | null;
  displacementCm: number;
  headingChangeDeg: number;
  status: "proposed" | "applied" | "undone";
  createdAtMs: number;
  appliedAtMs: number | null;
  undoneAtMs: number | null;
}

export interface RoomSurveyObservation {
  fixId: string;
  surveyId: string;
  kind: RoomSurveyObservationInput["kind"];
  position: Vec3;
  createdAtMs: number;
  comparison?: StoredRoomSurveyComparison;
}

export interface RoomSurvey extends RoomSurveySummary {
  moves: RoomSurveyMove[];
  observations: RoomSurveyObservation[];
  surfaces: RoomSurveySurfaceSummary[];
  measurements: Array<RoomSurveyMeasurement & { lengthM: number }>;
}

export interface RoomSurveyPage {
  items: RoomSurveySummary[];
  nextCursor: string | null;
}

export function surveyDistanceM(a: readonly number[], b: readonly number[]) {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

export function roomSurveyBounds(room: Room): { min: Vec3; max: Vec3 } {
  const adjoiningBufferM = 0.8;
  const { minX, maxX, minZ, maxZ } = ringBBox(room.footprint.outer);
  return {
    min: [minX - adjoiningBufferM, room.floorElevation - 0.15, minZ - adjoiningBufferM],
    max: [maxX + adjoiningBufferM, room.floorElevation + (room.ceilingHeight ?? 2.7) + 0.35, maxZ + adjoiningBufferM],
  };
}

export function surveyMeasurementLengthM({ kind, a, b }: RoomSurveyMeasurement) {
  if (kind === "ceiling_height" || kind === "opening_height") return Math.abs(b[1] - a[1]);
  if (kind === "opening_width") return Math.hypot(b[0] - a[0], b[2] - a[2]);
  return surveyDistanceM(a, b);
}

export function surveyHeadingChange(before: number, after: number) {
  return ((after - before + 180) % 360 + 360) % 360 - 180;
}
