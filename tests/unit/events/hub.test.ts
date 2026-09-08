/**
 * The hub, driven with a hand-cranked clock and a fake writer — no sleeping, no sockets.
 *
 * What is worth pinning: coalescing (a dimmer sweep must not reach the browser as 40 frames),
 * `Last-Event-ID` replay vs. `resync` (the difference between a correct UI and a silently stale
 * one), backpressure escalation, and the timer lifecycle (an idle app must own no timer at all).
 */
import { describe, expect, it } from "vitest";
import { Hub, coalesceRows, type HubSource, type HubTimers } from "@/server/events/hub";
import type { OutboxRow } from "@/server/events/outbox";
import { ManualClock } from "../../helpers/fakeHa";

/** `HubTimers` on top of `ManualClock`, with an interval built from repeating timeouts. */
function manualTimers(clock: ManualClock): { timers: HubTimers; intervals: () => number } {
  let live = 0;
  const timers: HubTimers = {
    now: clock.now,
    setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
    clearTimeout: (handle) => {
      clock.clearTimeout(handle);
    },
    setInterval: (callback, ms) => {
      live += 1;
      const box: { handle: unknown; cancelled: boolean } = { handle: null, cancelled: false };
      const tick = (): void => {
        if (box.cancelled) return;
        box.handle = clock.setTimeout(tick, ms);
        callback();
      };
      box.handle = clock.setTimeout(tick, ms);
      return box;
    },
    clearInterval: (handle) => {
      const box = handle as { handle: unknown; cancelled: boolean };
      box.cancelled = true;
      clock.clearTimeout(box.handle);
      live -= 1;
    },
  };
  return { timers, intervals: () => live };
}

/** An in-memory outbox: the hub only ever asks these three questions. */
function fakeSource(): {
  source: HubSource;
  append(topic: string, key: string | null, payload?: unknown): number;
  prune(upToSeq: number): void;
} {
  let rows: OutboxRow[] = [];
  let nextSeq = 0;
  return {
    source: {
      cursorSeq: () => nextSeq,
      oldestSeq: () => (rows.length === 0 ? null : rows[0]!.seq),
      eventsAfter: (seq) => rows.filter((row) => row.seq > seq),
    },
    append(topic, key, payload = {}) {
      nextSeq += 1;
      rows.push({ seq: nextSeq, topic, key, at: 1_000 + nextSeq, payload });
      return nextSeq;
    },
    prune(upToSeq) {
      rows = rows.filter((row) => row.seq > upToSeq);
    },
  };
}

interface FakeClient {
  chunks: string[];
  /** Set false to simulate a consumer that is not draining. */
  draining: boolean;
  closed: boolean;
  write(chunk: string): boolean;
  close(): void;
}

function fakeClient(): FakeClient {
  const client: FakeClient = {
    chunks: [],
    draining: true,
    closed: false,
    write(chunk) {
      client.chunks.push(chunk);
      return client.draining;
    },
    close() {
      client.closed = true;
    },
  };
  return client;
}

interface ParsedFrame {
  event: string;
  id: number | null;
  data: unknown;
}

function frames(client: FakeClient): ParsedFrame[] {
  return client.chunks
    .filter((chunk) => chunk.startsWith("event: "))
    .map((chunk) => {
      const lines = chunk.trim().split("\n");
      const event = lines[0]!.slice("event: ".length);
      const idLine = lines.find((line) => line.startsWith("id: "));
      const dataLine = lines.find((line) => line.startsWith("data: "))!;
      return {
        event,
        id: idLine ? Number(idLine.slice(4)) : null,
        data: JSON.parse(dataLine.slice(6)) as unknown,
      };
    });
}

function batches(client: FakeClient): { seq: number; items: { topic: string; key: string | null }[] }[] {
  return frames(client)
    .filter((frame) => frame.event === "batch")
    .map((frame) => frame.data as { seq: number; items: { topic: string; key: string | null }[] });
}

function build(options?: { maxFrameBytes?: number }): {
  hub: Hub;
  clock: ManualClock;
  intervals: () => number;
  append: (topic: string, key: string | null, payload?: unknown) => number;
  prune: (upToSeq: number) => void;
} {
  const clock = new ManualClock(1_000);
  const { timers, intervals } = manualTimers(clock);
  const { source, append, prune } = fakeSource();
  const hub = new Hub({
    source,
    timers,
    pollMs: 1_000,
    keepAliveMs: 15_000,
    idleStopMs: 30_000,
    maxFrameBytes: options?.maxFrameBytes ?? 64 * 1024,
    serverStartedAt: 1_000,
  });
  return { hub, clock, intervals, append, prune };
}

