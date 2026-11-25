import { z } from "zod";
import { ALL_LAYERS } from "./model/types";
import type { RoomSurveyObservation } from "./roomSurveyTypes";

const spatial = z.number().min(-100_000).max(100_000);
const vector = z.tuple([spatial, spatial, spatial]);
const unit = z.number().min(-1.001).max(1.001);
const id = z.string().min(1).max(240);
const selection = z.strictObject({
  kind: z.enum(["room", "surface", "element", "floor", "building", "equipment", "route", "routePoint", "annotation"]),
  id,
});

export const modelFixMode = z.enum(["desktop", "vr", "mr"]);
export const modelFixStatus = z.enum(["pending", "resolved"]);
export const modelFixFingerprint = z.string().regex(/^[0-9a-f]{8,64}$/);
export const modelFixResolution = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("model_revision"), fingerprint: modelFixFingerprint }),
  z.strictObject({ kind: z.literal("route_change"), note: z.string().trim().min(1).max(1000) }),
]);

export const modelFixViewpoint = z.strictObject({
  mode: modelFixMode,
  camera: z.strictObject({
    position: vector,
    target: vector,
    projection: z.enum(["perspective", "ortho"]),
    zoom: z.number().positive().max(1000).optional(),
    quaternion: z.tuple([unit, unit, unit, unit]).optional(),
  }),
  view: z.strictObject({
    activeFloorId: id.nullable().optional(),
    viewMode: z.enum(["overview", "floor", "plan", "section"]).optional(),
    wallMode: z.enum(["cut", "contextual", "up", "closed"]).optional(),
    wallModeExplicit: z.boolean().optional(),
    roofVisible: z.boolean().optional(),
    ceilingsVisible: z.boolean().optional(),
    edgesVisible: z.boolean().optional(),
    layers: z.partialRecord(z.enum(ALL_LAYERS), z.boolean()).optional(),
    visibleRouteKinds: z.partialRecord(z.enum(["duct", "pipe", "cable", "valve", "outlet", "switch", "junction", "access-point", "other"]), z.boolean()).optional(),
    visibleSystems: z.partialRecord(z.enum(["ventilation", "water", "electrical", "network", "heating", "drainage", "other"]), z.boolean()).optional(),
    activeRoutesOnly: z.boolean().optional(),
    cut: z.strictObject({
      enabled: z.boolean(),
      y: spatial,
      vertical: z.strictObject({ axis: z.enum(["x", "z"]), v: spatial, sign: z.union([z.literal(1), z.literal(-1)]) }).nullable(),
    }).optional(),
    explode: z.strictObject({ enabled: z.boolean(), gap: z.number().min(0).max(100) }).optional(),
    selection: selection.nullable().optional(),
    focusSelection: selection.nullable().optional(),
    renovationDate: z.iso.date().nullable().optional(),
  }).optional(),
  overlay: z.enum(["pipes", "ducts", "both"]).optional(),
  context: z.strictObject({ floorId: id.nullable().optional(), roomId: id.nullable().optional() }).optional(),
}).refine((value) => value.overlay === undefined || value.mode === "mr", {
  path: ["overlay"],
  message: "An overlay filter applies to mixed reality captures.",
}).refine(({ camera }) => camera.position.some((value, i) => value !== camera.target[i]), {
  path: ["camera", "target"],
  message: "The camera position and target must differ.",
});

export const modelFixPatch = z.strictObject({
  expectedUpdatedAtMs: z.number().int().nonnegative(),
  description: z.string().trim().max(4000).optional(),
  status: modelFixStatus.optional(),
  resolution: modelFixResolution.optional(),
}).refine((value) => value.description !== undefined || value.status !== undefined || value.resolution !== undefined);

export const modelFixListInput = z.strictObject({
  status: modelFixStatus.optional(),
  modelId: id.optional(),
  cursor: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export type ModelFixViewpoint = z.infer<typeof modelFixViewpoint>;
export type ModelFixPatch = z.infer<typeof modelFixPatch>;
export type ModelFixStatus = z.infer<typeof modelFixStatus>;
export type ModelFixMode = z.infer<typeof modelFixMode>;
export type ModelFixResolution = z.infer<typeof modelFixResolution>;

export interface ModelFixSummary {
  id: string;
  modelId: string;
  description: string;
  status: ModelFixStatus;
  mode: ModelFixMode;
  createdAtMs: number;
  updatedAtMs: number;
  resolvedAtMs: number | null;
}

interface ScreenshotMeta {
  id: string;
  capturedAtMs: number;
  imageCount: number;
}

export interface ModelFixViewScreenshot extends ScreenshotMeta {
  fingerprint: string;
  viewpoint: ModelFixViewpoint;
  content: "house_view" | "vr_scene" | "ar_overlay_only";
}

export interface ModelFixQuestScreenshot extends ScreenshotMeta {
  fingerprint: null;
  viewpoint: null;
  content: "quest_system_screenshot";
}

export type ModelFixScreenshot = ModelFixViewScreenshot | ModelFixQuestScreenshot;

export interface ModelFix extends ModelFixSummary {
  resolution: ModelFixResolution | null;
  screenshots: ModelFixScreenshot[];
  surveyObservation?: RoomSurveyObservation;
}

export interface ModelFixCapture {
  fingerprint: string;
  viewpoint: ModelFixViewpoint;
  images: Blob[];
}

export const MAX_MODEL_FIX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MODEL_FIX_SCREENSHOTS = 12;
