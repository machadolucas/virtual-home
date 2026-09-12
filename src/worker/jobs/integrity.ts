/**
 * The nightly integrity check: the two places this schema can drift, because SQLite cannot
 * declare either constraint.
 *
 *  1. **Attachments.** Blobs live on disk, metadata lives in `attachment`. A restore from a
 *     backup taken mid-upload, or a hand-edited data directory, can leave a row without a file
 *     (a 404 in the UI) or a file without a row (dead bytes nobody will ever delete).
 *  2. **`project_link`.** A polymorphic link the service layer validates on insert and nothing
 *     validates afterwards — §infrastructure.ts explicitly defers this to "a nightly integrity
 *     job reports dangling links into `app_alert`". This is that job.
 *
 * It **reports, never repairs**: deleting a row because its file is missing is exactly the wrong
 * move when the real cause is an unmounted disk. Both findings become one `app_alert` each
 * (de-duplicated by `dedupe_key`, so a persistent problem does not become a wall of alerts), and
 * a clean pass resolves the alert it raised.
 *
 * Deliberately simple: this household's tables are small enough to read whole. If they ever are
 * not, the fix is a `NOT EXISTS` query, not a cleverer traversal here.
 */
import { and, eq, isNull } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { attachment } from "@/db/schema/attachments";
import { asset, system } from "@/db/schema/assets";
import { infraRoute, projectLink } from "@/db/schema/infrastructure";
import { appAlert, part } from "@/db/schema/inventory";
import { completion, maintenanceOccurrence, serviceDocument } from "@/db/schema/maintenance";
import { location } from "@/db/schema/model";
import { raiseAppAlert } from "@/domain/notify/alerts";
import type { DomainCtx } from "@/domain/occurrence";
import type { Clock } from "@/domain/time";
import { log } from "@/server/log";
import { attachmentStoragePaths, integrityFilePath } from "@/server/files/integrityPaths";
import { startIntervalJob, type Job } from "./interval";

/** Nightly. Started with a long first delay so a restart storm does not stat the disk repeatedly. */
export const INTEGRITY_INTERVAL_MS = 24 * 3_600_000;

export const ALERT_ATTACHMENTS_DEDUPE = "integrity:attachments";
export const ALERT_PROJECT_LINKS_DEDUPE = "integrity:project_links";

export interface IntegrityInput {
  handle: DbHandle;
  clock: Clock;
  /** Household time zone, for the alert's audit context. */
  tz: string;
  /** `$VH_DATA_DIR/attachments`. */
  attachDir: string;
  /** Skip the filesystem half (tests that only care about links). */
  checkFiles?: boolean;
  /** Read-only interactive report; does not raise or resolve alerts. */
  reportOnly?: boolean;
}

export interface IntegrityResult {
  attachmentsChecked: number;
  /** A storage scan failed; never present a partial scan as a clean pass. */
  storageError: string | null;
  /** `attachment` rows whose file is not on disk. */
  missingFiles: string[];
  /** Files under `attachDir` no `attachment` row references. */
  orphanFiles: string[];
  projectLinksChecked: number;
  /** `project_link` rows whose target row is gone. */
  danglingLinks: string[];
  alertIds: string[];
}

/** Absolute path of a stored relative path, or `null` when it would escape `attachDir`. */
function resolveInside(root: string, relPath: string): string | null {
  try { return integrityFilePath(root, relPath); } catch { return null; }
}

/** Every file under `dir`, as paths relative to it with POSIX separators. */
function listFiles(dir: string): string[] {
  const root = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!root) return [];
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Storage must be a real directory, not a symbolic link.");
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = path.relative(dir, entry.parentPath);
    out.push(parent === "" ? entry.name : `${parent}/${entry.name}`.split(path.sep).join("/"));
  }
  return out;
}

/** `project_link.entity_kind` → the table its `entity_id` must exist in. */
function targetIdsFor(tx: Db, kind: string): Set<string> | null {
  const ids = (rows: { id: string }[]): Set<string> => new Set(rows.map((row) => row.id));
  switch (kind) {
    case "asset":
      return ids(tx.select({ id: asset.id }).from(asset).all());
    case "location":
      return ids(tx.select({ id: location.id }).from(location).all());
    case "system":
      return ids(tx.select({ id: system.id }).from(system).all());
    case "occurrence":
      return ids(
        tx.select({ id: maintenanceOccurrence.id }).from(maintenanceOccurrence).all(),
      );
    case "completion":
      return ids(tx.select({ id: completion.id }).from(completion).all());
    case "service_document":
      return ids(tx.select({ id: serviceDocument.id }).from(serviceDocument).all());
    case "part":
      return ids(tx.select({ id: part.id }).from(part).all());
    case "infra_route":
      return ids(tx.select({ id: infraRoute.id }).from(infraRoute).all());
    default:
      // An entity kind this job does not know about: report nothing rather than guess.
      return null;
  }
}

/** Resolve an alert this job raised, now that the condition is gone. */
function resolveAlert(handle: DbHandle, dedupeKey: string, atMs: number): void {
  writeTx(handle.db, (tx) => {
    tx.update(appAlert)
      .set({ resolvedAtMs: atMs })
      .where(and(eq(appAlert.dedupeKey, dedupeKey), isNull(appAlert.resolvedAtMs)))
      .run();
  });
}

