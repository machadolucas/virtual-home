/**
 * The outbox is the whole worker→web transport, and it has exactly one invariant that matters:
 * a reader that sees a bumped `event_cursor.seq` must find the rows. These tests pin that, plus
 * the retention behaviour that would otherwise rewind every connected client.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTx, type DbHandle } from "@/db/client";
import { eventCursor, eventOutbox } from "@/db/schema";
import {
  EVENT_TOPICS,
  EVENT_TOPIC_VALUES,
  oldestOutboxSeq,
  pruneOutbox,
  publish,
  publishNow,
  readCursorSeq,
  readOutboxAfter,
} from "@/server/events/outbox";
import { testDb } from "../../helpers/db";

const T0 = 1_760_000_000_000;

describe("event outbox", () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = testDb();
  });

  afterEach(() => {
    handle.close();
  });

  it("names every topic the app publishes", () => {
    expect(EVENT_TOPIC_VALUES).toEqual([
      "document.changed",
      "ha.state",
      "integration.status",
      "task.changed",
      "occurrence.changed",
      "inventory.changed",
      "alert.changed",
      "model.changed",
    ]);
  });

  it("starts from the seeded cursor", () => {
    expect(readCursorSeq(handle.db)).toBe(0);
    expect(oldestOutboxSeq(handle.db)).toBeNull();
  });

  it("writes rows and bumps the cursor to the last row id", () => {
    const seq = publishNow(handle, [
      { topic: EVENT_TOPICS.haState, entityKey: "sensor.a", payload: { state: "1" }, atMs: T0 },
      { topic: EVENT_TOPICS.haState, entityKey: "sensor.b", payload: { state: "2" }, atMs: T0 },
    ]);

    expect(seq).toBe(2);
    expect(readCursorSeq(handle.db)).toBe(2);

    const rows = readOutboxAfter(handle.db, 0);
    expect(rows.map((row) => [row.seq, row.topic, row.key])).toEqual([
      [1, "ha.state", "sensor.a"],
      [2, "ha.state", "sensor.b"],
    ]);
    expect(rows[0]?.payload).toEqual({ state: "1" });
    expect(rows[0]?.at).toBe(T0);
  });

  it("is atomic: a failed transaction leaves neither rows nor a bumped cursor", () => {
    publishNow(handle, [{ topic: EVENT_TOPICS.taskChanged, payload: { id: "t1" }, atMs: T0 }]);
    expect(readCursorSeq(handle.db)).toBe(1);

    expect(() =>
      writeTx(handle.db, (tx) => {
        publish(tx, [{ topic: EVENT_TOPICS.taskChanged, payload: { id: "t2" }, atMs: T0 }]);
        throw new Error("domain write failed after publishing");
      }),
    ).toThrow(/domain write failed/);

    expect(readCursorSeq(handle.db)).toBe(1);
    expect(readOutboxAfter(handle.db, 0)).toHaveLength(1);
  });

  it("never lets a reader see a bumped cursor without its rows", () => {
    // The counter is written in the same statement batch as the inserts, so at every point where
    // another connection could read, `seq` and `MAX(id)` agree.
    for (let i = 0; i < 5; i += 1) {
      publishNow(handle, [
        { topic: EVENT_TOPICS.haState, entityKey: `sensor.${i}`, payload: { state: i }, atMs: T0 },
      ]);
      const seq = readCursorSeq(handle.db);
      const max = handle.sqlite.prepare(`SELECT MAX(id) AS m FROM event_outbox`).get() as {
        m: number | null;
      };
      expect(seq).toBe(max.m);
    }
  });

  it("publishing nothing touches nothing", () => {
    publishNow(handle, [{ topic: EVENT_TOPICS.alertChanged, payload: null, atMs: T0 }]);
    const before = readCursorSeq(handle.db);
    expect(publishNow(handle, [])).toBe(before);
    expect(readCursorSeq(handle.db)).toBe(before);
  });

  it("prunes by age and leaves the cursor alone", () => {
    publishNow(handle, [
      { topic: EVENT_TOPICS.haState, entityKey: "old.1", payload: {}, atMs: T0 },
      { topic: EVENT_TOPICS.haState, entityKey: "old.2", payload: {}, atMs: T0 + 1_000 },
      { topic: EVENT_TOPICS.haState, entityKey: "new.1", payload: {}, atMs: T0 + 600_000 },
    ]);
    expect(readCursorSeq(handle.db)).toBe(3);

    const deleted = writeTx(handle.db, (tx) => pruneOutbox(tx, T0 + 60_000));
    expect(deleted).toBe(2);

    // The cursor is the client's notion of "where I am"; rewinding it would resync every tab.
    expect(readCursorSeq(handle.db)).toBe(3);
    expect(oldestOutboxSeq(handle.db)).toBe(3);
    expect(readOutboxAfter(handle.db, 0).map((row) => row.key)).toEqual(["new.1"]);
  });

  it("keeps the cursor after the table is emptied, so ids never repeat", () => {
    publishNow(handle, [{ topic: EVENT_TOPICS.haState, entityKey: "a", payload: {}, atMs: T0 }]);
    writeTx(handle.db, (tx) => pruneOutbox(tx, T0 + 1));
    expect(readCursorSeq(handle.db)).toBe(1);

    const seq = publishNow(handle, [
      { topic: EVENT_TOPICS.haState, entityKey: "b", payload: {}, atMs: T0 + 2 },
    ]);
    expect(seq).toBe(2);
  });

  it("reads back a malformed payload as null instead of throwing", () => {
    writeTx(handle.db, (tx) => {
      tx.insert(eventOutbox)
        .values({ topic: "ha.state", entityKey: "x", payloadJson: "{not json", createdAtMs: T0 })
        .run();
      tx.update(eventCursor).set({ seq: 1 }).run();
    });
    expect(readOutboxAfter(handle.db, 0)[0]?.payload).toBeNull();
  });

  it("respects the read limit and ordering", () => {
    publishNow(
      handle,
      Array.from({ length: 10 }, (_, i) => ({
        topic: EVENT_TOPICS.haState,
        entityKey: `sensor.${i}`,
        payload: { i },
        atMs: T0 + i,
      })),
    );
    const rows = readOutboxAfter(handle.db, 4, 3);
    expect(rows.map((row) => row.seq)).toEqual([5, 6, 7]);
  });
});
