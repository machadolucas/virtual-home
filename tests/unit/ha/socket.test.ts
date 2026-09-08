import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HaDisconnectedError,
  HaSocket,
  type HaConnectionState,
  type HaRegistryRefresh,
  type HaSnapshot,
  type HaSocketOptions,
  type HaStatus,
} from "@/worker/ha/socket";
import type { HaEvent, HaStateChangedData } from "@/worker/ha/protocol";
import { FakeHa, ManualClock, flush, waitFor } from "../../helpers/fakeHa";

let server: FakeHa;
let clock: ManualClock;
const sockets: HaSocket[] = [];

/**
 * Every timer and the backoff jitter come from the test. `random: () => 1` makes the full-jitter
 * delay deterministic: exactly `min(cap, base * 2 ** min(attempt, 6))`.
 */
function makeSocket(overrides: Partial<HaSocketOptions> = {}): HaSocket {
  const socket = new HaSocket({
    url: server.url,
    token: server.token,
    ...overrides,
    deps: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      now: clock.now,
      random: () => 1,
      ...overrides.deps,
    },
  });
  sockets.push(socket);
  return socket;
}

function nextState(
  socket: HaSocket,
  target: HaConnectionState,
  timeoutMs = 5_000,
): Promise<HaStatus> {
  if (socket.state === target) return Promise.resolve(socket.status);
  return waitFor<HaStatus>(
    (resolve) => {
      const listener = (status: HaStatus): void => {
        if (status.state === target) resolve(status);
      };
      socket.on("state", listener);
      return () => {
        socket.off("state", listener);
      };
    },
    `state '${target}'`,
    timeoutMs,
  );
}

function nextSnapshot(socket: HaSocket): Promise<HaSnapshot> {
  return waitFor<HaSnapshot>(
    (resolve) => {
      socket.on("snapshot", resolve);
      return () => {
        socket.off("snapshot", resolve);
      };
    },
    "snapshot",
  );
}

function nextRegistryRefresh(socket: HaSocket): Promise<HaRegistryRefresh> {
  return waitFor<HaRegistryRefresh>(
    (resolve) => {
      socket.on("registry", resolve);
      return () => {
        socket.off("registry", resolve);
      };
    },
    "registry re-list",
  );
}

function nextRegistryUpdated(socket: HaSocket): Promise<{ registry: string }> {
  return waitFor<{ registry: string }>(
    (resolve) => {
      socket.on("registry_updated", resolve);
      return () => {
        socket.off("registry_updated", resolve);
      };
    },
    "registry_updated signal",
  );
}

beforeEach(async () => {
  server = await FakeHa.start();
  clock = new ManualClock();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.stop();
  await server.close();
});

