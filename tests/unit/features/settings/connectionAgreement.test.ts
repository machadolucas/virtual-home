/**
 * The header pill and the Today banner cannot disagree with `/settings/home-assistant`.
 *
 * They used to. `src/app/(app)/layout.tsx` took its pill from `loadMaintenanceHealth`, which called
 * a dead worker `disconnected`; the settings page had its own `connectionStateOf`, which called the
 * same row `unknown` — and each file's comment claimed the other one was wrong. Both now go through
 * one exported mapping, and this pins that: the banner's `connection` field is that function's
 * output for the same row, for every state the schema allows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `src/server/queries/**` carries the `server-only` guard, which throws outside a server component.
vi.mock("server-only", () => ({}));

import type { DbHandle } from "@/db/client";
import { INTEGRATION_STATES } from "@/db/schema/ha";
import { loadEnv } from "@/env";
import { writeIntegrationStatus } from "@/server/ha/status";
import { loadMaintenanceHealth } from "@/server/queries/maintenance/status";
import { connectionStateOf } from "@/ui/status";
import { testDb } from "../../../helpers/db";

const T0 = 1_760_000_000_000;

let handle: DbHandle;

beforeEach(() => {
  handle = testDb();
});

afterEach(() => {
  handle.close();
});

describe("loadMaintenanceHealth().connection", () => {
  it("matches the shared mapping for every state, with the worker alive", () => {
    for (const state of INTEGRATION_STATES) {
      writeIntegrationStatus(handle, { state, heartbeatAtMs: T0, atMs: T0 });
      const health = loadMaintenanceHealth(handle.db, T0);
      expect(health.connection).toBe(connectionStateOf(state, true));
    }
  });

  it("matches the shared mapping for every state once the worker's heartbeat is stale", () => {
    const period = loadEnv().VH_WORKER_HEARTBEAT_MS;
    const wayLater = T0 + period * 10;

    for (const state of INTEGRATION_STATES) {
      writeIntegrationStatus(handle, { state, heartbeatAtMs: T0, atMs: T0 });
      const health = loadMaintenanceHealth(handle.db, wayLater);

      // A dead worker is `unknown`, not `disconnected`: nothing has observed Home Assistant.
      expect(health.connection).toBe("unknown");
      expect(health.connection).toBe(connectionStateOf(state, false));
      // The banner's own prose still names the right box to blame — that is what it is for, and it
      // is not what the pill was ever meant to carry.
      expect(health.kind).toBe("worker_down");
    }
  });

  it("says unknown, not fine, when there is no status row at all", () => {
    // The migrations seed the singleton, so this state only occurs on a database the worker has
    // never touched *and* whose row has gone. It is still the branch that must not guess.
    handle.sqlite.prepare("DELETE FROM integration_status").run();

    const health = loadMaintenanceHealth(handle.db, T0);
    expect(health.kind).toBe("unknown");
    expect(health.connection).toBe(connectionStateOf(null, false));
  });

  it("keeps the banner's richer wording distinct from the pill's four states", () => {
    writeIntegrationStatus(handle, { state: "connecting", heartbeatAtMs: T0, atMs: T0 });
    const health = loadMaintenanceHealth(handle.db, T0);

    expect(health.connection).toBe("degraded");
    // Same row, two different jobs: the pill says how good the link is, the banner says what is
    // happening to it and what is not happening while it lasts.
    expect(health.kind).toBe("ha_connecting");
    expect(health.consequence).not.toBeNull();
  });
});
