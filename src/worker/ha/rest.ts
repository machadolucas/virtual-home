/**
 * The only two HA REST calls virtual-home makes.
 *
 * `fetchHistory` — on-demand history for one entity. The WebSocket carries the present; the
 * recorder's past is only ever read when a user opens a chart, so it stays request-scoped and no
 * telemetry is copied into our database (§8.6, §7.1).
 *
 * `checkToken` — a cheap `GET /api/` to distinguish "bad token" from "HA unreachable" in
 * `/settings/system` and in `vh-admin doctor`.
 *
 * The caller is responsible for the entity allowlist (§8.6): without it the history route is an
 * open proxy that lets any logged-in user read any entity's history, cameras and device trackers
 * included. This module deliberately does not know about links, so it cannot be the control point.
 *
 * The token never appears in a thrown error, a log line, or a URL — only in the Authorization header.
 */
import { z } from "zod";
import { redactSecrets } from "./redact";

export type FetchLike = (
  input: string | URL,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export class HaRestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "network" | "timeout" | "http" | "payload",
  ) {
    super(message);
    this.name = "HaRestError";
  }
}

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** `minimal_response` sends a full state first and `{state, last_changed}` deltas after it. */
export const HaHistoryPointSchema = z.looseObject({
  state: z.string(),
  last_changed: z.string().nullish(),
  last_updated: z.string().nullish(),
  entity_id: z.string().nullish(),
  attributes: z.record(z.string(), z.unknown()).nullish(),
});
export type HaHistoryPointRaw = z.infer<typeof HaHistoryPointSchema>;

/** HA returns one array per requested entity. */
export const HaHistoryResponseSchema = z.array(z.array(HaHistoryPointSchema));

export interface HaHistoryPoint {
  /** Epoch ms (project convention: instants are epoch-millisecond integers). */
  atMs: number;
  raw: string;
  /** `Number(raw)` when finite, else null — `unknown`/`unavailable` never become 0. */
  value: number | null;
}

export interface HaHistorySeries {
  entityId: string;
  points: HaHistoryPoint[];
}

export interface FetchHistoryInput {
  /** The HTTP base URL (`HA_URL`), not the WebSocket one. */
  haUrl: string;
  token: string;
  entityId: string;
  /** ISO 8601 instants. `startIso` goes in the path, `endIso` in `end_time`. */
  startIso: string;
  endIso: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function assertIso(label: string, value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new HaRestError(`${label} is not an ISO 8601 instant`, null, "payload");
  }
}

/**
 * `GET /api/history/period/<start>?filter_entity_id=&end_time=&minimal_response=true&no_attributes=true`
 *
 * `minimal_response` + `no_attributes` are not optional niceties: without them a month of a 1-minute
 * sensor is megabytes of duplicated attributes.
 */
export async function fetchHistory(input: FetchHistoryInput): Promise<HaHistorySeries> {
  const { haUrl, token, entityId, startIso, endIso } = input;
  const timeoutMs = input.timeoutMs ?? 15_000;
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));

  if (!ENTITY_ID.test(entityId)) {
    throw new HaRestError(`invalid entity_id: ${JSON.stringify(entityId)}`, null, "payload");
  }
  assertIso("startIso", startIso);
  assertIso("endIso", endIso);

  const url = new URL(`/api/history/period/${encodeURIComponent(startIso)}`, haUrl);
  url.searchParams.set("filter_entity_id", entityId);
  url.searchParams.set("end_time", endIso);
  url.searchParams.set("minimal_response", "true");
  url.searchParams.set("no_attributes", "true");

  const response = await request(doFetch, url, token, timeoutMs, input.signal, "history");
  if (!response.ok) {
    throw new HaRestError(
      `home assistant history request failed with status ${response.status}`,
      response.status,
      "http",
    );
  }

  let json: unknown;
  try {
    json = (await response.json()) as unknown;
  } catch {
    throw new HaRestError("home assistant history response was not JSON", response.status, "payload");
  }
  const parsed = HaHistoryResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new HaRestError(
      "home assistant history response did not match the expected shape",
      response.status,
      "payload",
    );
  }

  const series = parsed.data.find((group) => group.length > 0) ?? [];
  const points: HaHistoryPoint[] = [];
  for (const point of series) {
    const iso = point.last_changed ?? point.last_updated;
    const atMs = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(atMs)) continue;
    const numeric = Number(point.state.trim());
    points.push({
      atMs,
      raw: point.state,
      value: point.state.trim().length > 0 && Number.isFinite(numeric) ? numeric : null,
    });
  }
  points.sort((a, b) => a.atMs - b.atMs);
  return { entityId, points };
}

export interface CheckTokenInput {
  haUrl: string;
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CheckTokenResult {
  /** True only on a 2xx from `GET /api/`. */
  ok: boolean;
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  /** `authorized` | `unauthorized` | `unreachable` | `unexpected`. */
  kind: "authorized" | "unauthorized" | "unreachable" | "unexpected";
  /** Redacted, safe to persist and display. */
  message?: string;
}

/** `GET /api/` — the documented liveness/authorisation probe. Never throws. */
export async function checkToken(input: CheckTokenInput): Promise<CheckTokenResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = new URL("/api/", input.haUrl);
  try {
    const response = await request(doFetch, url, input.token, timeoutMs, input.signal, "token check");
    if (response.ok) return { ok: true, status: response.status, kind: "authorized" };
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        kind: "unauthorized",
        message: "home assistant rejected the access token — rotate HA_TOKEN",
      };
    }
    return {
      ok: false,
      status: response.status,
      kind: "unexpected",
      message: `home assistant answered ${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: err instanceof HaRestError ? err.status : null,
      kind: "unreachable",
      message: redactSecrets(
        err instanceof Error ? err.message : "home assistant is unreachable",
        input.token,
      ),
    };
  }
}

async function request(
  doFetch: FetchLike,
  url: URL,
  token: string,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  what: string,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    return await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal,
    });
  } catch (err) {
    // The URL is safe to include (no token in it); the error text is redacted anyway.
    const message = redactSecrets(
      err instanceof Error ? err.message : `home assistant ${what} request failed`,
      token,
    );
    const aborted = timeout.aborted || (err instanceof Error && err.name === "TimeoutError");
    throw new HaRestError(
      `home assistant ${what} request failed: ${message}`,
      null,
      aborted ? "timeout" : "network",
    );
  }
}
