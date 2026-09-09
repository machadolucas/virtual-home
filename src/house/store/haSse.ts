/**
 * `EventSource` client for the shared event stream.
 *
 * Frame shape (`event: batch`):
 *
 *   { seq: 42, items: [{ topic: 'ha.state', key: 'sensor.x',
 *                        payload: { state: '23.4', attributes: {...}, lastUpdated: 1699… } }] }
 *
 * The endpoint (`/api/events`) is written by another part of the app and may not exist yet: a 404
 * or a 401 must degrade quietly to "HA layer unavailable", never break the workspace. `EventSource`
 * cannot read a status code, so an immediate error with `readyState === CLOSED` is treated as
 * "endpoint not there (yet)" and probed with a plain `fetch` before giving up for good.
 *
 * Two control frames the hub can send, besides `hello`/`batch`:
 *
 *  - `resync` — "your snapshot is stale, start over". The client drops the connection and re-opens
 *    it, which re-delivers `hello` (the full snapshot) rather than trying to patch a gap it cannot
 *    see. `onResync` fires too, so the workspace can re-fetch whatever else the frame invalidated.
 *  - `bye` — a graceful server-side close (a worker restart, a deploy). Treated as a **planned**
 *    disconnect: it does not count as a failure, so it does not walk up the backoff ladder or trip
 *    the "give up" threshold, and reconnection starts from the first, shortest delay.
 *
 * HA credentials never reach the browser: the server holds the token and we only see frames.
 */
import { haStore, type EntityState } from "./haStore";

export const EVENTS_URL = "/api/events";

/** 1 s → 2 s → 4 s → 8 s → 15 s cap, ±20 % jitter. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const MAX_QUIET_FAILURES = 3;

interface BatchItem {
  topic: string;
  key: string;
  payload?: {
    state?: unknown;
    attributes?: Record<string, unknown>;
    lastUpdated?: unknown;
  };
}

interface BatchFrame {
  seq?: number;
  items?: BatchItem[];
}

export interface HaSseOptions {
  url?: string;
  /** Only these entity ids are of interest; everything else in a frame is ignored. */
  entityIds?: readonly string[];
  onUnavailable?: (reason: "not_found" | "unauthorized" | "unsupported") => void;
  /**
   * The server asked for a full re-sync (`event: resync`). The stream reconnects itself, which
   * brings the `hello` snapshot back; this callback is for everything *else* the workspace holds —
   * placements, routes, annotations — so it can be re-fetched in the same breath.
   */
  onResync?: (reason: string | null) => void;
  /** The server closed the stream on purpose (`event: bye`), with its stated reason if any. */
  onBye?: (reason: string | null) => void;
}

export interface HaSseHandle {
  close(): void;
  /** Explicit user-driven reconnect, after the client gave up. */
  reconnect(): void;
  readonly failures: number;
  /** How many `resync` frames have been honoured. The idle test asserts this stays at 0. */
  readonly resyncs: number;
}

