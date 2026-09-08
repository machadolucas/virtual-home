/**
 * The SSE fan-out hub: one poller in the web process, many browser streams.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §7.4–7.6.
 *
 * Shape of the contract, because the browser side (`src/house/store/haSse.ts`) depends on it:
 *
 *   retry: 3000
 *
 *   event: hello
 *   id: 10432
 *   data: {"seq":10432,"serverStartedAt":…,"items":[…]}
 *
 *   event: batch
 *   id: 10440
 *   data: {"seq":10440,"items":[{"seq":10437,"topic":"ha.state","key":"light.kitchen",
 *                               "at":…,"payload":{…}}]}
 *
 *   event: resync
 *   data: {"seq":10440,"reason":"gap"}
 *
 *   : keep-alive 1757300015000
 *
 * Everything time-dependent is injected (`timers`) and the database is behind a `HubSource`, so
 * the tests drive coalescing, replay and backpressure with a hand-cranked clock and a fake writer;
 * there is no sleeping in the test suite.
 */
import { getDb, type Db } from "@/db/client";
import {
  oldestOutboxSeq,
  readCursorSeq,
  readOutboxAfter,
  type OutboxRow,
} from "@/server/events/outbox";

/* ------------------------------------------------------------------- types */

/** One item inside a `batch` (or `hello`) frame. */
export interface HubBatchItem {
  seq: number;
  topic: string;
  key: string | null;
  at: number;
  payload: unknown;
}

export type HubResyncReason = "gap" | "too_large" | "backpressure";

/** Where the hub reads its rows. Swapped wholesale in tests. */
export interface HubSource {
  cursorSeq(): number;
  oldestSeq(): number | null;
  eventsAfter(seq: number): OutboxRow[];
}