describe("event hub", () => {
  it("greets a new client with retry + hello carrying the current seq and the snapshot", () => {
    const { hub, append } = build();
    append("ha.state", "sensor.a");
    append("ha.state", "sensor.b");

    const client = fakeClient();
    hub.add({
      userId: "u1",
      write: client.write,
      close: client.close,
      helloItems: [
        { seq: 2, topic: "ha.state", key: "sensor.a", at: 500, payload: { state: "1" } },
      ],
    });

    expect(client.chunks[0]).toBe("retry: 3000\n\n");
    const hello = frames(client)[0]!;
    expect(hello.event).toBe("hello");
    expect(hello.id).toBe(2);
    expect(hello.data).toMatchObject({
      seq: 2,
      serverStartedAt: 1_000,
      items: [{ topic: "ha.state", key: "sensor.a", payload: { state: "1" } }],
    });
  });

  it("a fresh client gets no history — only what happens next", () => {
    const { hub, clock, append } = build();
    append("ha.state", "sensor.old");

    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });
    expect(batches(client)).toHaveLength(0);

    append("ha.state", "sensor.new");
    clock.advance(1_000);

    expect(batches(client)).toHaveLength(1);
    expect(batches(client)[0]!.items.map((item) => item.key)).toEqual(["sensor.new"]);
  });

  it("coalesces 40 dimmer updates into one item", () => {
    const { hub, clock, append } = build();
    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });

    for (let brightness = 1; brightness <= 40; brightness += 1) {
      append("ha.state", "light.kitchen", { state: "on", attributes: { brightness } });
    }
    append("integration.status", "ha", { state: "subscribed" });
    clock.advance(1_000);

    const sent = batches(client);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.items).toHaveLength(2);
    expect(sent[0]!.items.map((item) => item.key)).toEqual(["light.kitchen", "ha"]);
    // Newest value wins.
    const item = sent[0]!.items[0] as unknown as {
      payload: { attributes: { brightness: number } };
    };
    expect(item.payload.attributes.brightness).toBe(40);
    expect(sent[0]!.seq).toBe(41);
  });

  it("replays from Last-Event-ID when the rows are still retained", () => {
    const { hub, append } = build();
    append("ha.state", "sensor.a");
    append("ha.state", "sensor.b");
    append("ha.state", "sensor.c");

    const client = fakeClient();
    hub.add({ userId: "u1", lastEventId: 1, write: client.write, close: client.close });

    const sent = batches(client);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.items.map((item) => item.key)).toEqual(["sensor.b", "sensor.c"]);
    expect(frames(client).some((frame) => frame.event === "resync")).toBe(false);
  });

  it("sends resync instead of replaying when the missed rows have been pruned", () => {
    const { hub, append, prune } = build();
    append("ha.state", "sensor.a");
    append("ha.state", "sensor.b");
    append("ha.state", "sensor.c");
    prune(2); // rows 1 and 2 are gone; a client resuming at 1 has a gap

    const client = fakeClient();
    hub.add({ userId: "u1", lastEventId: 1, write: client.write, close: client.close });

    const resync = frames(client).find((frame) => frame.event === "resync");
    expect(resync?.data).toEqual({ seq: 3, reason: "gap" });
    expect(batches(client)).toHaveLength(0);
  });

  it("treats a Last-Event-ID at or beyond the cursor as nothing to replay", () => {
    const { hub, append } = build();
    append("ha.state", "sensor.a");

    const client = fakeClient();
    hub.add({ userId: "u1", lastEventId: 99, write: client.write, close: client.close });
    expect(batches(client)).toHaveLength(0);
    expect(frames(client).some((frame) => frame.event === "resync")).toBe(false);
  });

  it("sends resync rather than a frame that exceeds the size cap", () => {
    const { hub, clock, append } = build({ maxFrameBytes: 256 });
    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });

    append("ha.state", "sensor.big", { blob: "x".repeat(1_000) });
    clock.advance(1_000);

    expect(batches(client)).toHaveLength(0);
    expect(frames(client).find((frame) => frame.event === "resync")?.data).toEqual({
      seq: 1,
      reason: "too_large",
    });
  });

  it("resyncs a stalled client at 3 flushes and drops it at 5", () => {
    const { hub, clock, append } = build();
    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });
    client.draining = false;

    for (let i = 0; i < 3; i += 1) {
      append("ha.state", `sensor.${i}`);
      clock.advance(1_000);
    }
    expect(frames(client).filter((frame) => frame.event === "resync")).toHaveLength(1);
    expect(hub.size).toBe(1);

    for (let i = 3; i < 6; i += 1) {
      append("ha.state", `sensor.${i}`);
      clock.advance(1_000);
    }
    // 3 data writes + the resync frame itself all report backpressure, so the close threshold
    // is reached and the stream is dropped; EventSource reconnects and gets a fresh hello.
    expect(client.closed).toBe(true);
    expect(hub.size).toBe(0);
  });

  it("resets the stall counter as soon as the client drains again", () => {
    const { hub, clock, append } = build();
    const client = fakeClient();
    const registered = hub.add({ userId: "u1", write: client.write, close: client.close });

    client.draining = false;
    append("ha.state", "sensor.a");
    clock.advance(1_000);
    expect(registered.stalled).toBe(1);

    client.draining = true;
    append("ha.state", "sensor.b");
    clock.advance(1_000);
    expect(registered.stalled).toBe(0);
  });

  it("sends a keep-alive comment when nothing has been written for 15 s", () => {
    const { hub, clock } = build();
    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });
    const after = client.chunks.length;

    clock.advance(14_000);
    expect(client.chunks.length).toBe(after);

    clock.advance(2_000);
    expect(client.chunks.at(-1)).toMatch(/^: keep-alive \d+\n\n$/);
  });

  it("starts the poll with the first client and stops it 30 s after the last leaves", () => {
    const { hub, clock, intervals } = build();
    expect(hub.polling).toBe(false);
    expect(intervals()).toBe(0);

    const a = fakeClient();
    const clientA = hub.add({ userId: "u1", write: a.write, close: a.close });
    expect(hub.polling).toBe(true);
    expect(intervals()).toBe(1);

    const b = fakeClient();
    const clientB = hub.add({ userId: "u2", write: b.write, close: b.close });
    expect(intervals()).toBe(1); // one poller, not one per client

    hub.remove(clientA);
    clock.advance(31_000);
    expect(hub.polling).toBe(true); // still one client

    hub.remove(clientB);
    expect(hub.polling).toBe(true); // lingers
    clock.advance(29_000);
    expect(hub.polling).toBe(true);
    clock.advance(2_000);
    expect(hub.polling).toBe(false);
    expect(intervals()).toBe(0);
  });

  it("re-arms the poller when a client arrives during the idle grace period", () => {
    const { hub, clock } = build();
    const a = fakeClient();
    const clientA = hub.add({ userId: "u1", write: a.write, close: a.close });
    hub.remove(clientA);
    clock.advance(10_000);

    const b = fakeClient();
    hub.add({ userId: "u2", write: b.write, close: b.close });
    clock.advance(60_000);
    expect(hub.polling).toBe(true);
  });

  it("drops a client whose write throws", () => {
    const { hub, clock, append } = build();
    const client = fakeClient();
    let boom = false;
    hub.add({
      userId: "u1",
      write: (chunk) => {
        if (boom) throw new Error("stream closed");
        return client.write(chunk);
      },
      close: client.close,
    });
    boom = true;
    append("ha.state", "sensor.a");
    clock.advance(1_000);
    expect(hub.size).toBe(0);
    expect(client.closed).toBe(true);
  });

  it("removes are idempotent", () => {
    const { hub } = build();
    const client = fakeClient();
    const registered = hub.add({ userId: "u1", write: client.write, close: client.close });
    hub.remove(registered);
    hub.remove(registered);
    expect(hub.size).toBe(0);
  });

  it("shutdown sends bye, closes every stream and clears the timers", () => {
    const { hub, intervals } = build();
    const a = fakeClient();
    const b = fakeClient();
    hub.add({ userId: "u1", write: a.write, close: a.close });
    hub.add({ userId: "u2", write: b.write, close: b.close });

    hub.shutdown();

    for (const client of [a, b]) {
      expect(frames(client).at(-1)).toMatchObject({ event: "bye", data: { reason: "shutdown" } });
      expect(client.closed).toBe(true);
    }
    expect(hub.size).toBe(0);
    expect(hub.polling).toBe(false);
    expect(intervals()).toBe(0);
  });

  it("costs one query per tick while the cursor is unchanged", () => {
    const clock = new ManualClock(1_000);
    const { timers } = manualTimers(clock);
    let cursorReads = 0;
    let rowReads = 0;
    const hub = new Hub({
      timers,
      pollMs: 1_000,
      source: {
        cursorSeq: () => {
          cursorReads += 1;
          return 0;
        },
        oldestSeq: () => null,
        eventsAfter: () => {
          rowReads += 1;
          return [];
        },
      },
    });
    const client = fakeClient();
    hub.add({ userId: "u1", write: client.write, close: client.close });
    const baseline = cursorReads;

    clock.advance(10_000);
    expect(cursorReads).toBe(baseline + 10);
    expect(rowReads).toBe(0);
  });

  it("coalesceRows keeps the newest per (topic, key) in sequence order", () => {
    const rows: OutboxRow[] = [
      { seq: 1, topic: "ha.state", key: "a", at: 1, payload: 1 },
      { seq: 2, topic: "ha.state", key: "b", at: 2, payload: 2 },
      { seq: 3, topic: "ha.state", key: "a", at: 3, payload: 3 },
      { seq: 4, topic: "task.changed", key: null, at: 4, payload: 4 },
      { seq: 5, topic: "task.changed", key: null, at: 5, payload: 5 },
    ];
    expect(coalesceRows(rows).map((item) => [item.seq, item.topic, item.key])).toEqual([
      [2, "ha.state", "b"],
      [3, "ha.state", "a"],
      [5, "task.changed", null],
    ]);
  });
});
