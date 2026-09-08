/**
 * `integration_status` — the one row both processes read to answer "is the HA integration healthy".
 *
 * Design: `docs/design-notes/auth-security-operations.md` §8.7.
 *
 * The distinction the schema exists for: `heartbeat_at_ms` is bumped by the worker every
 * `VH_WORKER_HEARTBEAT_MS` **regardless of HA state**. A stale heartbeat therefore means *the
 * worker* is down ("Background service not running"), which is a different message from "Home
 * Assistant is unreachable". Blaming HA for a dead worker is the kind of bug that costs an hour of
 * debugging the wrong box.
 *
 * Every state transition also publishes an `integration.status` outbox event, so an open tab
 * updates within a second instead of on the next navigation.
 */
import { eq } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { nowMs as clockNowMs } from "@/db/ids";
import {
  INTEGRATION_STATUS_HA_ID,
  integrationStatus,
  type IntegrationState,
} from "@/db/schema/ha";
import { EVENT_TOPICS, publish } from "@/server/events/outbox";
import { redactSecrets } from "@/worker/ha/redact";

export interface IntegrationStatusPatch {
  state?: IntegrationState;
  haVersion?: string | null;
  lastOkAtMs?: number | null;
  heartbeatAtMs?: number;
  /** Redacted before it is written; never contains the token. */
  lastError?: string | null;
  reconnectCount?: number;
  entityCount?: number;
  /** Overrides "now" for the `updated_at_ms` stamp. Injected by tests. */
  atMs?: number;
  /** Suppress the outbox event (used by the heartbeat, which fires every 15 s). */
  silent?: boolean;
}

export interface IntegrationStatusRow {
  state: IntegrationState;
  haVersion: string | null;
  lastOkAtMs: number | null;
  heartbeatAtMs: number;
  lastError: string | null;
  reconnectCount: number;
  entityCount: number;
  updatedAtMs: number;
}

/** Longest an error string may be. A stack trace in a status column is noise, not information. */
const MAX_ERROR_CHARS = 400;

function redact(message: string | null | undefined, token?: string | null): string | null {
  if (message === null || message === undefined) return null;
  return redactSecrets(message, token).slice(0, MAX_ERROR_CHARS);
}

export function readIntegrationStatus(tx: Db): IntegrationStatusRow | null {
  const row = tx
    .select()
    .from(integrationStatus)
    .where(eq(integrationStatus.id, INTEGRATION_STATUS_HA_ID))
    .get();
  if (!row) return null;
  return {
    state: row.state,
    haVersion: row.haVersion,
    lastOkAtMs: row.lastOkAtMs,
    heartbeatAtMs: row.heartbeatAtMs,
    lastError: row.lastError,
    reconnectCount: row.reconnectCount,
    entityCount: row.entityCount,
    updatedAtMs: row.updatedAtMs,
  };
}

/**
 * Merge `patch` into the singleton and publish `integration.status`.
 *
 * `token` is passed only so `lastError` can be scrubbed of it: an HA error message can echo the
 * request that produced it, and a token in `integration_status` would be rendered on
 * `/settings/system`.
 */
export function writeIntegrationStatus(
  handle: DbHandle,
  patch: IntegrationStatusPatch,
  token?: string | null,
): IntegrationStatusRow {
  const at = patch.atMs ?? clockNowMs();
  return writeTx(handle.db, (tx) => {
    const current = readIntegrationStatus(tx);
    const next: IntegrationStatusRow = {
      state: patch.state ?? current?.state ?? "disconnected",
      haVersion: patch.haVersion !== undefined ? patch.haVersion : (current?.haVersion ?? null),
      lastOkAtMs: patch.lastOkAtMs !== undefined ? patch.lastOkAtMs : (current?.lastOkAtMs ?? null),
      heartbeatAtMs: patch.heartbeatAtMs ?? current?.heartbeatAtMs ?? at,
      lastError:
        patch.lastError !== undefined ? redact(patch.lastError, token) : (current?.lastError ?? null),
      reconnectCount: patch.reconnectCount ?? current?.reconnectCount ?? 0,
      entityCount: patch.entityCount ?? current?.entityCount ?? 0,
      updatedAtMs: at,
    };

    tx.insert(integrationStatus)
      .values({ id: INTEGRATION_STATUS_HA_ID, ...next })
      .onConflictDoUpdate({ target: integrationStatus.id, set: next })
      .run();

    if (!patch.silent) {
      publish(tx, [
        {
          topic: EVENT_TOPICS.integrationStatus,
          entityKey: INTEGRATION_STATUS_HA_ID,
          payload: next,
          atMs: at,
        },
      ]);
    }
    return next;
  });
}

/**
 * Bump `heartbeat_at_ms` only. Deliberately silent: at 15 s intervals an outbox row per heartbeat
 * would be the busiest thing in the database and would tell the UI nothing it did not know.
 */
export function heartbeat(handle: DbHandle, atMs?: number): void {
  const at = atMs ?? clockNowMs();
  writeTx(handle.db, (tx) => {
    tx.update(integrationStatus)
      .set({ heartbeatAtMs: at, updatedAtMs: at })
      .where(eq(integrationStatus.id, INTEGRATION_STATUS_HA_ID))
      .run();
  });
}

/** True when the worker's heartbeat is recent enough to believe it is alive (3 × the period). */
export function workerAlive(row: IntegrationStatusRow | null, nowMs: number, periodMs: number): boolean {
  if (!row) return false;
  return nowMs - row.heartbeatAtMs < periodMs * 3;
}
