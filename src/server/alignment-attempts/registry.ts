import "server-only";
import { and, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { z } from "zod";
import { readTx, writeTx, type Db } from "@/db/client";
import { alignmentAttempt as row, modelRevision as model } from "@/db/schema";
import { alignmentAttemptInput, MAX_ALIGNMENT_ATTEMPT_BYTES, type alignmentAttemptListInput,
  type AlignmentAttemptDetail, type AlignmentAttemptSummary } from "@/house/alignmentAttemptTypes";
import { badRequest, conflict, HttpError, notFound } from "@/server/api/handler";
import { ALIGNMENT_ATTEMPT_RETENTION_MS } from "./retention";

const MAX_PER_USER = 60;
const summary = {
  id: row.id, userId: row.userId, modelId: model.modelId, fingerprint: model.contentHash, modelStatus: model.status,
  mode: row.mode, revision: row.revision, status: row.status, roomId: row.roomId, startedAtMs: row.startedAtMs,
  elapsedMs: row.elapsedMs, receivedAtMs: row.receivedAtMs,
};
const identity = (actor: string, id: string) => and(eq(row.userId, actor), eq(row.id, id));

export function storeAlignmentAttempt(db: Db, actor: string, modelId: string, raw: unknown, now = Date.now()) {
  const attempt = alignmentAttemptInput.parse(raw);
  if (attempt.userId !== actor) throw new HttpError(403, "alignment_account_changed");
  if (attempt.startedAtMs <= now - ALIGNMENT_ATTEMPT_RETENTION_MS) throw new HttpError(410, "alignment_attempt_expired");
  if (attempt.startedAtMs > now + 86_400_000) throw badRequest("alignment_start_in_future");
  if (Buffer.byteLength(JSON.stringify(attempt)) > MAX_ALIGNMENT_ATTEMPT_BYTES) throw new HttpError(413, "alignment_attempt_too_large");
  const { id, revision, startedAtMs, elapsedMs, mode, status, roomId, features, events, snapshots } = attempt;
  const evidence = { features, events, snapshots };
  return writeTx(db, tx => {
    // Queued evidence can arrive after a model update. Bind it to its actual served revision.
    const pkg = tx.select({ id: model.id }).from(model).where(and(eq(model.modelId, modelId),
      eq(model.contentHash, attempt.fingerprint), inArray(model.status, ["current", "superseded"]))).get();
    if (!pkg) throw conflict("alignment_unknown_model_revision");
    const existing = tx.select().from(row).where(identity(actor, id)).get();
    if (existing) {
      if (existing.modelRevisionId !== pkg.id || existing.startedAtMs !== startedAtMs || existing.mode !== mode)
        throw conflict("alignment_session_identity_changed");
      if (existing.revision === revision && (existing.elapsedMs !== elapsedMs || existing.status !== status ||
        existing.roomId !== roomId || JSON.stringify(existing.evidence) !== JSON.stringify(evidence)))
        throw conflict("alignment_revision_reused");
      if (existing.revision >= revision) return { id, revision: existing.revision };
      if (elapsedMs < existing.elapsedMs) throw conflict("alignment_elapsed_time_regressed");
      tx.update(row).set({ revision, status, roomId, elapsedMs, evidence, receivedAtMs: now }).where(identity(actor, id)).run();
    } else {
      // Clock order, including its UUID tie-break, also prevents a late evicted retry from evicting newer work.
      const oldest = tx.select({ id: row.id, at: row.startedAtMs }).from(row).where(eq(row.userId, actor))
        .orderBy(desc(row.startedAtMs), desc(row.id)).offset(MAX_PER_USER - 1).limit(1).get();
      if (oldest && (startedAtMs < oldest.at || (startedAtMs === oldest.at && id <= oldest.id)))
        throw new HttpError(410, "alignment_attempt_expired");
      if (oldest) tx.delete(row).where(identity(actor, oldest.id)).run();
      tx.insert(row).values({ id, userId: actor, revision, modelRevisionId: pkg.id, startedAtMs,
        elapsedMs, receivedAtMs: now, mode, status, roomId, evidence }).run();
    }
    return { id, revision };
  });
}

export function getAlignmentAttempt(db: Db, actor: string, id: string, modelId?: string, now = Date.now()): AlignmentAttemptDetail {
  const found = db.select({ ...summary, evidence: row.evidence }).from(row).innerJoin(model, eq(model.id, row.modelRevisionId))
    .where(and(identity(actor, id), gt(row.startedAtMs, now - ALIGNMENT_ATTEMPT_RETENTION_MS),
      modelId === undefined ? undefined : eq(model.modelId, modelId))).get();
  if (!found) throw notFound("unknown_alignment_attempt");
  const { evidence, ...rest } = found;
  return { ...rest, ...evidence };
}

export function listAlignmentAttempts(db: Db, actor: string, input: z.infer<typeof alignmentAttemptListInput>, now = Date.now()):
  { items: AlignmentAttemptSummary[]; nextCursor: string | null } {
  return readTx(db, tx => {
    const where = and(eq(row.userId, actor), gt(row.startedAtMs, now - ALIGNMENT_ATTEMPT_RETENTION_MS),
      input.modelId === undefined ? undefined : eq(model.modelId, input.modelId),
      input.roomId === undefined ? undefined : eq(row.roomId, input.roomId));
    const cursor = input.cursor ? tx.select({ id: row.id, at: row.startedAtMs }).from(row).innerJoin(model, eq(model.id, row.modelRevisionId))
      .where(and(where, eq(row.id, input.cursor))).get() : undefined;
    if (input.cursor && !cursor) throw badRequest("invalid_cursor");
    const rows = tx.select(summary).from(row).innerJoin(model, eq(model.id, row.modelRevisionId)).where(and(where,
      cursor && or(lt(row.startedAtMs, cursor.at), and(eq(row.startedAtMs, cursor.at), lt(row.id, cursor.id)))))
      .orderBy(desc(row.startedAtMs), desc(row.id)).limit(input.limit + 1).all();
    const items = rows.slice(0, input.limit);
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null };
  });
}