describe("connect / authenticate / snapshot / subscribe", () => {
  it("reaches subscribed with a full snapshot and one subscription per event type", async () => {
    const socket = makeSocket();
    const snapshot = nextSnapshot(socket);

    expect(socket.state).toBe("disconnected");
    socket.start();

    const subscribed = await nextState(socket, "subscribed");
    expect(subscribed.haVersion).toBe("2026.9.1");
    expect(socket.haVersion).toBe("2026.9.1");

    const snap = await snapshot;
    expect(snap.entities.length).toBeGreaterThan(15);
    expect(snap.devices.map((device) => device.id)).toContain("dev_parmair_filter");
    expect(snap.areas.map((area) => area.area_id)).toContain("technical_room");
    expect(snap.floors.map((floor) => floor.floor_id)).toContain("basement");
    expect(snap.states.find((state) => state.entity_id === "fan.house_hrv")?.state).toBe("on");
    expect(snap.skipped).toEqual({
      states: 0,
      entities: 0,
      devices: 0,
      areas: 0,
      floors: 0,
    });

    // One get_states + four registry lists, all in one syncing phase.
    expect(server.commandCount("get_states")).toBe(1);
    expect(server.commandCount("config/entity_registry/list")).toBe(1);
    expect(server.commandCount("config/device_registry/list")).toBe(1);
    expect(server.commandCount("config/area_registry/list")).toBe(1);
    expect(server.commandCount("config/floor_registry/list")).toBe(1);
    // The six always-on event types.
    expect(server.commandCount("subscribe_events")).toBe(6);
  });

  it("exposes getStates, listRegistries and callService with return_response false", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");

    expect((await socket.getStates()).length).toBeGreaterThan(15);
    const registries = await socket.listRegistries();
    expect(registries.entities.length).toBeGreaterThan(15);
    expect(registries.skipped.devices).toBe(0);

    const result = await socket.callService(
      "notify",
      "mobile_app_lucas_iphone",
      { message: "Due today", data: { tag: "vh:occ:1:u" } },
      undefined,
    );
    expect(result.context?.user_id).toBe("ha_user_1");
    expect(server.serviceCalls).toHaveLength(1);
    expect(server.serviceCalls[0]).toMatchObject({
      domain: "notify",
      service: "mobile_app_lucas_iphone",
      returnResponse: false,
    });
  });

  it("rejects a failed call_service with the HA error code", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");
    server.setCallServiceError({ code: "service_not_found", message: "nope" });
    await expect(socket.callService("notify", "mobile_app_gone", {})).rejects.toMatchObject({
      name: "HaCommandError",
      code: "service_not_found",
    });
  });

  it("delivers events to subscribeEvents handlers and stops on unsubscribe", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");

    const seen: HaEvent[] = [];
    const unsubscribe = socket.subscribeEvents("mobile_app_notification_action", (event) => {
      seen.push(event);
    });

    server.emitEvent("mobile_app_notification_action", {
      action: "vh_done",
      action_data: { v: 1, nonce: "n1" },
      tag: "vh:occ:1:u",
    });
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]?.context?.user_id).toBeNull();

    unsubscribe();
    server.emitEvent("mobile_app_notification_action", { action: "vh_snooze" });
    await flush();
    // The subscription itself is permanent (it is one of the always-on types), but the handler
    // must no longer be called.
    expect(seen).toHaveLength(1);
  });
});

describe("auth failure", () => {
  it("enters auth_failed with a five-minute floor and does not hammer HA", async () => {
    const socket = makeSocket({ token: "definitely-not-the-token" });
    socket.start();

    const failed = await nextState(socket, "auth_failed");
    expect(failed.error).toContain("invalid access token");
    expect(failed.retryInMs).toBeGreaterThanOrEqual(300_000);
    expect(server.connectionCount).toBe(1);

    // Just under the floor: still exactly one connection attempt. No tight loop.
    clock.advance(299_000);
    await flush();
    expect(server.connectionCount).toBe(1);

    clock.advance(1_000);
    await nextState(socket, "connecting");
    await vi.waitFor(() => {
      expect(server.connectionCount).toBe(2);
    });

    const failedAgain = await nextState(socket, "auth_failed");
    expect(failedAgain.retryInMs).toBeGreaterThanOrEqual(300_000);
  });

  it("recovers once the token is accepted again", async () => {
    const socket = makeSocket({ token: "definitely-not-the-token" });
    socket.start();
    const failed = await nextState(socket, "auth_failed");

    server.setToken("definitely-not-the-token");
    clock.advance(failed.retryInMs ?? 300_000);
    await nextState(socket, "subscribed");
    expect(socket.state).toBe("subscribed");
  });
});

