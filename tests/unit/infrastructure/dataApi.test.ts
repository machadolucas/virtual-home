/**
 * The client side of the seam: the REST data API and the two SSE control frames.
 *
 * No server here — `fetch` and `EventSource` are both faked — because what is being asserted is the
 * *contract the client promises*: every coordinate write states `viewMode: "normal"`, a segment's
 * floor/room reaches the per-point shape the table stores, a 409 degrades to the session store
 * instead of throwing away the user's work, and a `resync`/`bye` frame reconnects without burning
 * the failure budget that exists to detect a genuinely broken server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NotPersistedError,
  createMemoryDataApi,
  createResilientDataApi,
  createRestDataApi,
  routeWrite,
  type RouteSave,
} from "@/house/store/dataApi";
import { connectHaSse } from "@/house/store/haSse";
import { haStore } from "@/house/store/haStore";

function route(over: Partial<RouteSave> = {}): RouteSave {
  return {
    id: "route-1",
    modelId: "fixture-house",
    name: "Cold water to the sink",
    system: "water",
    kind: "pipe",
    points: [
      [1, 0.4, 1],
      [2, 0.4, 1],
      [3, 0.4, 1],
    ],
    segments: [
      { floorId: "f-lower", roomId: "r-l-a" },
      { floorId: "f-lower", roomId: "r-l-b" },
    ],
    certainty: "inferred",
    lifecycle: "installed",
    endpoints: [],
    photoIds: [],
    ...over,
  };
}

describe("routeWrite", () => {
  it("spreads per-segment floor/room onto the points the table stores", () => {
    const body = routeWrite(route()) as { points: Array<{ floorId: string; roomId: string }> };
    expect(body.points).toHaveLength(3);
    expect(body.points[0]).toMatchObject({ floorId: "f-lower", roomId: "r-l-a" });
    expect(body.points[1]).toMatchObject({ floorId: "f-lower", roomId: "r-l-b" });
    // The last point is only ever the end of a span, so it inherits the previous one's place.
    expect(body.points[2]).toMatchObject({ floorId: "f-lower", roomId: "r-l-b" });
  });

  it("derives a medium from the system, and keeps an explicit one", () => {
    expect(routeWrite(route()).medium).toBe("cold_water");
    expect(routeWrite(route({ medium: "hot_water" })).medium).toBe("hot_water");
  });

  it("marks anything that is not measured as estimated, unless told otherwise", () => {
    expect(routeWrite(route({ certainty: "inferred" })).isEstimated).toBe(true);
    expect(routeWrite(route({ certainty: "measured" })).isEstimated).toBe(false);
    expect(routeWrite(route({ certainty: "measured", isEstimated: true })).isEstimated).toBe(true);
  });

  it("carries the dates, the offset and the project through under their stored names", () => {
    const body = routeWrite(
      route({
        installedAt: "2012-08-15",
        removedAt: "2019-05-01",
        depthM: -0.04,
        offsetFrom: { surfaceId: "s-w-1", kind: "wall", offsetM: 0.02 },
        renovationId: "project-7",
        note: "behind the panel",
        photoIds: ["a1"],
      }),
    );
    expect(body).toMatchObject({
      installedOn: "2012-08-15",
      removedOn: "2019-05-01",
      depthM: -0.04,
      offsetSurfaceId: "s-w-1",
      offsetM: 0.02,
      projectId: "project-7",
      notes: "behind the panel",
      photoAttachmentIds: ["a1"],
    });
  });
});

describe("REST client", () => {
  interface Call {
    url: string;
    method: string;
    body: Record<string, unknown>;
  }

  function fakeFetch(
    respond: (call: Call) => { status?: number; body?: unknown },
  ): { calls: Call[]; impl: typeof fetch } {
    const calls: Call[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const { status = 200, body = {} } = respond(call);
      return new Response(status === 204 ? null : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("states viewMode normal on every write that carries a coordinate", async () => {
    const { calls, impl } = fakeFetch(() => ({ body: { route: route(), placement: {} } }));
    const api = createRestDataApi({ fetchImpl: impl });

    await api.saveRoute("m1", "fp", route());
    await api.saveEndpoint("m1", "fp", { name: "Shutoff", kind: "shutoff", position: [1, 1, 1] });
    await api.saveAnnotation("m1", "fp", {
      targetKind: "node",
      targetId: null,
      modelNodeId: "r-l-a",
      position: [1, 1, 1],
      kind: "note",
      title: "note",
      body: null,
      measurementValue: null,
      measurementUnit: null,
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.method).toBe("PUT");
      expect(call.body.viewMode).toBe("normal");
      expect(call.body.fingerprint).toBe("fp");
    }
  });

  it("sends the placement's mount, note, photo and symbol", async () => {
    const { calls, impl } = fakeFetch(() => ({ body: { placement: {} } }));
    const api = createRestDataApi({ fetchImpl: impl });
    await api.savePlacement("m1", "fp", {
      id: "p1",
      modelId: "m1",
      equipmentId: "a1",
      name: "Sensor",
      position: [1, 1.4, 1],
      rotationYDeg: 0,
      mount: { kind: "wall", surfaceId: "s-w-1", height: 1.4, offset: 0.02 },
      floorId: "f-lower",
      roomId: "r-l-a",
      surfaceId: "s-w-1",
      locationNote: "left of the hatch",
      photoId: "att-1",
      entityId: null,
      symbol: "lamp_post",
      category: null,
    });
    const sent = calls[0]?.body.placement as Record<string, unknown>;
    expect(sent.mount).toEqual({ kind: "wall", surfaceId: "s-w-1", height: 1.4, offset: 0.02 });
    expect(sent.locationNote).toBe("left of the hatch");
    expect(sent.photoId).toBe("att-1");
    expect(sent.symbol).toBe("lamp_post");
  });

  it("asks for a soft delete by default and a hard one only when told", async () => {
    const { calls, impl } = fakeFetch(() => ({ status: 204 }));
    const api = createRestDataApi({ fetchImpl: impl });
    await api.deleteRoute("m1", "r1");
    await api.deleteRoute("m1", "r1", { hard: true });
    expect(calls[0]?.url).not.toContain("hard=1");
    expect(calls[1]?.url).toContain("hard=1");
  });

  it("turns a 409 into NotPersistedError carrying the server's own code", async () => {
    const { impl } = fakeFetch(() => ({ status: 409, body: { error: "model_revision_missing" } }));
    const api = createRestDataApi({ fetchImpl: impl });
    await expect(api.saveRoute("m1", "fp", route())).rejects.toThrow(NotPersistedError);
    await api.saveRoute("m1", "fp", route()).catch((err: unknown) => {
      expect((err as NotPersistedError).reason).toBe("model_revision_missing");
    });
  });

  it("throws (rather than silently falling back) on a real server error", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const api = createRestDataApi({ fetchImpl: impl });
    await expect(api.listRoutes("m1")).rejects.toThrow(/500/);
  });
});

describe("resilient wrapper", () => {
  it("keeps the drawing in the session store when the server has nowhere to put it", async () => {
    const { impl } = fakeFetchAlways409();
    const reasons: string[] = [];
    const api = createResilientDataApi(
      createRestDataApi({ fetchImpl: impl }),
      createMemoryDataApi(),
      (reason) => reasons.push(reason),
    );

    const saved = await api.saveRoute("m1", "fp", route());
    expect(saved.id).toBe("route-1");
    expect(reasons).toEqual(["model_revision_missing"]);
    expect(await api.listRoutes("m1")).toHaveLength(1);
  });

  function fakeFetchAlways409(): { impl: typeof fetch } {
    const impl = (async () =>
      new Response(JSON.stringify({ error: "model_revision_missing" }), {
        status: 409,
      })) as unknown as typeof fetch;
    return { impl };
  }
});

describe("in-memory data API", () => {
  it("mirrors the server's soft-delete semantics so the UI behaves the same either way", async () => {
    const api = createMemoryDataApi({ routes: [route()] });
    await api.deleteRoute("m1", "route-1");
    const [after] = await api.listRoutes("m1");
    expect(after?.lifecycle).toBe("removed");

    await api.deleteRoute("m1", "route-1", { hard: true });
    expect(await api.listRoutes("m1")).toHaveLength(0);
  });

  it("assigns local ids to new endpoints and annotations", async () => {
    const api = createMemoryDataApi();
    const endpoint = await api.saveEndpoint("m1", "fp", { name: "Valve", kind: "shutoff" });
    expect(endpoint.id).toContain("local");
    const pin = await api.saveAnnotation("m1", "fp", {
      targetKind: "node",
      targetId: null,
      modelNodeId: "r-l-a",
      position: null,
      kind: "note",
      title: "note",
      body: null,
      measurementValue: null,
      measurementUnit: null,
    });
    expect(pin.id).toContain("local");
    expect(await api.listAnnotations("m1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SSE control frames
// ---------------------------------------------------------------------------

interface FakeSource {
  url: string;
  listeners: Map<string, Array<(event: MessageEvent<string>) => void>>;
  closed: boolean;
  emit(type: string, data?: string): void;
}

const sources: FakeSource[] = [];

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  private readonly self: FakeSource;

  constructor(url: string) {
    this.self = {
      url,
      listeners: new Map(),
      closed: false,
      emit: (type, data = "") => {
        for (const fn of this.self.listeners.get(type) ?? [])
          fn({ data } as MessageEvent<string>);
      },
    };
    sources.push(this.self);
  }

  addEventListener(type: string, fn: (event: MessageEvent<string>) => void): void {
    const list = this.self.listeners.get(type);
    if (list) list.push(fn);
    else this.self.listeners.set(type, [fn]);
  }

  close(): void {
    this.self.closed = true;
  }
}

describe("haSse control frames", () => {
  beforeEach(() => {
    sources.length = 0;
    vi.useFakeTimers();
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    haStore.getState().setConnection("closed");
  });

  it("re-opens on `resync` so the `hello` snapshot arrives again, without a failure", () => {
    const resyncs: Array<string | null> = [];
    const handle = connectHaSse({ onResync: (reason) => resyncs.push(reason) });
    expect(sources).toHaveLength(1);

    sources[0]?.emit("open");
    sources[0]?.emit("resync", JSON.stringify({ reason: "worker_restart" }));

    expect(resyncs).toEqual(["worker_restart"]);
    expect(sources[0]?.closed).toBe(true);
    expect(handle.resyncs).toBe(1);
    // Reconnect is scheduled, not immediate: a hub resyncing every client at once must not be met
    // by every client reconnecting in the same tick.
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    // A planned reconnect does not consume the budget that exists to detect a broken server.
    expect(handle.failures).toBe(0);

    // The new stream delivers the snapshot again.
    sources[1]?.emit("open");
    sources[1]?.emit(
      "hello",
      JSON.stringify({
        seq: 7,
        items: [{
          topic: "ha.state",
          key: "sensor.x",
          payload: {
            state: "on",
            attributes: {
              brightness: 153,
              rgb_color: [240, 210, 180],
              hs_color: [31, 25],
              color_temp_kelvin: 2700,
              color_temp: 370,
            },
          },
        }],
      }),
    );
    expect(haStore.getState().lastSeq).toBe(7);
    expect(haStore.getState().entities["sensor.x"]).toMatchObject({
      state: "on",
      brightness: 153,
      rgbColor: [240, 210, 180],
      hsColor: [31, 25],
      colorTempKelvin: 2700,
      colorTempMireds: 370,
    });

    handle.close();
  });

  it("treats `bye` as a planned close: reconnects from the shortest delay, budget untouched", () => {
    const byes: Array<string | null> = [];
    const handle = connectHaSse({ onBye: (reason) => byes.push(reason) });
    sources[0]?.emit("open");
    sources[0]?.emit("bye", JSON.stringify({ reason: "shutdown" }));

    expect(byes).toEqual(["shutdown"]);
    expect(haStore.getState().connection).toBe("connecting");
    expect(handle.failures).toBe(0);
    expect(handle.resyncs).toBe(0);

    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(2);
    handle.close();
  });

  it("reads a bare string reason as well as a JSON one", () => {
    const byes: Array<string | null> = [];
    const handle = connectHaSse({ onBye: (reason) => byes.push(reason) });
    sources[0]?.emit("bye", "shutdown");
    expect(byes).toEqual(["shutdown"]);
    handle.close();
  });
});
