/**
 * The worker→web notification channel: a SQLite outbox plus a single-row counter the SSE hub
 * polls once a second.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §7.1–7.3. Why an outbox and not IPC:
 * either process can restart in any order with zero coordination, `Last-Event-ID` replay reads the
 * same rows the UI does, and the whole mechanism is two tables and a `setInterval`.
 *
 * The one invariant that matters: **`event_cursor.seq` is bumped in the same transaction as the
 * inserts.** A reader that saw a bumped counter is guaranteed to find the rows. The counter is a
 * stored value rather than `MAX(id)` so it survives retention deletes, where `MAX(id)` on an
 * emptied table would return NULL and rewind every client.
 */
import { eq, gt, lt, sql } from "drizzle-orm";
import { writeTx, type Db, type DbHandle } from "@/db/client";
import { nowMs } from "@/db/ids";
import { EVENT_CURSOR_ID, eventCursor, eventOutbox } from "@/db/schema/system";

/**
 * Every topic the stream carries. `entityKey` is the coalescing key within a topic: the hub keeps
 * only the newest item per `(topic, key)` per flush, so a dimmer swept through 40 values reaches
 * the browser as one item.
 */
export const EVENT_TOPICS = {
  documentChanged: "document.changed",
  /** An HA entity's state changed. `key` is the `entity_id`. */
  haState: "ha.state",
  /** The HA integration's connection state changed. `key` is `'ha'`. */
  integrationStatus: "integration.status",
  /** A maintenance task (the definition) changed. */
  taskChanged: "task.changed",
  /** A single occurrence changed (created, done, snoozed, skipped). */
  occurrenceChanged: "occurrence.changed",
  /** Stock levels or part definitions changed. */
  inventoryChanged: "inventory.changed",
  /** An `app_alert` was raised, acknowledged or resolved. */
  alertChanged: "alert.changed",
  /** The house-model package or a reconciliation changed. */
  modelChanged: "model.changed",
} as const;

export type EventTopic = (typeof EVENT_TOPICS)[keyof typeof EVENT_TOPICS];

/** All topic strings, for validation and for tests that assert the list is complete. */
export const EVENT_TOPIC_VALUES: readonly EventTopic[] = Object.values(EVENT_TOPICS);

export interface OutboxItem {
  topic: EventTopic;
  /** Coalescing key. Omit for topics that are "something in this collection changed". */
  entityKey?: string | null;
  payload: unknown;
  /** Defaults to `nowMs()`. Injectable so tests stay deterministic. */
  atMs?: number;
}

/** One persisted outbox row, as the hub reads it back. */
export interface OutboxRow {
  seq: number;
  topic: string;
  key: string | null;
  at: number;
  payload: unknown;
}

/**
 * Append `items` and bump the cursor, **inside the caller's transaction**.
 *
 * Returns the new cursor value (the id of the last row written), or the unchanged cursor when
 * `items` is empty. Callers that already hold a `writeTx` use this; everyone else uses
 * `publishNow`.
 */
export function publish(tx: Db, items: readonly OutboxItem[]): number {
  if (items.length === 0) return readCursorSeq(tx);

  const at = nowMs();
  for (const item of items) {
    tx.insert(eventOutbox)
      .values({
        topic: item.topic,
        entityKey: item.entityKey ?? null,
        payloadJson: JSON.stringify(item.payload ?? null),
        createdAtMs: item.atMs ?? at,
      })
      .run();
  }

  // Same transaction as the inserts (§7.2). `MAX(id)` is evaluated here, not stored as a
  // trigger-maintained value, so a chunked bulk publish converges on the right number.
  tx.update(eventCursor)
    .set({ seq: sql`(SELECT COALESCE(MAX(${eventOutbox.id}), 0) FROM ${eventOutbox})` })
    .where(eq(eventCursor.id, EVENT_CURSOR_ID))
    .run();

  return readCursorSeq(tx);
}

/** `publish` in its own BEGIN IMMEDIATE transaction. The common call site. */
export function publishNow(handle: DbHandle, items: readonly OutboxItem[]): number {
  if (items.length === 0) return readCursorSeq(handle.db);
  return writeTx(handle.db, (tx) => publish(tx, items));
}

/**
 * Delete rows created before `olderThanMs`. Retention is short (10 minutes in the worker's
 * reaper): the outbox is a transport, not a log. The cursor is deliberately **not** touched —
 * rewinding it would make every connected client resync.
 *
 * Returns the number of rows deleted.
 */
export function pruneOutbox(tx: Db, olderThanMs: number): number {
  const result = tx.delete(eventOutbox).where(lt(eventOutbox.createdAtMs, olderThanMs)).run();
  return Number(result.changes ?? 0);
}

/** The current sequence number. One indexed single-row read; the hub does this once a second. */
export function readCursorSeq(tx: Db): number {
  const row = tx
    .select({ seq: eventCursor.seq })
    .from(eventCursor)
    .where(eq(eventCursor.id, EVENT_CURSOR_ID))
    .get();
  return row?.seq ?? 0;
}

/**
 * The lowest id still in the table, or `null` when it is empty. The hub compares a client's
 * `Last-Event-ID` against this to decide replay vs. `resync`.
 */
export function oldestOutboxSeq(tx: Db): number | null {
  const row = tx
    .select({ id: sql<number | null>`MIN(${eventOutbox.id})` })
    .from(eventOutbox)
    .get();
  const value = row?.id ?? null;
  return typeof value === "number" ? value : null;
}

/** Rows with `id > afterSeq`, oldest first. */
export function readOutboxAfter(tx: Db, afterSeq: number, limit = 2_000): OutboxRow[] {
  const rows = tx
    .select({
      id: eventOutbox.id,
      topic: eventOutbox.topic,
      entityKey: eventOutbox.entityKey,
      payloadJson: eventOutbox.payloadJson,
      createdAtMs: eventOutbox.createdAtMs,
    })
    .from(eventOutbox)
    .where(gt(eventOutbox.id, afterSeq))
    .orderBy(eventOutbox.id)
    .limit(limit)
    .all();

  return rows.map((row) => ({
    seq: row.id,
    topic: row.topic,
    key: row.entityKey,
    at: row.createdAtMs,
    payload: parsePayload(row.payloadJson),
  }));
}

function parsePayload(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    // A malformed row must not stall the stream; the client ignores items it cannot read.
    return null;
  }
}
