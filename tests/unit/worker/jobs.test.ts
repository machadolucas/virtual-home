/**
 * The four background jobs.
 *
 * The invariant that matters for all of them: **they only ever delete transport, cache or
 * telemetry, and only when it is old.** A reaper with an off-by-one on its cutoff would quietly
 * delete a household's session, its replay window, or its own history — so every test here checks
 * both halves: the old row is gone *and* the fresh one is still there.
 *
 * The integrity job is the exception: it reports and never repairs, so its test asserts that a
 * missing file produces an alert and not a delete.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment } from "@/db/schema/attachments";
import { session } from "@/db/schema/auth";
import { INTEGRATION_STATUS_HA_ID, integrationStatus } from "@/db/schema/ha";
import { project, projectLink } from "@/db/schema/infrastructure";
import { appAlert } from "@/db/schema/inventory";
import { workerHeartbeat } from "@/db/schema/notifications";
import { eventOutbox, idempotencyKey, processMetric } from "@/db/schema/system";
import { EVENT_TOPICS, publishNow, readCursorSeq } from "@/server/events/outbox";
import {
  WORKER_HEARTBEAT_NAME,
  startHeartbeatJob,
  writeWorkerHeartbeat,
} from "@/worker/jobs/heartbeat";
import {
  IDEMPOTENCY_RETENTION_MS,
  OUTBOX_RETENTION_MS,
  runHousekeeping,
} from "@/worker/jobs/housekeeping";
import {
  ALERT_ATTACHMENTS_DEDUPE,
  ALERT_PROJECT_LINKS_DEDUPE,
  runIntegrityCheck,
} from "@/worker/jobs/integrity";
import { pruneProcessMetrics, startMetricsJob, writeProcessMetric } from "@/worker/jobs/metrics";
import { fakeClock, DAY_MS, HOUR_MS, MINUTE_MS } from "../../helpers/clock";
import { seedUser, testDb } from "../../helpers/db";

const NOW = Date.parse("2027-03-01T12:00:00Z");

let handle: DbHandle | null = null;
let tempDirs: string[] = [];

beforeEach(() => {
  handle = testDb();
});

afterEach(() => {
  handle?.close();
  handle = null;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  vi.useRealTimers();
});

function db(): DbHandle {
  if (!handle) throw new Error("no test database");
  return handle;
}

/* -------------------------------------------------------------- housekeeping */

describe("housekeeping", () => {
  function seedOutbox(atMs: number): void {
    publishNow(db(), [
      { topic: EVENT_TOPICS.taskChanged, entityKey: `k-${atMs}`, payload: { atMs }, atMs },
    ]);
  }

  function seedIdempotency(createdAtMs: number): string {
    const key = `key-${createdAtMs}`;
    writeTx(db().db, (tx) => {
      tx.insert(idempotencyKey).values({ key, responseJson: "{}", createdAtMs }).run();
    });
    return key;
  }

  function seedSession(userId: string, expiresAtMs: number): string {
    const id = newId();
    writeTx(db().db, (tx) => {
      tx.insert(session)
        .values({
          id,
          token: `tok-${id}`,
          userId,
          expiresAt: new Date(expiresAtMs),
          createdAt: new Date(expiresAtMs - DAY_MS),
          updatedAt: new Date(expiresAtMs - DAY_MS),
        })
        .run();
    });
    return id;
  }

  it("deletes only the rows that are past their retention", () => {
    const user = seedUser(db(), { username: "lucas", name: "Lucas" });

    // Outbox: 10 minutes is the retention, so 11 minutes ago goes and 9 stays.
    seedOutbox(NOW - OUTBOX_RETENTION_MS - MINUTE_MS);
    seedOutbox(NOW - OUTBOX_RETENTION_MS + MINUTE_MS);
    // Idempotency keys: 24 h.
    const oldKey = seedIdempotency(NOW - IDEMPOTENCY_RETENTION_MS - HOUR_MS);
    const freshKey = seedIdempotency(NOW - HOUR_MS);
    // Sessions: expiry, not age.
    const expired = seedSession(user.id, NOW - MINUTE_MS);
    const live = seedSession(user.id, NOW + DAY_MS);

    const cursorBefore = readCursorSeq(db().db);

    const result = runHousekeeping({
      handle: db(),
      clock: fakeClock(NOW),
      checkpoint: false,
    });

    expect(result).toMatchObject({
      outboxDeleted: 1,
      idempotencyDeleted: 1,
      sessionsDeleted: 1,
      checkpointed: false,
    });

    expect(db().db.select().from(eventOutbox).all()).toHaveLength(1);
    const keys = db()
      .db.select({ key: idempotencyKey.key })
      .from(idempotencyKey)
      .all()
      .map((row) => row.key);
    expect(keys).toEqual([freshKey]);
    expect(keys).not.toContain(oldKey);

    const sessions = db()
      .db.select({ id: session.id })
      .from(session)
      .all()
      .map((row) => row.id);
    expect(sessions).toEqual([live]);
    expect(sessions).not.toContain(expired);

    // The cursor is deliberately untouched: rewinding it would make every open tab resync.
    expect(readCursorSeq(db().db)).toBe(cursorBefore);
  });

  it("is a no-op on a clean database", () => {
    const result = runHousekeeping({ handle: db(), clock: fakeClock(NOW), checkpoint: false });
    expect(result).toMatchObject({ outboxDeleted: 0, idempotencyDeleted: 0, sessionsDeleted: 0 });
  });

  it("honours overridden retentions", () => {
    publishNow(db(), [
      { topic: EVENT_TOPICS.taskChanged, payload: {}, atMs: NOW - 2 * MINUTE_MS },
    ]);
    const result = runHousekeeping({
      handle: db(),
      clock: fakeClock(NOW),
      outboxRetentionMs: MINUTE_MS,
      checkpoint: false,
    });
    expect(result.outboxDeleted).toBe(1);
  });
});