export function connectHaSse(opts: HaSseOptions = {}): HaSseHandle {
  const url = opts.url ?? EVENTS_URL;
  const wanted = opts.entityIds ? new Set(opts.entityIds) : null;
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let closed = false;
  let gaveUp = false;
  let resyncs = 0;

  if (typeof EventSource === "undefined") {
    haStore.getState().setConnection("closed");
    opts.onUnavailable?.("unsupported");
    return {
      close: () => {},
      reconnect: () => {},
      get failures() {
        return 0;
      },
      get resyncs() {
        return 0;
      },
    };
  }

  const parse = (raw: string): void => {
    let frame: BatchFrame;
    try {
      frame = JSON.parse(raw) as BatchFrame;
    } catch {
      return;
    }
    const events: EntityState[] = [];
    for (const item of frame.items ?? []) {
      if (item.topic !== "ha.state" || typeof item.key !== "string") continue;
      if (wanted && !wanted.has(item.key)) continue;
      const payload = item.payload ?? {};
      const attributes = payload.attributes ?? {};
      events.push({
        entityId: item.key,
        state: typeof payload.state === "string" ? payload.state : String(payload.state ?? "unknown"),
        lastUpdated: toMs(payload.lastUpdated),
        battery: numberOrNull(attributes.battery_level ?? attributes.battery),
        batteryType: stringOrNull(attributes.battery_type),
        unit: stringOrNull(attributes.unit_of_measurement),
        deviceClass: stringOrNull(attributes.device_class),
        brightness: numberOrNull(attributes.brightness),
        rgbColor: numberTupleOrNull(attributes.rgb_color, 3),
        hsColor: numberTupleOrNull(attributes.hs_color, 2),
        colorTempKelvin: numberOrNull(attributes.color_temp_kelvin),
        colorTempMireds: numberOrNull(attributes.color_temp_mireds ?? attributes.color_temp),
      });
    }
    if (typeof frame.seq === "number") haStore.getState().setSeq(frame.seq);
    if (events.length) haStore.getState().applyBatch(events);
  };

  const scheduleReconnect = (): void => {
    if (closed || gaveUp) return;
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 15000;
    const jittered = delay * (0.8 + Math.random() * 0.4);
    timer = setTimeout(open, jittered);
  };

  /** `EventSource` hides the status code, so probe once to tell "missing" from "flaky". */
  const probe = async (): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        credentials: "same-origin",
      });
      // Read nothing: we only want the status.
      void res.body?.cancel();
      if (res.status === 404) {
        gaveUp = true;
        haStore.getState().setConnection("closed");
        opts.onUnavailable?.("not_found");
        return;
      }
      if (res.status === 401 || res.status === 403) {
        gaveUp = true;
        haStore.getState().setConnection("closed");
        opts.onUnavailable?.("unauthorized");
        return;
      }
    } catch {
      // Network error: fall through to the normal backoff.
    }
    scheduleReconnect();
  };

  const reasonOf = (raw: string): string | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { reason?: unknown };
      return typeof parsed.reason === "string" ? parsed.reason : null;
    } catch {
      // A bare string payload ("shutdown") is legal too.
      return raw.trim() || null;
    }
  };

  /**
   * Drop the socket and open a new one, without counting a failure. Used by both control frames:
   * a planned reconnect must not consume the failure budget that exists to detect a broken server.
   */
  const reopen = (delayMs: number): void => {
    if (closed || gaveUp) return;
    source?.close();
    source = null;
    failures = 0;
    haStore.getState().setConnection("connecting");
    if (timer) clearTimeout(timer);
    timer = setTimeout(open, delayMs);
  };

  const open = (): void => {
    if (closed) return;
    haStore.getState().setConnection(failures === 0 ? "connecting" : "retrying");
    source = new EventSource(url, { withCredentials: true });

    source.addEventListener("open", () => {
      failures = 0;
      haStore.getState().setConnection("open");
    });

    source.addEventListener("batch", (event) => {
      parse((event as MessageEvent<string>).data);
    });

    // Some servers emit the snapshot as `hello` before the first batch.
    source.addEventListener("hello", (event) => {
      parse((event as MessageEvent<string>).data);
    });

    /**
     * The hub cannot bridge the gap for us (it does not know what we missed), so a `resync` is
     * answered by starting over: reconnect, take the `hello` snapshot again, and tell the caller so
     * it can re-fetch the data that does not travel on this stream.
     */
    source.addEventListener("resync", (event) => {
      const reason = reasonOf((event as MessageEvent<string>).data);
      resyncs++;
      opts.onResync?.(reason);
      // A short, jittered delay rather than an immediate reopen: a hub that resyncs every client at
      // once (a worker restart) must not be met by every client reconnecting in the same tick.
      reopen(250 + Math.random() * 500);
    });

    /** A planned close. Not a failure: reconnect from the shortest delay, budget untouched. */
    source.addEventListener("bye", (event) => {
      const reason = reasonOf((event as MessageEvent<string>).data);
      opts.onBye?.(reason);
      haStore.getState().setConnection("retrying");
      reopen(BACKOFF_MS[0] ?? 1000);
    });

    source.addEventListener("error", () => {
      const wasOpen = haStore.getState().connection === "open";
      source?.close();
      source = null;
      failures++;
      haStore.getState().setConnection(failures >= MAX_QUIET_FAILURES ? "closed" : "retrying");
      if (!wasOpen && failures === 1) void probe();
      else if (failures < MAX_QUIET_FAILURES) scheduleReconnect();
    });
  };

  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      source?.close();
      source = null;
      haStore.getState().setConnection("closed");
    },
    reconnect() {
      if (timer) clearTimeout(timer);
      timer = null;
      failures = 0;
      gaveUp = false;
      closed = false;
      source?.close();
      source = null;
      open();
    },
    get failures() {
      return failures;
    },
    get resyncs() {
      return resyncs;
    },
  };
}

function toMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberTupleOrNull(value: unknown, size: 2): [number, number] | null;
function numberTupleOrNull(value: unknown, size: 3): [number, number, number] | null;
function numberTupleOrNull(value: unknown, size: 2 | 3): [number, number] | [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== size) return null;
  const tuple = value.map(numberOrNull);
  if (!tuple.every((part): part is number => part !== null)) return null;
  return size === 2 ? [tuple[0]!, tuple[1]!] : [tuple[0]!, tuple[1]!, tuple[2]!];
}
