/**
 * `connectionStateOf` — the one mapping from `integration_status` onto the connection pill.
 *
 * It is tested as a unit because it is the fix for two pills in the same viewport disagreeing: the
 * app shell derived the header pill through `loadMaintenanceHealth` and `/settings/home-assistant`
 * derived its own, and the two differed on a dead worker (`disconnected` vs `unknown`) and on
 * every connecting state (`unknown` vs `degraded`). Whichever answer is right, there has to be
 * exactly one of it.
 */
import { describe, expect, it } from "vitest";
import { INTEGRATION_STATES, type IntegrationState } from "@/db/schema/ha";
import { connectionStateOf, type IntegrationStateName } from "@/ui/status";

describe("connectionStateOf", () => {
  it("says unknown when the worker is not running, whatever it last reported", () => {
    // Not `disconnected`: nobody has observed Home Assistant at all. Claiming it is unreachable
    // would assert something no measurement supports (CLAUDE.md rule 8).
    for (const state of INTEGRATION_STATES) {
      expect(connectionStateOf(state, false)).toBe("unknown");
    }
  });

  it("says unknown when there is no status row at all", () => {
    expect(connectionStateOf(null, true)).toBe("unknown");
    expect(connectionStateOf(null, false)).toBe("unknown");
  });

  it("maps a live worker's states onto the four pill states", () => {
    expect(connectionStateOf("subscribed", true)).toBe("connected");
    expect(connectionStateOf("degraded", true)).toBe("degraded");
    // Part-way up is degraded, not unknown: the worker is reporting, so the link is observed.
    expect(connectionStateOf("connecting", true)).toBe("degraded");
    expect(connectionStateOf("authenticating", true)).toBe("degraded");
    expect(connectionStateOf("syncing", true)).toBe("degraded");
    expect(connectionStateOf("auth_failed", true)).toBe("disconnected");
    expect(connectionStateOf("disconnected", true)).toBe("disconnected");
  });

  it("never reports connected for anything but a subscribed socket", () => {
    for (const state of INTEGRATION_STATES) {
      if (state === "subscribed") continue;
      expect(connectionStateOf(state, true)).not.toBe("connected");
    }
  });

  it("covers every state the schema allows", () => {
    // The mapping's parameter type is structural so `@/ui` stays free of database imports. This
    // assignment is the compile-time half of that contract; the loop is the runtime half.
    const everyState: IntegrationStateName[] = [...INTEGRATION_STATES];
    const widened: readonly IntegrationState[] = INTEGRATION_STATES;
    expect(everyState).toHaveLength(widened.length);
    for (const state of everyState) {
      expect(["connected", "degraded", "disconnected", "unknown"]).toContain(
        connectionStateOf(state, true),
      );
    }
  });
});