/* ------------------------------------------------------------------- metrics */

describe("metrics", () => {
  const sample = () => ({ rss: 120_000_000, heapUsed: 40_000_000, external: 3_000_000, uptimeS: 42 });

  it("writes one row per sample from the injected numbers", () => {
    writeProcessMetric({ handle: db(), role: "worker", atMs: NOW, sample });

    const rows = db().db.select().from(processMetric).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "worker",
      pid: process.pid,
      rssBytes: 120_000_000,
      heapUsedBytes: 40_000_000,
      externalBytes: 3_000_000,
      uptimeS: 42,
      atMs: NOW,
    });
  });

  it("prunes only samples older than the cutoff", () => {
    writeProcessMetric({ handle: db(), role: "worker", atMs: NOW - 15 * DAY_MS, sample });
    writeProcessMetric({ handle: db(), role: "worker", atMs: NOW - 13 * DAY_MS, sample });

    expect(pruneProcessMetrics(db(), NOW - 14 * DAY_MS)).toBe(1);
    const remaining = db().db.select({ atMs: processMetric.atMs }).from(processMetric).all();
    expect(remaining).toEqual([{ atMs: NOW - 13 * DAY_MS }]);
  });

  it("samples on its own timer and stops when told to", async () => {
    vi.useFakeTimers();
    const clock = fakeClock(NOW);
    const job = startMetricsJob({
      handle: db(),
      clock,
      intervalMs: 1_000,
      sample,
      logger: { debug: () => {}, warn: () => {} },
    });

    // The first sample is immediate: a worker that just started should already be on the chart.
    expect(db().db.select().from(processMetric).all()).toHaveLength(1);
    clock.advance(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(db().db.select().from(processMetric).all()).toHaveLength(2);

    job.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(db().db.select().from(processMetric).all()).toHaveLength(2);
  });
});

/* ----------------------------------------------------------------- heartbeat */

describe("heartbeat", () => {
  it("owns the 'worker' row and counts its beats", () => {
    writeWorkerHeartbeat({ handle: db(), workerId: "host/1/abcd", atMs: NOW });
    writeWorkerHeartbeat({
      handle: db(),
      workerId: "host/1/abcd",
      atMs: NOW + 15_000,
      haConnected: true,
      haLastConnectedMs: NOW + 15_000,
    });

    const row = db()
      .db.select()
      .from(workerHeartbeat)
      .where(eq(workerHeartbeat.name, WORKER_HEARTBEAT_NAME))
      .all()[0];
    expect(row).toMatchObject({
      workerId: "host/1/abcd",
      lastOkMs: NOW + 15_000,
      tickCount: 2,
      haConnected: true,
      haLastConnectedMs: NOW + 15_000,
    });
  });

  it("keeps the last known-good HA stamp when HA is currently down", () => {
    writeWorkerHeartbeat({
      handle: db(),
      workerId: "w",
      atMs: NOW,
      haConnected: true,
      haLastConnectedMs: NOW,
    });
    writeWorkerHeartbeat({ handle: db(), workerId: "w", atMs: NOW + 60_000, haConnected: false });

    const row = db()
      .db.select()
      .from(workerHeartbeat)
      .where(eq(workerHeartbeat.name, WORKER_HEARTBEAT_NAME))
      .all()[0];
    expect(row?.haConnected).toBe(false);
    // "HA has been down since 12:00" is only answerable if this survives.
    expect(row?.haLastConnectedMs).toBe(NOW);
  });

  it("bumps integration_status.heartbeat_at_ms regardless of HA state", () => {
    const clock = fakeClock(NOW);
    vi.useFakeTimers();
    const job = startHeartbeatJob({
      handle: db(),
      clock,
      workerId: "w",
      intervalMs: 15_000,
      haStatus: () => ({ connected: false, lastConnectedMs: null }),
      logger: { debug: () => {}, warn: () => {} },
    });

    const row = db()
      .db.select()
      .from(integrationStatus)
      .where(eq(integrationStatus.id, INTEGRATION_STATUS_HA_ID))
      .all()[0];
    expect(row?.heartbeatAtMs).toBe(NOW);
    // A stale heartbeat means the *worker* is down, so it must not depend on the socket.
    expect(row?.state).toBe("disconnected");
    job.stop();
  });
});