describe("reconnect", () => {
  it("re-snapshots and restores subscriptions after the server drops the connection", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");

    const changes: HaStateChangedData[] = [];
    socket.on("state_changed", (data) => {
      changes.push(data);
    });

    const resnapshot = nextSnapshot(socket);
    server.dropAllClients();

    const backoff = await nextState(socket, "backoff");
    // attempt counter resets on a successful sync, so the first retry uses the base window.
    expect(backoff.retryInMs).toBe(1_000);
    expect(backoff.error).toBeTruthy();

    clock.advance(backoff.retryInMs ?? 1_000);
    await nextState(socket, "subscribed");
    await resnapshot;

    expect(server.connectionCount).toBe(2);
    expect(socket.reconnectCount).toBe(1);
    // A fresh get_states on every reconnect: state_changed only describes the future.
    expect(server.commandCount("get_states")).toBe(2);
    expect(server.commandCount("subscribe_events")).toBe(12);

    // Subscriptions really work on the new socket.
    server.emitStateChanged("sensor.bedroom_door_sensor_battery", "42");
    await vi.waitFor(() => {
      expect(changes).toHaveLength(1);
    });
    expect(changes[0]?.new_state?.state).toBe("42");
    expect(changes[0]?.old_state?.state).toBe("68");
  });

  it("grows the backoff window on repeated failures and caps it", async () => {
    // A port that is guaranteed closed: take a real one, then shut it down.
    const closed = await FakeHa.start();
    const deadUrl = closed.url;
    await closed.close();

    const socket = makeSocket({ url: deadUrl, backoffBaseMs: 1_000, backoffCapMs: 60_000 });
    const delays: number[] = [];
    socket.on("state", (status) => {
      if (status.state === "backoff" && status.retryInMs !== undefined) {
        delays.push(status.retryInMs);
      }
    });

    socket.start();
    for (let i = 0; i < 8; i += 1) {
      await vi.waitFor(() => {
        expect(delays.length).toBe(i + 1);
      });
      clock.advance(delays[i] ?? 0);
    }
    // random() === 1, so the delay is the whole window: base * 2 ** min(attempt, 6), capped.
    expect(delays.slice(0, 8)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
    expect(socket.reconnectCount).toBeGreaterThanOrEqual(8);
  });
});

describe("heartbeat", () => {
  it("goes degraded after two missed pongs and then reconnects", async () => {
    const socket = makeSocket({ pingIntervalMs: 30_000, pongTimeoutMs: 10_000 });
    socket.start();
    await nextState(socket, "subscribed");

    // A healthy ping/pong first, to prove the heartbeat is actually running. Waiting for the
    // next timer to be a fresh 30 s ping (rather than the 10 s pong deadline) is what proves the
    // pong was processed, without depending on wall-clock timing.
    clock.advance(30_000);
    await vi.waitFor(() => {
      expect(server.commandCount("ping")).toBe(1);
      expect(clock.nextDueInMs).toBe(30_000);
    });
    expect(socket.state).toBe("subscribed");

    server.setPongEnabled(false);
    const degraded = nextState(socket, "degraded");

    clock.advance(30_000); // ping 2 goes out
    await flush();
    clock.advance(10_000); // first miss
    await flush();
    clock.advance(30_000); // ping 3 goes out
    await flush();
    clock.advance(10_000); // second miss -> degraded

    const status = await degraded;
    expect(status.error).toMatch(/pong/);

    const backoff = await nextState(socket, "backoff");
    server.setPongEnabled(true);
    clock.advance(backoff.retryInMs ?? 1_000);
    await nextState(socket, "subscribed");
    expect(server.connectionCount).toBe(2);
  });
});

describe("pending commands", () => {
  it("rejects every in-flight command with HaDisconnectedError on disconnect", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");

    server.setStalled("get_states", true);
    const stalled = socket.getStates();
    await flush();

    server.dropAllClients();
    await expect(stalled).rejects.toBeInstanceOf(HaDisconnectedError);
    await nextState(socket, "backoff");
  });

  it("rejects immediately when not connected", async () => {
    const socket = makeSocket();
    await expect(socket.getStates()).rejects.toBeInstanceOf(HaDisconnectedError);
  });

  it("times out a command that is accepted but never answered", async () => {
    const socket = makeSocket({ commandTimeoutMs: 30_000 });
    socket.start();
    await nextState(socket, "subscribed");

    server.setStalled("get_states", true);
    const stalled = socket.getStates();
    await flush();
    clock.advance(30_000);
    await expect(stalled).rejects.toMatchObject({ name: "HaCommandTimeoutError" });
  });

  it("stop() is idempotent, cancels backoff and leaves the socket disconnected", async () => {
    const socket = makeSocket();
    socket.start();
    await nextState(socket, "subscribed");
    socket.stop();
    socket.stop();
    expect(socket.state).toBe("disconnected");
    clock.advance(600_000);
    await flush();
    expect(server.connectionCount).toBe(1);
    expect(server.clientCount).toBe(0);
  });
});

