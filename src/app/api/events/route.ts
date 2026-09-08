/**
 * GET /api/events — the household's single Server-Sent Events stream.
 *
 * Design: `docs/design-notes/auth-security-operations.md` §7.5. The transport is the SQLite
 * outbox: the worker writes rows, this process polls one counter once a second and fans out.
 *
 * Two headers are load-bearing rather than decorative:
 *  - `Cache-Control: private, no-store, no-transform` — `no-transform` stops a proxy from
 *    "helpfully" buffering or gzipping the stream, which turns SSE into a page that never loads.
 *  - `X-Accel-Buffering: no` — belt and braces with nginx's `proxy_buffering off`.
 *
 * The `hello` frame carries a snapshot of the cached HA states the workspace renders, so a cold
 * page load paints the markers immediately instead of waiting for the first entity to change.
 */
import { getDb } from "@/db/client";
import { loadEnv } from "@/env";
import { authed } from "@/server/api/handler";
import { getHub, type HubBatchItem } from "@/server/events/hub";
import { EVENT_TOPICS, readCursorSeq } from "@/server/events/outbox";
import { readSnapshot, renderableEntityIds } from "@/server/ha/stateCache";

export const dynamic = "force-dynamic";

/** Unread bytes a client may accumulate before `write()` reports backpressure. */
const MAX_BUFFERED_BYTES = 64 * 1024;

/** `Last-Event-ID` is client-supplied; anything that is not a positive integer means "from now". */
function parseLastEventId(req: Request): number {
  const raw = req.headers.get("last-event-id");
  if (!raw) return 0;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * The cached state of every entity the 3D workspace can render — linked entities and canonical
 * battery entities — shaped exactly like a `ha.state` batch item so the client's existing parser
 * handles `hello` and `batch` with the same code path.
 */
function helloSnapshot(seq: number): HubBatchItem[] {
  const db = getDb().db;
  const rows = readSnapshot(db, renderableEntityIds(db));
  return rows.map((row) => ({
    seq,
    topic: EVENT_TOPICS.haState,
    key: row.entityId,
    at: row.observedAtMs,
    payload: {
      state: row.state,
      attributes: row.attributes,
      lastUpdated: row.lastUpdatedMs,
    },
  }));
}

export const GET = authed(async (session, req) => {
  const env = loadEnv();
  const hub = getHub({ pollMs: env.VH_EVENT_POLL_MS });

  if (hub.size >= env.VH_SSE_MAX_CLIENTS) {
    // A hard cap, not a queue: an unbounded number of streams is an unbounded number of open
    // sockets and coalescing buffers. `Retry-After` makes EventSource back off politely.
    return new Response("too many streams\n", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
        "Retry-After": "5",
      },
    });
  }

  const lastEventId = parseLastEventId(req);
  const items = helloSnapshot(readCursorSeq(getDb().db));
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const client = hub.add({
          userId: session.user.id,
          lastEventId,
          helloItems: items,
          write: (chunk) => {
            controller.enqueue(encoder.encode(chunk));
            // With the byte-length strategy below, `desiredSize` is "bytes of headroom left".
            // It only goes non-positive once a consumer has let a whole frame's worth of data
            // pile up unread, which is exactly the backpressure the hub escalates on.
            return (controller.desiredSize ?? 1) > 0;
          },
          close: () => {
            try {
              controller.close();
            } catch {
              // Already closed by an abort; nothing to do.
            }
          },
        });

        // The abort fires on navigation, tab close, and on the client's own
        // `EventSource.close()`.
        if (req.signal.aborted) hub.remove(client);
        else
          req.signal.addEventListener(
            "abort",
            () => {
              hub.remove(client);
            },
            { once: true },
          );
      },
    },
    // Count-based queuing (the default `highWaterMark: 1`) would report backpressure after every
    // single chunk, including the `retry:` + `hello` pair written synchronously on connect. Byte
    // length matched to the hub's frame cap makes "not draining" mean what it says.
    new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