/* ----------------------------------------------------------------- integrity */

describe("integrity", () => {
  function attachDir(): string {
    const dir = fs.mkdtempSync("/tmp/vh-attach-");
    tempDirs.push(dir);
    return dir;
  }

  function seedAttachment(storagePath: string): string {
    const id = newId();
    writeTx(db().db, (tx) => {
      tx.insert(attachment)
        .values({
          id,
          kind: "photo",
          mime: "image/jpeg",
          byteSize: 1_024,
          sha256: `sha-${id}`,
          storagePath,
          originalFilename: "photo.jpg",
          hasWebCopy: false,
          createdAtMs: NOW,
          updatedAtMs: NOW,
        })
        .run();
    });
    return id;
  }

  function alertFor(dedupeKey: string) {
    return db().db.select().from(appAlert).where(eq(appAlert.dedupeKey, dedupeKey)).all()[0];
  }

  it("reports an attachment row whose file is missing, and deletes nothing", () => {
    const dir = attachDir();
    const id = seedAttachment("2027/03/missing.jpg");

    const result = runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW),
      tz: "Europe/Helsinki",
      attachDir: dir,
    });

    expect(result.attachmentsChecked).toBe(1);
    expect(result.missingFiles).toEqual([id]);
    expect(alertFor(ALERT_ATTACHMENTS_DEDUPE)?.severity).toBe("warning");
    // Reports, never repairs: the row is still there for a human to look at.
    expect(db().db.select().from(attachment).all()).toHaveLength(1);
  });

  it("reports a file on disk that no row references", () => {
    const dir = attachDir();
    fs.mkdirSync(`${dir}/2027/03`, { recursive: true });
    fs.writeFileSync(`${dir}/2027/03/orphan.jpg`, "bytes");

    const result = runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW),
      tz: "Europe/Helsinki",
      attachDir: dir,
    });

    expect(result.orphanFiles).toEqual(["2027/03/orphan.jpg"]);
    expect(fs.existsSync(`${dir}/2027/03/orphan.jpg`)).toBe(true);
  });

  it("is clean — and resolves its own alert — once the file is there", () => {
    const dir = attachDir();
    seedAttachment("2027/03/photo.jpg");

    runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW),
      tz: "Europe/Helsinki",
      attachDir: dir,
    });
    expect(alertFor(ALERT_ATTACHMENTS_DEDUPE)?.resolvedAtMs).toBeNull();

    fs.mkdirSync(`${dir}/2027/03`, { recursive: true });
    fs.writeFileSync(`${dir}/2027/03/photo.jpg`, "bytes");

    const result = runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW + HOUR_MS),
      tz: "Europe/Helsinki",
      attachDir: dir,
    });
    expect(result.missingFiles).toEqual([]);
    expect(result.orphanFiles).toEqual([]);
    expect(alertFor(ALERT_ATTACHMENTS_DEDUPE)?.resolvedAtMs).toBe(NOW + HOUR_MS);
  });

  it("reports a project_link whose target row is gone", () => {
    const projectId = newId();
    writeTx(db().db, (tx) => {
      tx.insert(project)
        .values({
          id: projectId,
          name: "Bathroom",
          kind: "renovation",
          status: "in_progress",
          createdAtMs: NOW,
          updatedAtMs: NOW,
        })
        .run();
      tx.insert(projectLink)
        .values({ id: "link-1", projectId, entityKind: "asset", entityId: "no-such-asset" })
        .run();
    });

    const result = runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW),
      tz: "Europe/Helsinki",
      attachDir: attachDir(),
      checkFiles: false,
    });

    expect(result.projectLinksChecked).toBe(1);
    expect(result.danglingLinks).toEqual(["link-1"]);
    expect(alertFor(ALERT_PROJECT_LINKS_DEDUPE)?.title).toMatch(/Project links/);
    // Not deleted: a dangling link is a report, and the row may be the only trace of intent left.
    expect(db().db.select().from(projectLink).all()).toHaveLength(1);
  });

  it("re-raising bumps the existing alert instead of piling up new ones", () => {
    const dir = attachDir();
    seedAttachment("2027/03/missing.jpg");

    runIntegrityCheck({ handle: db(), clock: fakeClock(NOW), tz: "Europe/Helsinki", attachDir: dir });
    runIntegrityCheck({
      handle: db(),
      clock: fakeClock(NOW + DAY_MS),
      tz: "Europe/Helsinki",
      attachDir: dir,
    });

    const alerts = db()
      .db.select()
      .from(appAlert)
      .where(eq(appAlert.dedupeKey, ALERT_ATTACHMENTS_DEDUPE))
      .all();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.seenCount).toBe(2);
  });
});