describe("registry refresh", () => {
  it("re-lists after a registry_updated signal and ignores the stale changes payload", async () => {
    const socket = makeSocket({ registryDebounceMs: 2_000 });
    socket.start();
    await nextState(socket, "subscribed");

    const rawEvents: HaEvent[] = [];
    socket.on("event", (event) => {
      if (event.event_type === "entity_registry_updated") rawEvents.push(event);
    });
    const signals: string[] = [];
    socket.on("registry_updated", ({ registry }) => {
      signals.push(registry);
    });

    const listsBefore = server.commandCount("config/entity_registry/list");
    const refreshed = nextRegistryRefresh(socket);

    server.renameEntity("reg_door_battery", "sensor.guest_room_door_sensor_battery");
    server.renameEntity("reg_door_contact", "binary_sensor.guest_room_door_sensor_contact");

    await vi.waitFor(() => {
      expect(signals.length).toBeGreaterThanOrEqual(2);
    });
    expect(signals.every((registry) => registry === "entity")).toBe(true);
    // Nothing has been re-listed yet: the signal is debounced.
    expect(server.commandCount("config/entity_registry/list")).toBe(listsBefore);

    clock.advance(2_000);
    const fresh = await refreshed;

    expect(fresh.registry).toBe("entity");
    // Two signals coalesced into exactly one re-list.
    expect(server.commandCount("config/entity_registry/list")).toBe(listsBefore + 1);

    // The event payload reports the *old* entity_id under `changes` - applying it would corrupt
    // the cache. The fresh list is the source of truth.
    const stale = rawEvents[0]?.data as { changes?: { entity_id?: string } } | undefined;
    expect(stale?.changes?.entity_id).toBe("sensor.bedroom_door_sensor_battery");
    if (fresh.registry !== "entity") throw new Error("expected the entity registry");
    const record = fresh.records.find((entry) => entry.id === "reg_door_battery");
    expect(record?.entity_id).toBe("sensor.guest_room_door_sensor_battery");
  });

  it("re-lists the right registry for device, area and floor signals", async () => {
    const socket = makeSocket({ registryDebounceMs: 2_000 });
    socket.start();
    await nextState(socket, "subscribed");

    for (const [eventType, command] of [
      ["device_registry_updated", "config/device_registry/list"],
      ["area_registry_updated", "config/area_registry/list"],
      ["floor_registry_updated", "config/floor_registry/list"],
    ] as const) {
      const before = server.commandCount(command);
      const signal = nextRegistryUpdated(socket);
      const refreshed = nextRegistryRefresh(socket);
      server.emitEvent(eventType, { action: "update", changes: { name: "stale" } });
      expect((await signal).registry).toBe(eventType.split("_")[0]);
      clock.advance(2_000);
      await refreshed;
      expect(server.commandCount(command)).toBe(before + 1);
    }
  });

  it("drops a pending debounce when the connection goes away", async () => {
    const socket = makeSocket({ registryDebounceMs: 2_000 });
    socket.start();
    await nextState(socket, "subscribed");

    const listsBefore = server.commandCount("config/entity_registry/list");
    const signal = nextRegistryUpdated(socket);
    server.emitEvent("entity_registry_updated", { action: "update" });
    await signal;

    server.dropAllClients();
    const backoff = await nextState(socket, "backoff");
    clock.advance(2_000);
    await flush();
    // The debounced re-list belonged to the dead connection; the reconnect's full snapshot
    // supersedes it.
    expect(server.commandCount("config/entity_registry/list")).toBe(listsBefore);

    clock.advance(backoff.retryInMs ?? 1_000);
    await nextState(socket, "subscribed");
    expect(server.commandCount("config/entity_registry/list")).toBe(listsBefore + 1);
  });
});
