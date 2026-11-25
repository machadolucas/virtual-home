import "server-only";
import { createHash } from "node:crypto";
import { and, count, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { attachment, auditLog, modelFix, modelFixScreenshot, modelRevision, roomSurveyObservation } from "@/db/schema";
import {
  MAX_MODEL_FIX_SCREENSHOTS,
  type ModelFix, type ModelFixPatch, type ModelFixScreenshot, type ModelFixSummary,
  type ModelFixViewpoint, type ModelFixViewScreenshot, type modelFixListInput,
} from "@/house/modelFixTypes";
import { badRequest, conflict, notFound } from "@/server/api/handler";
import { prepareScreenshot, registerScreenshot, removeScreenshotFile } from "./screenshotFiles";

type FixRow = typeof modelFix.$inferSelect;
type ListInput = z.output<typeof modelFixListInput>;

function auditFix(tx: Db, actor: string, id: string, action: string, summary: string, atMs: number, requestId?: string) {
  tx.insert(auditLog).values({
    id: newId(), atMs, actorKind: "user", actorUserId: actor, entityTable: "model_fix", entityId: id,
    action, summary, requestId,
  }).run();
}

function summary(row: FixRow): ModelFixSummary {
  const { id, modelId, mode, description, status, createdAtMs, updatedAtMs, resolvedAtMs } = row;
  return { id, modelId, mode, description, status, createdAtMs, updatedAtMs, resolvedAtMs };
}

function findFix(db: Db, id: string, modelId?: string): FixRow {
  const row = db.select().from(modelFix)
    .where(and(eq(modelFix.id, id), modelId === undefined ? undefined : eq(modelFix.modelId, modelId))).get();
  if (!row) throw notFound("unknown_model_fix");
  return row;
}

function screenshotContent(mode: ModelFixViewpoint["mode"]): ModelFixViewScreenshot["content"] {
  if (mode === "mr") return "ar_overlay_only";
  return mode === "vr" ? "vr_scene" : "house_view";
}

export function getModelFix(db: Db, id: string, modelId?: string): ModelFix {
  const row = findFix(db, id, modelId);
  const screenshot = modelFixScreenshot;
  const screenshots = db.select({
    id: screenshot.id, capturedAtMs: screenshot.createdAtMs, fingerprint: modelRevision.contentHash,
    viewpoint: screenshot.viewpoint, secondImageId: screenshot.secondImageId,
  }).from(screenshot).leftJoin(modelRevision, eq(modelRevision.id, screenshot.modelRevisionId))
    .where(eq(screenshot.fixId, id)).orderBy(screenshot.createdAtMs, screenshot.id)
    .limit(MAX_MODEL_FIX_SCREENSHOTS).all().map(({ secondImageId, viewpoint, fingerprint, ...entry }): ModelFixScreenshot => {
      const imageCount = secondImageId ? 2 : 1;
      if (viewpoint && fingerprint)
        return { ...entry, imageCount, viewpoint, fingerprint, content: screenshotContent(viewpoint.mode) };
      return { ...entry, imageCount, viewpoint: null, fingerprint: null, content: "quest_system_screenshot" };
    });
  const linked = db.select({
    fixId: roomSurveyObservation.fixId, surveyId: roomSurveyObservation.surveyId, kind: roomSurveyObservation.kind,
    position: roomSurveyObservation.position, createdAtMs: roomSurveyObservation.createdAtMs,
  }).from(roomSurveyObservation).where(eq(roomSurveyObservation.fixId, id)).get();
  return { ...summary(row), resolution: row.resolution, screenshots, ...(linked ? { surveyObservation: linked } : {}) };
}

export function listModelFixes(db: Db, input: ListInput) {
  const filter = and(
    input.modelId === undefined ? undefined : eq(modelFix.modelId, input.modelId),
    input.status === undefined ? undefined : eq(modelFix.status, input.status),
  );
  const cursor = input.cursor === undefined ? undefined
    : db.select().from(modelFix).where(and(
      input.modelId === undefined ? undefined : eq(modelFix.modelId, input.modelId),
      eq(modelFix.id, input.cursor),
    )).get();
  if (input.cursor !== undefined && !cursor) throw notFound("unknown_model_fix_cursor");
  const rows = db.select().from(modelFix).where(and(filter, cursor && or(
    lt(modelFix.createdAtMs, cursor.createdAtMs),
    and(eq(modelFix.createdAtMs, cursor.createdAtMs), lt(modelFix.id, cursor.id)),
  ))).orderBy(desc(modelFix.createdAtMs), desc(modelFix.id)).limit(input.limit + 1).all();
  const items = rows.slice(0, input.limit).map((row) => summary({ ...row, description: row.description.slice(0, 480) }));
  return { items, nextCursor: rows.length > input.limit ? items.at(-1)?.id ?? null : null };
}

interface ScreenshotWrite {
  modelId: string;
  actor: string;
  requestId: string;
  images: Buffer[];
}

type SaveScreenshot = ScreenshotWrite & ({
  source?: "viewer";
  fixId?: string;
  fingerprint: string;
  viewpoint: ModelFixViewpoint;
} | {
  source: "quest_system";
  fixId: string;
});

/** The screenshot attachment rows and their owning fix commit together. */
export async function saveModelFixScreenshot(db: Db, input: SaveScreenshot): Promise<ModelFix> {
  const screenshot = modelFixScreenshot;
  const { actor, requestId, modelId } = input;
  const viewer = input.source !== "quest_system" ? input : null;
  const source = viewer ? "viewer" : "quest_system";
  const requestHash = createHash("sha256").update(JSON.stringify({
    modelId, fixId: input.fixId ?? null, source, fingerprint: viewer?.fingerprint, viewpoint: viewer?.viewpoint,
    images: input.images.map((image) => createHash("sha256").update(image).digest("hex")),
  })).digest("hex");
  const replay = (tx: Db): string | undefined => {
    const old = tx.select({ fixId: screenshot.fixId, requestHash: screenshot.requestHash }).from(screenshot)
      .where(and(eq(screenshot.createdBy, actor), eq(screenshot.requestId, requestId))).get();
    if (old && old.requestHash !== requestHash) throw conflict("model_fix_request_reused");
    return old?.fixId;
  };
  const revision = (tx: Db) => {
    if (!viewer) return null;
    const current = tx.select({ id: modelRevision.id, fingerprint: modelRevision.contentHash }).from(modelRevision)
      .where(and(eq(modelRevision.modelId, modelId), eq(modelRevision.status, "current"))).get();
    if (!current) throw notFound("unknown_model");
    if (current.fingerprint !== viewer.fingerprint) throw conflict("stale_fingerprint", { fingerprint: current.fingerprint });
    return current.id;
  };
  const ensureTarget = (tx: Db) => {
    if (!input.fixId) return undefined;
    const fix = findFix(tx, input.fixId, modelId);
    const total = tx.select({ value: count() }).from(screenshot).where(eq(screenshot.fixId, fix.id)).get()?.value ?? 0;
    if (total >= MAX_MODEL_FIX_SCREENSHOTS) throw conflict("model_fix_screenshot_limit");
    return fix;
  };

  const old = replay(db);
  if (old) return getModelFix(db, old, modelId);
  revision(db);
  ensureTarget(db);
  const at = nowMs();
  const prepared: Awaited<ReturnType<typeof prepareScreenshot>>[] = [];
  let committed = new Set<string>();
  try {
    for (const bytes of input.images) prepared.push(await prepareScreenshot(bytes, actor, at));
    const result = writeTx(db, (tx) => {
      const duplicate = replay(tx);
      if (duplicate) return { fix: getModelFix(tx, duplicate, modelId), committed: new Set<string>() };
      const modelRevisionId = revision(tx);
      const target = ensureTarget(tx);
      const fixId = target?.id ?? newId();
      const timestamp = Math.max(at, (target?.updatedAtMs ?? 0) + 1);
      if (target) tx.update(modelFix).set({ updatedAtMs: timestamp, updatedBy: actor }).where(eq(modelFix.id, fixId)).run();
      else {
        if (!viewer) throw notFound("unknown_model_fix");
        tx.insert(modelFix).values({
          id: fixId, modelId, mode: viewer.viewpoint.mode, description: "", status: "pending",
          createdAtMs: timestamp, updatedAtMs: timestamp, createdBy: actor, updatedBy: actor,
        }).run();
      }
      const [imageId, secondImageId] = prepared.map((file) => registerScreenshot(tx, file));
      if (!imageId) throw new Error("A model fix screenshot requires an image");
      tx.insert(screenshot).values({
        id: newId(), fixId, source, modelRevisionId, viewpoint: viewer?.viewpoint, imageId, secondImageId,
        requestId, requestHash, createdAtMs: timestamp, createdBy: actor,
      }).run();
      auditFix(tx, actor, fixId, target ? "screenshot_added" : "created",
        target ? "Added a model fix screenshot" : "Captured a model fix", timestamp, requestId);
      return { fix: getModelFix(tx, fixId, modelId), committed: new Set([imageId, ...(secondImageId ? [secondImageId] : [])]) };
    });
    committed = result.committed;
    return result.fix;
  } finally {
    for (const file of prepared) if (!committed.has(file.row.id)) await removeScreenshotFile(file.file);
  }
}

export function updateModelFix(db: Db, modelId: string, id: string, actor: string, patch: ModelFixPatch): ModelFix {
  return writeTx(db, (tx) => {
    const current = findFix(tx, id, modelId);
    if (current.updatedAtMs !== patch.expectedUpdatedAtMs) throw conflict("model_fix_changed");
    const at = Math.max(nowMs(), current.updatedAtMs + 1);
    const status = patch.status ?? current.status;
    const resolution = status === "resolved" ? patch.resolution ?? current.resolution : null;
    if (status === "resolved" && !resolution) throw badRequest("model_fix_resolution_required");
    if (status === "pending" && patch.resolution) throw badRequest("model_fix_resolution_requires_resolved_status");
    if (resolution?.kind === "model_revision") {
      const verified = tx.select({ id: modelRevision.id }).from(modelRevision).where(and(
        eq(modelRevision.modelId, current.modelId), eq(modelRevision.contentHash, resolution.fingerprint),
      )).get();
      if (!verified) throw badRequest("model_fix_resolution_unknown_revision");
    }
    tx.update(modelFix).set({
      description: patch.description ?? current.description,
      status,
      resolvedAtMs: status === "resolved" ? current.resolvedAtMs ?? at : null,
      resolution,
      updatedAtMs: at,
      updatedBy: actor,
    }).where(eq(modelFix.id, id)).run();
    auditFix(tx, actor, id, status === current.status ? "updated" : status,
      status === current.status ? "Updated the model fix description" : `Marked the model fix ${status}`, at);
    return getModelFix(tx, id, modelId);
  });
}

export function getModelFixImage(db: Db, fixId: string, screenshotId: string, index: number, modelId?: string) {
  findFix(db, fixId, modelId);
  const screenshot = modelFixScreenshot;
  const row = db.select({ image: attachment, mode: screenshot.viewpoint }).from(screenshot)
    .innerJoin(attachment, eq(attachment.id, index === 0 ? screenshot.imageId : screenshot.secondImageId))
    .where(and(eq(screenshot.id, screenshotId), eq(screenshot.fixId, fixId))).get();
  if (!row) throw notFound("unknown_model_fix_image");
  return { image: row.image, content: row.mode ? screenshotContent(row.mode.mode) : "quest_system_screenshot" as const };
}
