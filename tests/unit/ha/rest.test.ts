import { describe, expect, it } from "vitest";
import { HaRestError, checkToken, fetchHistory, type FetchLike } from "@/worker/ha/rest";

const HA_URL = "http://192.168.1.181:8123";
const TOKEN = "a-very-long-lived-access-token-value";

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function recorder(response: () => Response | Promise<Response>): {
  fetchImpl: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} });
    return response();
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchHistory", () => {
  const startIso = "2026-09-01T00:00:00.000Z";
  const endIso = "2026-09-08T00:00:00.000Z";

  it("builds the documented minimal-response URL and sends the token only as a header", async () => {
    const { fetchImpl, calls } = recorder(() =>
      json([
        [
          {
            entity_id: "sensor.bedroom_door_sensor_battery",
            state: "68",
            last_changed: "2026-09-01T01:00:00.000Z",
          },
          { state: "67", last_changed: "2026-09-03T01:00:00.000Z" },
        ],
      ]),
    );

    const series = await fetchHistory({
      haUrl: HA_URL,
      token: TOKEN,
      entityId: "sensor.bedroom_door_sensor_battery",
      startIso,
      endIso,
      fetchImpl,
    });

    const call = calls[0];
    expect(call).toBeDefined();
    const url = new URL(call!.url);
    expect(url.pathname).toBe(`/api/history/period/${encodeURIComponent(startIso)}`);
    expect(url.searchParams.get("filter_entity_id")).toBe("sensor.bedroom_door_sensor_battery");
    expect(url.searchParams.get("end_time")).toBe(endIso);
    expect(url.searchParams.get("minimal_response")).toBe("true");
    expect(url.searchParams.get("no_attributes")).toBe("true");
    expect(call!.url).not.toContain(TOKEN);
    expect(call!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(series.entityId).toBe("sensor.bedroom_door_sensor_battery");
    expect(series.points).toEqual([
      { atMs: Date.parse("2026-09-01T01:00:00.000Z"), raw: "68", value: 68 },
      { atMs: Date.parse("2026-09-03T01:00:00.000Z"), raw: "67", value: 67 },
    ]);
  });

  it("keeps non-numeric readings as raw with a null value, never 0", async () => {
    const { fetchImpl } = recorder(() =>
      json([
        [
          { state: "unavailable", last_changed: "2026-09-01T01:00:00.000Z" },
          { state: "unknown", last_changed: "2026-09-01T02:00:00.000Z" },
          { state: "0", last_changed: "2026-09-01T03:00:00.000Z" },
        ],
      ]),
    );
    const series = await fetchHistory({
      haUrl: HA_URL,
      token: TOKEN,
      entityId: "sensor.x",
      startIso,
      endIso,
      fetchImpl,
    });
    expect(series.points.map((p) => p.value)).toEqual([null, null, 0]);
  });

  it("rejects an entity_id that is not a plain HA entity id", async () => {
    const { fetchImpl, calls } = recorder(() => json([[]]));
    await expect(
      fetchHistory({
        haUrl: HA_URL,
        token: TOKEN,
        entityId: "sensor.x&filter_entity_id=camera.front_door",
        startIso,
        endIso,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HaRestError);
    expect(calls).toHaveLength(0);
  });

  it("rejects non-ISO bounds", async () => {
    const { fetchImpl } = recorder(() => json([[]]));
    await expect(
      fetchHistory({
        haUrl: HA_URL,
        token: TOKEN,
        entityId: "sensor.x",
        startIso: "yesterday",
        endIso,
        fetchImpl,
      }),
    ).rejects.toThrow(/startIso/);
  });

  it("surfaces an upstream status without leaking the token", async () => {
    const { fetchImpl } = recorder(() => json({ message: "not found" }, 404));
    const error = await fetchHistory({
      haUrl: HA_URL,
      token: TOKEN,
      entityId: "sensor.x",
      startIso,
      endIso,
      fetchImpl,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HaRestError);
    expect((error as HaRestError).status).toBe(404);
    expect((error as HaRestError).kind).toBe("http");
    expect((error as HaRestError).message).not.toContain(TOKEN);
  });

  it("redacts the token when the underlying fetch error echoes it", async () => {
    const fetchImpl: FetchLike = () => {
      throw new Error(`connect ECONNREFUSED (authorization: Bearer ${TOKEN})`);
    };
    const error = await fetchHistory({
      haUrl: HA_URL,
      token: TOKEN,
      entityId: "sensor.x",
      startIso,
      endIso,
      fetchImpl,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HaRestError);
    expect((error as HaRestError).message).not.toContain(TOKEN);
    expect((error as HaRestError).message).toContain("[redacted]");
  });

  it("rejects a response that is not a history payload", async () => {
    const { fetchImpl } = recorder(() => json({ not: "history" }));
    await expect(
      fetchHistory({
        haUrl: HA_URL,
        token: TOKEN,
        entityId: "sensor.x",
        startIso,
        endIso,
        fetchImpl,
      }),
    ).rejects.toMatchObject({ kind: "payload" });
  });
});

describe("checkToken", () => {
  it("reports authorized on a 2xx from GET /api/", async () => {
    const { fetchImpl, calls } = recorder(() => json({ message: "API running." }));
    const result = await checkToken({ haUrl: HA_URL, token: TOKEN, fetchImpl });
    expect(result).toEqual({ ok: true, status: 200, kind: "authorized" });
    expect(new URL(calls[0]!.url).pathname).toBe("/api/");
  });

  it("distinguishes a rejected token from an unreachable instance", async () => {
    const unauthorized = recorder(() => json({ message: "Unauthorized" }, 401));
    await expect(
      checkToken({ haUrl: HA_URL, token: TOKEN, fetchImpl: unauthorized.fetchImpl }),
    ).resolves.toMatchObject({ ok: false, status: 401, kind: "unauthorized" });

    const down: FetchLike = () => {
      throw new Error(`getaddrinfo ENOTFOUND, token was ${TOKEN}`);
    };
    const result = await checkToken({ haUrl: HA_URL, token: TOKEN, fetchImpl: down });
    expect(result.kind).toBe("unreachable");
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(TOKEN);
  });

  it("reports an unexpected status without throwing", async () => {
    const { fetchImpl } = recorder(() => json({}, 502));
    await expect(
      checkToken({ haUrl: HA_URL, token: TOKEN, fetchImpl }),
    ).resolves.toMatchObject({ ok: false, status: 502, kind: "unexpected" });
  });
});
