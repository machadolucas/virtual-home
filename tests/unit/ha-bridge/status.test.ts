/**
 * `integration_status`: the row that decides whether the UI says "Home Assistant unreachable" or
 * "Background service not running" — two very different debugging instructions.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/db/client";
import { readCursorSeq, readOutboxAfter } from "@/server/events/outbox";
import {
  heartbeat,
  readIntegrationStatus,
  workerAlive,
  writeIntegrationStatus,
} from "@/server/ha/status";
import { testDb } from "../../helpers/db";
import { T0 } from "./fixtures";

const TOKEN = "super-secret-long-lived-token-value";

describe("integration status", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = testDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("starts from the seeded disconnected row", () => {
    expect(readIntegrationStatus(handle.db)).toMatchObject({
      state: "disconnected",
      reconnectCount: 0,
      entityCount: 0,
    });
  });

  it("merges a patch and publishes integration.status", () => {
    const next = writeIntegrationStatus(handle, {
      state: "subscribed",
      haVersion: "2026.9.1",
      lastOkAtMs: T0,
      entityCount: 3300,
      atMs: T0,
    });

    expect(next).toMatchObject({
      state: "subscribed",
      haVersion: "2026.9.1",
      lastOkAtMs: T0,
      entityCount: 3300,
      updatedAtMs: T0,
    });
    expect(readIntegrationStatus(handle.db)).toEqual(next);

    expect(readCursorSeq(handle.db)).toBe(1);
    const rows = readOutboxAfter(handle.db, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: "integration.status", key: "ha", at: T0 });
    expect(rows[0]?.payload).toMatchObject({ state: "subscribed", entityCount: 3300 });
  });

  it("keeps fields the patch does not mention", () => {
    writeIntegrationStatus(handle, { state: "subscribed", haVersion: "2026.9.1", atMs: T0 });
    const next = writeIntegrationStatus(handle, { state: "degraded", atMs: T0 + 1_000 });
    expect(next.haVersion).toBe("2026.9.1");
    expect(next.state).toBe("degraded");
  });

  it("redacts the token out of last_error", () => {
    const next = writeIntegrationStatus(
      handle,
      {
        state: "auth_failed",
        lastError: `GET /api/ failed with access_token=${TOKEN}`,
        atMs: T0,
      },
      TOKEN,
    );
    expect(next.lastError).not.toContain(TOKEN);
    expect(next.lastError).toContain("[redacted]");
    expect(
      handle.sqlite.prepare(`SELECT last_error FROM integration_status`).get(),
    ).not.toMatchObject({ last_error: expect.stringContaining(TOKEN) as unknown as string });
  });

  it("truncates a huge error rather than storing a stack trace", () => {
    const next = writeIntegrationStatus(handle, { lastError: "x".repeat(5_000), atMs: T0 });
    expect(next.lastError?.length).toBe(400);
  });

  it("clears last_error when the patch passes null", () => {
    writeIntegrationStatus(handle, { state: "degraded", lastError: "boom", atMs: T0 });
    const next = writeIntegrationStatus(handle, { state: "subscribed", lastError: null, atMs: T0 + 1 });
    expect(next.lastError).toBeNull();
  });

  it("silent writes do not publish", () => {
    writeIntegrationStatus(handle, { state: "connecting", atMs: T0, silent: true });
    expect(readCursorSeq(handle.db)).toBe(0);
  });

  it("heartbeat bumps only the heartbeat and publishes nothing", () => {
    writeIntegrationStatus(handle, { state: "subscribed", atMs: T0 });
    const seqAfterStatus = readCursorSeq(handle.db);

    heartbeat(handle, T0 + 15_000);

    const row = readIntegrationStatus(handle.db);
    expect(row?.heartbeatAtMs).toBe(T0 + 15_000);
    expect(row?.state).toBe("subscribed");
    // 15 s heartbeats must not be the busiest writer in the outbox.
    expect(readCursorSeq(handle.db)).toBe(seqAfterStatus);
  });

  it("workerAlive is three heartbeat periods of tolerance", () => {
    writeIntegrationStatus(handle, { state: "subscribed", heartbeatAtMs: T0, atMs: T0 });
    const row = readIntegrationStatus(handle.db);
    expect(workerAlive(row, T0 + 30_000, 15_000)).toBe(true);
    expect(workerAlive(row, T0 + 46_000, 15_000)).toBe(false);
    expect(workerAlive(null, T0, 15_000)).toBe(false);
  });
});
