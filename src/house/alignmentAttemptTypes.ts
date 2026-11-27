import { z } from "zod";

export const MAX_ALIGNMENT_ATTEMPT_BYTES = 192 * 1024;
const id = z.string().min(1).max(240);
const coord = z.number().min(-100_000).max(100_000);
const length = z.number().min(0).max(200_000);
const count = z.int().min(0).max(1_000_000);
const offset = z.int().min(0).max(7 * 86_400_000);
const pair = z.tuple([coord, coord]);
const triple = z.tuple([coord, coord, coord]);
const code = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const wall = z.strictObject({ a: pair, b: pair, low: coord, high: coord,
  semanticWall: z.boolean().optional(), baseOnly: z.boolean().optional() });
const diagnosis = z.strictObject({
  stage: z.enum(["evidence", "fit", "check", "heading", "verified"]), reason: code,
  candidateCount: count, bestCheckM: length.nullable(), floorY: coord.nullable(),
  fittedPairs: count, independentChecks: count, bestTraceGapM: length.nullable(),
  measuredWalls: count, taggedWalls: count, openings: count, traces: count, directionalFamilies: count,
  outline: z.strictObject({ basis: z.enum(["checked", "hypothesis"]), plausiblePoses: count, maxDeviationM: length.nullable(),
    walls: z.array(z.strictObject({ wallIndex: count, outlineGapM: length, nearestAngleDeg: z.number().min(0).max(180).nullable(),
      measuredSupport: z.boolean(), traceSupport: z.boolean() })).max(12) }).nullable(),
});
const snapshot = z.strictObject({
  atMs: offset, space: count, roomId: id.nullable(), viewer: triple,
  selectedRoom: z.boolean().optional(),
  traceFloor: z.strictObject({ y: coord, measured: z.boolean() }).optional(),
  wallPairs: z.array(z.strictObject({ trace: count, wall: count })).max(4).optional(),
  detections: z.strictObject({ planes: count.nullable(), meshes: count.nullable(),
    labels: z.strictObject({ wall: count, door: count, window: count, floor: count, object: count, other: count }) }).optional(),
  floor: z.strictObject({ y: coord, outline: z.array(pair).max(128), source: z.enum(["plane", "mesh", "bounds"]).optional(),
    semanticFloor: z.boolean().optional(), confirmedHeight: z.boolean().optional() }).nullable(),
  walls: z.array(wall).max(72), traces: z.array(wall).max(20),
  landmarks: z.array(z.strictObject({ kind: z.enum(["door", "window"]), center: triple, rawCenter: triple.optional(),
    axis: pair.optional(), width: length, height: length, elementId: id.optional() })).max(24),
  diagnosis: diagnosis.nullable(),
});
const event = z.strictObject({
  atMs: offset, kind: code, detail: z.string().max(320),
  measurement: z.strictObject({space:count, roomId:id, featureId:id, modeled:triple, observed:triple}).optional(),
});
export const alignmentAttemptInput = z.strictObject({
  id: z.uuid(), userId: id, fingerprint: z.string().regex(/^[0-9a-f]{8,64}$/),
  revision: z.int().min(1).max(2_147_483_647), startedAtMs: z.int().positive(), elapsedMs: offset,
  mode: z.enum(["mr", "survey"]), status: z.enum(["aligning", "aligned", "ended", "interrupted"]),
  roomId: id.nullable(), features: z.array(code).max(32), events: z.array(event).max(48), snapshots: z.array(snapshot).max(4),
}).refine(r => [...r.events, ...r.snapshots].every(item => item.atMs <= r.elapsedMs),
  { message: "Observation time exceeds session duration" });
export const alignmentAttemptListInput = z.strictObject({ modelId: id.optional(), roomId: id.optional(), cursor: z.uuid().optional(),
  limit: z.int().min(1).max(50).default(12) });
export type AlignmentDiagnosis = z.infer<typeof diagnosis>;
export type AlignmentAttemptSnapshot = z.infer<typeof snapshot>;
export type AlignmentAttemptEvent = z.infer<typeof event>;
export type AlignmentAttempt = z.infer<typeof alignmentAttemptInput>;
export interface AlignmentAttemptSummary extends Omit<AlignmentAttempt, "features" | "events" | "snapshots"> {
  modelId: string;
  modelStatus: "imported" | "current" | "superseded";
  receivedAtMs: number;
}
export type AlignmentAttemptDetail = AlignmentAttempt & AlignmentAttemptSummary;