/** The slice of the timer API the hub uses. */
export interface HubTimers {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HubOptions {
  source?: HubSource;
  timers?: HubTimers;
  /** Cursor poll period. Default 1 s (`VH_EVENT_POLL_MS`). */
  pollMs?: number;
  /** Comment frame period, to beat proxy and NAT idle timers. Default 15 s. */
  keepAliveMs?: number;
  /** How long the poller lingers after the last client leaves. Default 30 s. */
  idleStopMs?: number;
  /** Per-frame cap; a bigger batch becomes a `resync`. Default 64 KiB. */
  maxFrameBytes?: number;
  /** `retry:` hint for `EventSource`. Default 3 s. */
  retryMs?: number;
  /** Consecutive stalled writes before a `resync` / before closing. Defaults 3 / 5. */
  stalledResyncThreshold?: number;
  stalledCloseThreshold?: number;
  serverStartedAt?: number;
}

export interface HubClientInit {
  userId: string;
  /** Parsed `Last-Event-ID`. 0 (or absent) means "fresh connection, no replay". */
  lastEventId?: number;
  /** Items carried in the `hello` frame so the browser can render before the first change. */
  helloItems?: readonly HubBatchItem[];
  /** Returns false when the consumer is not draining (`controller.desiredSize <= 0`). */
  write(chunk: string): boolean;
  close(): void;
}

export interface HubClient {
  readonly id: number;
  readonly userId: string;
  /** Highest sequence this client has been sent. */
  lastSeq: number;
  /** Consecutive flushes where `write()` reported backpressure. */
  stalled: number;
  readonly connectedAt: number;
}

interface InternalClient extends HubClient {
  write(chunk: string): boolean;
  close(): void;
  lastWriteAt: number;
}

/* ----------------------------------------------------------------- defaults */

const DEFAULTS = {
  pollMs: 1_000,
  keepAliveMs: 15_000,
  idleStopMs: 30_000,
  maxFrameBytes: 64 * 1024,
  retryMs: 3_000,
  stalledResyncThreshold: 3,
  stalledCloseThreshold: 5,
} as const;

/**
 * Real timers, with `unref()` where it exists so a live stream never holds the process open during
 * shutdown (`ExitTimeOut` in the launchd plist is 20 s).
 */
export const nodeTimers: HubTimers = {
  now: () => Date.now(),
  setInterval: (callback, ms) => {
    const handle = globalThis.setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
  setTimeout: (callback, ms) => {
    const handle = globalThis.setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/** A `HubSource` backed by a database handle. */
export function dbHubSource(db: Db): HubSource {
  return {
    cursorSeq: () => readCursorSeq(db),
    oldestSeq: () => oldestOutboxSeq(db),
    eventsAfter: (seq) => readOutboxAfter(db, seq),
  };
}

/* -------------------------------------------------------------------- class */

export class Hub {
  readonly #source: HubSource;
  readonly #timers: HubTimers;
  readonly #pollMs: number;
  readonly #keepAliveMs: number;
  readonly #idleStopMs: number;
  readonly #maxFrameBytes: number;
  readonly #retryMs: number;
  readonly #stalledResync: number;
  readonly #stalledClose: number;
  readonly #serverStartedAt: number;

  readonly #clients = new Set<InternalClient>();
  #nextClientId = 1;
  #pollHandle: unknown = null;
  #idleHandle: unknown = null;
  /** Last cursor value observed, so an unchanged counter costs exactly one query. */
  #knownSeq = -1;
  #shuttingDown = false;

  constructor(options: HubOptions = {}) {
    this.#source = options.source ?? dbHubSource(getDb().db);
    this.#timers = options.timers ?? nodeTimers;
    this.#pollMs = options.pollMs ?? DEFAULTS.pollMs;
    this.#keepAliveMs = options.keepAliveMs ?? DEFAULTS.keepAliveMs;
    this.#idleStopMs = options.idleStopMs ?? DEFAULTS.idleStopMs;
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULTS.maxFrameBytes;
    this.#retryMs = options.retryMs ?? DEFAULTS.retryMs;
    this.#stalledResync = options.stalledResyncThreshold ?? DEFAULTS.stalledResyncThreshold;
    this.#stalledClose = options.stalledCloseThreshold ?? DEFAULTS.stalledCloseThreshold;
    this.#serverStartedAt = options.serverStartedAt ?? this.#timers.now();
  }

  get size(): number {
    return this.#clients.size;
  }

  /** True while the 1 s cursor poll is armed. An idle app has no timer at all. */
  get polling(): boolean {
    return this.#pollHandle !== null;
  }

  get serverStartedAt(): number {
    return this.#serverStartedAt;
  }

  /**
   * Register a stream: sends `retry:` + `hello`, then either replays from `Last-Event-ID` or
   * tells the client to resync, and finally arms the poller.
   */
  add(init: HubClientInit): HubClient {
    const now = this.#timers.now();
    const seq = this.#source.cursorSeq();
    const client: InternalClient = {
      id: this.#nextClientId++,
      userId: init.userId,
      lastSeq: seq,
      stalled: 0,
      connectedAt: now,
      lastWriteAt: now,
      write: init.write,
      close: init.close,
    };
    this.#clients.add(client);
    this.#knownSeq = seq;

    this.#send(client, `retry: ${this.#retryMs}\n\n`);
    this.#sendFrame(client, "hello", seq, {
      seq,
      serverStartedAt: this.#serverStartedAt,
      items: init.helloItems ?? [],
    });

    const resumeFrom = init.lastEventId ?? 0;
    if (resumeFrom > 0 && resumeFrom < seq) {
      const oldest = this.#source.oldestSeq();
      if (oldest !== null && oldest <= resumeFrom + 1) {
        client.lastSeq = resumeFrom;
        this.#flush(client, this.#source.eventsAfter(resumeFrom));
      } else {
        // The rows this client missed have been pruned: it must refetch rather than guess.
        this.#resync(client, seq, "gap");
      }
    }

    this.#startPolling();
    return client;
  }

  /** Drop a client (aborted request, cancelled stream). Idempotent. */
  remove(client: HubClient): void {
    const internal = client as InternalClient;
    if (!this.#clients.delete(internal)) return;
    try {
      internal.close();
    } catch {
      // A closed controller throwing on close is normal; nothing to do.
    }
    if (this.#clients.size === 0) this.#scheduleIdleStop();
  }

  /**
   * One poll tick: read the counter, and only on a change read the rows. Exposed so tests can
   * step the hub without a real interval.
   */
  tick(): void {
    const now = this.#timers.now();
    const seq = this.#source.cursorSeq();

    if (seq !== this.#knownSeq) {
      this.#knownSeq = seq;
      let minSeq = Number.POSITIVE_INFINITY;
      for (const client of this.#clients) minSeq = Math.min(minSeq, client.lastSeq);
      if (Number.isFinite(minSeq) && minSeq < seq) {
        const rows = this.#source.eventsAfter(minSeq);
        for (const client of [...this.#clients]) this.#flush(client, rows);
      }
    }

    for (const client of [...this.#clients]) {
      if (now - client.lastWriteAt >= this.#keepAliveMs) {
        this.#send(client, `: keep-alive ${now}\n\n`);
        this.#escalate(client);
      }
    }
  }

  /** `SIGTERM`: tell every client we are going away, then close everything. */
  shutdown(reason = "shutdown"): void {
    this.#shuttingDown = true;
    for (const client of [...this.#clients]) {
      this.#sendFrame(client, "bye", null, { reason });
      this.remove(client);
    }
    this.#stopPolling();
    this.#shuttingDown = false;
  }

  /* ---------------------------------------------------------------- internals */

  #startPolling(): void {
    if (this.#idleHandle !== null) {
      this.#timers.clearTimeout(this.#idleHandle);
      this.#idleHandle = null;
    }
    if (this.#pollHandle !== null) return;
    this.#pollHandle = this.#timers.setInterval(() => {
      this.tick();
    }, this.#pollMs);
  }

  #scheduleIdleStop(): void {
    if (this.#shuttingDown || this.#idleHandle !== null) return;
    this.#idleHandle = this.#timers.setTimeout(() => {
      this.#idleHandle = null;
      if (this.#clients.size === 0) this.#stopPolling();
    }, this.#idleStopMs);
  }

  #stopPolling(): void {
    if (this.#pollHandle !== null) {
      this.#timers.clearInterval(this.#pollHandle);
      this.#pollHandle = null;
    }
    if (this.#idleHandle !== null) {
      this.#timers.clearTimeout(this.#idleHandle);
      this.#idleHandle = null;
    }
  }

  /** Send the coalesced tail of `rows` that this client has not seen. */
  #flush(client: InternalClient, rows: readonly OutboxRow[]): void {
    const mine = rows.filter((row) => row.seq > client.lastSeq);
    if (mine.length === 0) return;

    const maxSeq = mine[mine.length - 1]!.seq;
    client.lastSeq = maxSeq;

    const items = coalesceRows(mine);
    const data = JSON.stringify({ seq: maxSeq, items });
    if (Buffer.byteLength(data, "utf8") > this.#maxFrameBytes) {
      // A burst too big to frame is a refetch, not a giant push.
      this.#resync(client, maxSeq, "too_large");
      return;
    }
    this.#sendFrame(client, "batch", maxSeq, data);
    this.#escalate(client);
  }

  #resync(client: InternalClient, seq: number, reason: HubResyncReason): void {
    this.#sendFrame(client, "resync", null, { seq, reason });
  }

  #sendFrame(client: InternalClient, event: string, id: number | null, data: unknown): void {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    const idLine = id === null ? "" : `id: ${id}\n`;
    this.#send(client, `event: ${event}\n${idLine}data: ${body}\n\n`);
  }

  #send(client: InternalClient, chunk: string): void {
    let accepted: boolean;
    try {
      accepted = client.write(chunk);
    } catch {
      // The stream is gone (browser navigated away mid-write).
      this.remove(client);
      return;
    }
    client.lastWriteAt = this.#timers.now();
    if (accepted) {
      client.stalled = 0;
      return;
    }
    client.stalled += 1;
  }

  /**
   * Act on accumulated backpressure. Called *after* a data write, never from inside `#send`, so a
   * `resync` frame cannot recurse into another escalation.
   */
  #escalate(client: InternalClient): void {
    if (!this.#clients.has(client)) return;
    if (client.stalled >= this.#stalledClose) {
      // The browser's EventSource reconnects on its own and gets a fresh `hello`.
      this.remove(client);
      return;
    }
    if (client.stalled === this.#stalledResync) {
      this.#sendFrame(client, "resync", null, { seq: client.lastSeq, reason: "backpressure" });
    }
  }
}

/**
 * Stage 2 coalescing (§7.3): at most one item per `(topic, key)`, newest wins, ordered by
 * sequence. 40 dimmer updates in one window become one item.
 */
export function coalesceRows(rows: readonly OutboxRow[]): HubBatchItem[] {
  const latest = new Map<string, HubBatchItem>();
  for (const row of rows) {
    latest.set(`${row.topic} ${row.key ?? ""}`, {
      seq: row.seq,
      topic: row.topic,
      key: row.key,
      at: row.at,
      payload: row.payload,
    });
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq);
}

/* ---------------------------------------------------------------- singleton */

const HUB_KEY = Symbol.for("virtual-home.event-hub");

interface HubGlobal {
  [HUB_KEY]?: Hub;
}

/**
 * One hub per process. A `globalThis` symbol rather than a module-level `let`, because Next's
 * module graph (and dev HMR) can evaluate this file more than once — and two pollers would double
 * every frame.
 */
export function getHub(options?: HubOptions): Hub {
  const store = globalThis as unknown as HubGlobal;
  store[HUB_KEY] ??= new Hub(options);
  return store[HUB_KEY];
}

/** Tests: install a hub built with fakes, or clear the singleton. */
export function setHubForTests(hub: Hub | null): void {
  const store = globalThis as unknown as HubGlobal;
  if (hub === null) delete store[HUB_KEY];
  else store[HUB_KEY] = hub;
}
