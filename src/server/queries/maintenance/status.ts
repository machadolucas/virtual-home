import "server-only";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { workerHeartbeat } from "@/db/schema/notifications";
import { loadEnv } from "@/env";
import { readIntegrationStatus, workerAlive } from "@/server/ha/status";
import { connectionStateOf, type ConnectionState } from "@/ui/status";

/**
 * The banner at the top of `/today`.
 *
 * The point of reading `integration_status` **and** `worker_heartbeat` is the distinction
 * `docs/design-notes/auth-security-operations.md` §8.7 insists on: the heartbeat is bumped
 * regardless of Home Assistant's state, so a stale heartbeat means *the worker* is down — which is
 * a different sentence from "Home Assistant is unreachable", and blaming the wrong box costs an
 * hour.
 *
 * `unknown` is never rendered as healthy (CLAUDE.md rule 8 and `docs/ux.md` §5): with no rows at
 * all the banner says it does not know, not that everything is fine.
 *
 * The prose below is this banner's own — it names the box to blame, which a four-state pill cannot.
 * The `connection` field is **not** its own: it comes from `connectionStateOf`, the one mapping
 * `/settings/home-assistant` also uses, so the header pill and this banner cannot contradict each
 * other about the same row.
 */
export type MaintenanceHealthKind =
  | "worker_down"
  | "ha_auth_failed"
  | "ha_disconnected"
  | "ha_degraded"
  | "ha_connecting"
  | "ok"
  | "unknown";

export interface MaintenanceHealth {
  kind: MaintenanceHealthKind;
  /** The pill state for `ConnectionPill`. */
  connection: ConnectionState;
  title: string;
  detail: string;
  /** What is *not* happening while this state lasts. Empty when everything is running. */
  consequence: string | null;
  /** Last time the worker proved it was alive, and last time HA was talking. */
  heartbeatAtMs: number | null;
  lastOkAtMs: number | null;
  /** Redacted error text from the integration, when there is one. */
  lastError: string | null;
  /** The notification tick's own heartbeat, which is what actually promotes tasks to "due". */
  lastTickFinishedMs: number | null;
}

const TICK_LEASE_NAME = "notification_tick";

const CONNECTING_WORDS = {
  connecting: "being opened",
  authenticating: "authenticating",
  syncing: "syncing the entity registry",
} as const;

export function loadMaintenanceHealth(db: Db, nowMs: number): MaintenanceHealth {
  const status = readIntegrationStatus(db);
  const tick =
    db.select().from(workerHeartbeat).where(eq(workerHeartbeat.name, TICK_LEASE_NAME)).get() ?? null;
  const periodMs = loadEnv().VH_WORKER_HEARTBEAT_MS;

  const alive = workerAlive(status, nowMs, periodMs);
  // One derivation, shared with the settings page. Every branch below reuses it rather than
  // restating a state of its own.
  const connection = connectionStateOf(status?.state ?? null, alive);

  const base = {
    connection,
    heartbeatAtMs: status?.heartbeatAtMs ?? null,
    lastOkAtMs: status?.lastOkAtMs ?? null,
    lastError: status?.lastError ?? null,
    lastTickFinishedMs: tick?.lastTickFinishedMs ?? null,
  };

  if (status === null) {
    return {
      ...base,
      kind: "unknown",
      title: "Integration state unknown",
      detail:
        "There is no status row yet, so the app cannot say whether the background service or Home Assistant are running.",
      consequence: "Tasks still work; reminders and battery alerts may not be arriving.",
    };
  }

  if (!alive) {
    return {
      ...base,
      kind: "worker_down",
      title: "Background service not running",
      detail:
        "The worker has not reported in. This is about the worker, not about Home Assistant — the heartbeat is written whether or not Home Assistant is reachable.",
      consequence:
        "Nothing is being promoted from “scheduled” to “due”, and no reminders are being sent. Everything on this page is still accurate as of its due dates.",
    };
  }

  switch (status.state) {
    case "subscribed":
      return {
        ...base,
        kind: "ok",
        title: "Home Assistant connected",
        detail: "Readings are current and reminders are being delivered.",
        consequence: null,
      };
    case "degraded":
      return {
        ...base,
        kind: "ha_degraded",
        title: "Home Assistant degraded",
        detail:
          "The worker is running and reconnecting, but the link to Home Assistant is not healthy.",
        consequence: "Battery readings may be stale. Scheduled tasks and reminders are unaffected.",
      };
    case "auth_failed":
      return {
        ...base,
        kind: "ha_auth_failed",
        title: "Home Assistant rejected the token",
        detail:
          "Authentication failed, so no readings are arriving and no notifications can be sent through Home Assistant.",
        consequence: "Condition alerts will not update and reminders cannot be delivered.",
      };
    case "disconnected":
      return {
        ...base,
        kind: "ha_disconnected",
        title: "Home Assistant unreachable",
        detail: "The worker is alive but cannot reach Home Assistant.",
        consequence: "Condition alerts will not update and reminders cannot be delivered.",
      };
    case "connecting":
    case "authenticating":
    case "syncing":
      return {
        ...base,
        kind: "ha_connecting",
        title: "Connecting to Home Assistant",
        detail: `The link is ${CONNECTING_WORDS[status.state]}. Until it settles, readings are not current.`,
        consequence: "Battery readings may be stale for a moment.",
      };
  }
}