/** One integrity pass. Never throws for ordinary trouble; a findings list is the output. */
export function runIntegrityCheck(input: IntegrityInput): IntegrityResult {
  const { handle, clock } = input;
  const now = clock.now();
  const ctx: DomainCtx = { clock, tz: input.tz, actorUserId: null, actorKind: "worker" };

  const result: IntegrityResult = {
    attachmentsChecked: 0,
    storageError: null,
    missingFiles: [],
    orphanFiles: [],
    projectLinksChecked: 0,
    danglingLinks: [],
    alertIds: [],
  };

  /* -------------------------------------------------------------- attachments */

  if (input.checkFiles !== false) {
    const rows = handle.db
      .select({
        id: attachment.id,
        storagePath: attachment.storagePath,
        hasWebCopy: attachment.hasWebCopy,
      })
      .from(attachment)
      .all();
    result.attachmentsChecked = rows.length;

    const expected = new Set<string>();
    try {
      for (const row of rows) {
        const names = attachmentStoragePaths(row);
        for (const name of names) expected.add(name);
        if (names.some((name) => {
          const absolute = resolveInside(input.attachDir, name);
          return absolute === null || !fs.lstatSync(absolute, { throwIfNoEntry: false })?.isFile();
        })) result.missingFiles.push(row.id);
      }
      for (const relPath of listFiles(input.attachDir)) {
        if (!expected.has(relPath)) result.orphanFiles.push(relPath);
      }
    } catch {
      result.storageError = "Attachment storage could not be fully checked. Check the volume, directory permissions and symbolic links.";
    }

    if (!input.reportOnly && (result.storageError !== null || result.missingFiles.length > 0 || result.orphanFiles.length > 0)) {
      const id = writeTx(handle.db, (tx) =>
        raiseAppAlert(tx, ctx, {
          kind: "integrity",
          severity: "warning",
          title: "Attachment storage does not match the database",
          body:
            (result.storageError ? `${result.storageError} ` : "") +
            `${result.missingFiles.length} attachment row(s) have a missing or invalid original/derivative file; ` +
            `${result.orphanFiles.length} file(s) under the attachments directory have no row. ` +
            "Nothing was deleted.",
          dedupeKey: ALERT_ATTACHMENTS_DEDUPE,
          entityTable: "attachment",
        }),
      );
      result.alertIds.push(id);
    } else if (!input.reportOnly) {
      resolveAlert(handle, ALERT_ATTACHMENTS_DEDUPE, now);
    }
  }

  /* ------------------------------------------------------------- project links */

  const links = handle.db
    .select({
      id: projectLink.id,
      entityKind: projectLink.entityKind,
      entityId: projectLink.entityId,
    })
    .from(projectLink)
    .all();
  result.projectLinksChecked = links.length;

  if (links.length > 0) {
    const cache = new Map<string, Set<string> | null>();
    for (const link of links) {
      if (!cache.has(link.entityKind)) {
        cache.set(link.entityKind, targetIdsFor(handle.db, link.entityKind));
      }
      const ids = cache.get(link.entityKind) ?? null;
      if (ids === null) continue;
      if (!ids.has(link.entityId)) result.danglingLinks.push(link.id);
    }
  }

  if (!input.reportOnly && result.danglingLinks.length > 0) {
    const id = writeTx(handle.db, (tx) =>
      raiseAppAlert(tx, ctx, {
        kind: "integrity",
        severity: "warning",
        title: "Project links point at rows that no longer exist",
        body: `${result.danglingLinks.length} project_link row(s) are dangling. Nothing was deleted.`,
        dedupeKey: ALERT_PROJECT_LINKS_DEDUPE,
        entityTable: "project_link",
      }),
    );
    result.alertIds.push(id);
  } else if (!input.reportOnly) {
    resolveAlert(handle, ALERT_PROJECT_LINKS_DEDUPE, now);
  }

  return result;
}

export interface IntegrityJobOptions extends IntegrityInput {
  intervalMs?: number;
  logger?: Pick<typeof log, "debug" | "info" | "warn">;
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export function startIntegrityJob(options: IntegrityJobOptions): Job {
  const logger = options.logger ?? log;
  return startIntervalJob({
    name: "integrity",
    intervalMs: options.intervalMs ?? INTEGRITY_INTERVAL_MS,
    run: () => {
      const result = runIntegrityCheck(options);
      const findings = result.missingFiles.length + result.orphanFiles.length + result.danglingLinks.length + (result.storageError ? 1 : 0);
      if (findings > 0) {
        logger.warn(
          {
            storageError: result.storageError,
            missingFiles: result.missingFiles.length,
            orphanFiles: result.orphanFiles.length,
            danglingLinks: result.danglingLinks.length,
          },
          "integrity check found problems",
        );
      } else {
        logger.debug(
          {
            attachments: result.attachmentsChecked,
            projectLinks: result.projectLinksChecked,
          },
          "integrity check clean",
        );
      }
    },
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.setTimeoutFn ? { setTimeoutFn: options.setTimeoutFn } : {}),
    ...(options.clearTimeoutFn ? { clearTimeoutFn: options.clearTimeoutFn } : {}),
  });
}
