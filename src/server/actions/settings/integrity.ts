"use server";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, writeTx, type Db } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment, integrityQuarantine } from "@/db/schema";
import { loadEnv } from "@/env";
import { requireFreshSession } from "@/server/auth/session";
import { revalidatePath } from "next/cache";
import { attachmentStoragePaths, ensureIntegrityDirectory, integrityFilePath, stageRegularFile, sameRegularFile, type StagedIntegrityFile } from "@/server/files/integrityPaths";
import { writeAuditLog, type DomainCtx } from "@/domain/occurrence";
import { systemClock } from "@/domain/time";
import { log } from "@/server/log";

function assertUnreferenced(tx: Db, relative: string): void {
  const rows = tx.select({ storagePath: attachment.storagePath, hasWebCopy: attachment.hasWebCopy }).from(attachment).all();
  if (rows.some((row) => attachmentStoragePaths(row).includes(relative))) {
    throw new Error("An attachment now references this location. Nothing was moved; open its document to inspect it.");
  }
}

function rollbackMove(staged: StagedIntegrityFile | null, operationId: string): void {
  if (!staged) return;
  try { staged.rollback(); }
  catch (error) {
    log.error({ err: error, operationId }, "integrity file rollback needs manual recovery; file bytes preserved");
    throw new Error(`The operation failed and its file needs recovery. No file was overwritten. Keep quarantine entry ${operationId} and contact the system maintainer.`);
  }
}

async function performQuarantine(raw: unknown) {
  const session = await requireFreshSession();
  const relative = z.string().min(1).max(1024).parse(raw);
  const env = loadEnv();
  const dataRoot = fs.realpathSync(env.VH_DATA_DIR);
  const root = integrityFilePath(dataRoot, "attachments");
  const source = integrityFilePath(root, relative);
  const destinationRoot = ensureIntegrityDirectory(dataRoot, "quarantine");
  const id = newId();
  const ctx: DomainCtx = { actorUserId: session.user.id, actorKind: "user", clock: systemClock, tz: env.VH_HOUSEHOLD_TZ };
  const move: { staged: StagedIntegrityFile | null } = { staged: null };
  try {
    writeTx(getDb().db, (tx) => {
      // writeTx can retry SQLITE_BUSY after rolling back its previous transaction.
      move.staged?.rollback(); move.staged = null;
      assertUnreferenced(tx, relative);
      const stat = fs.lstatSync(source);
      // Uploads move bytes before committing attachment metadata. A fresh file is not yet an orphan.
      if (Date.now() - stat.ctimeMs < 60_000) throw new Error("This file was written recently and may still be uploading. Wait a minute, refresh, and check again.");
      tx.insert(integrityQuarantine).values({ id, originalPath: relative, quarantinedAtMs: ctx.clock.now(), actorUserId: session.user.id }).run();
      writeAuditLog(tx, ctx, { entityTable: "integrity_quarantine", entityId: id, action: "quarantined", summary: "Moved an unreferenced attachment file to reversible quarantine" });
      // Recheck both paths under the DB write lock; never follow a substituted symlink.
      move.staged = stageRegularFile(integrityFilePath(root, relative), integrityFilePath(destinationRoot, id));
    });
  } catch (error) {
    rollbackMove(move.staged, id);
    throw error;
  }
  try { move.staged?.finish(); }
  catch (error) {
    log.error({ err: error, operationId: id }, "quarantine journal committed; original cleanup pending");
    throw new Error("A quarantine copy was saved, but the original could not be removed. Restore this entry to keep the original and clean up the extra copy.");
  }
  revalidatePath("/settings/system/integrity");
  return { id };
}

async function performRestore(raw: unknown) {
  const session = await requireFreshSession();
  const id = z.string().uuid().parse(raw);
  const env = loadEnv();
  const dataRoot = fs.realpathSync(env.VH_DATA_DIR);
  const root = ensureIntegrityDirectory(dataRoot, "attachments");
  const sourceRoot = integrityFilePath(dataRoot, "quarantine");
  const ctx: DomainCtx = { actorUserId: session.user.id, actorKind: "user", clock: systemClock, tz: env.VH_HOUSEHOLD_TZ };
  const move: { staged: StagedIntegrityFile | null } = { staged: null };
  try {
    writeTx(getDb().db, (tx) => {
      move.staged?.rollback(); move.staged = null;
      const row = tx.select().from(integrityQuarantine).where(eq(integrityQuarantine.id, id)).get();
      if (!row) throw new Error("This quarantine entry is unavailable.");
      const destination = integrityFilePath(root, row.originalPath);
      const source = integrityFilePath(sourceRoot, id);
      const alreadyInPlace = sameRegularFile(source, destination);
      if (row.restoredAtMs !== null && !fs.lstatSync(source, { throwIfNoEntry: false })) return;
      if (row.restoredAtMs !== null && !alreadyInPlace) throw new Error("The restored file has changed. No file was overwritten or removed.");
      if (!alreadyInPlace) {
        assertUnreferenced(tx, row.originalPath);
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error("A file now exists at the original location. Nothing was overwritten.");
        const parent = path.posix.dirname(row.originalPath);
        if (parent !== ".") ensureIntegrityDirectory(root, parent);
        move.staged = stageRegularFile(integrityFilePath(sourceRoot, id), integrityFilePath(root, row.originalPath));
      }
      tx.update(integrityQuarantine).set({ restoredAtMs: ctx.clock.now() }).where(eq(integrityQuarantine.id, id)).run();
      writeAuditLog(tx, ctx, { entityTable: "integrity_quarantine", entityId: id, action: "restored", summary: "Restored an unreferenced file from quarantine" });
    });
  } catch (error) {
    rollbackMove(move.staged, id);
    throw error;
  }
  try {
    if (move.staged) move.staged.finish();
    else {
      // A prior cleanup failure left two links to the same bytes. The current row was validated above.
      const row = getDb().db.select().from(integrityQuarantine).where(eq(integrityQuarantine.id, id)).get();
      if (row) {
        const source = integrityFilePath(sourceRoot, id), destination = integrityFilePath(root, row.originalPath);
        if (sameRegularFile(source, destination)) fs.unlinkSync(source);
      }
    }
  } catch (error) {
    log.error({ err: error, operationId: id }, "restored file is in place; quarantine copy cleanup pending");
    throw new Error("The file is restored. Its extra quarantine copy could not be removed; use Clean up copy to retry.");
  }
  revalidatePath("/settings/system/integrity");
}

function failureMessage(error: unknown): string {
  if (error instanceof z.ZodError) return "Invalid file or quarantine identifier. Refresh and retry.";
  if (error && typeof error === "object" && "code" in error) return "Storage or the database could not complete the operation. Original file bytes were preserved. Check disk space and permissions, then refresh.";
  return error instanceof Error ? error.message : "Could not move the file. Refresh and check storage.";
}
export async function quarantineOrphan(raw: unknown) {
  try { return { ok: true as const, ...await performQuarantine(raw) }; }
  catch (error) { return { ok: false as const, error: failureMessage(error) }; }
}
export async function restoreQuarantined(raw: unknown) {
  try { await performRestore(raw); return { ok: true as const }; }
  catch (error) { return { ok: false as const, error: failureMessage(error) }; }
}
