/**
 * The bridge end to end: a real `ws` connection to the fake HA server, a real in-memory database
 * built by the real migrations, and a hand-cranked clock for the coalescing window.
 *
 * The assertions that matter are the ones about *volume*: a linked entity changing must produce
 * exactly one outbox row, an unlinked entity changing must produce none, and a dimmer sweep must
 * collapse. Get those wrong and the outbox grows at Home Assistant's event rate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@/db/client";
import { readCursorSeq, readOutboxAfter } from "@/server/events/outbox";
import { readIntegrationStatus } from "@/server/ha/status";
import { startHaBridge, type HaBridge } from "@/worker/haBridge";
import { HaSocket, type HaSnapshot, type HaSocketOptions, type HaStatus } from "@/worker/ha/socket";
import { FakeHa, ManualClock, flush, waitFor } from "../../helpers/fakeHa";
import { testDb } from "../../helpers/db";
import { linkEntity, one, rows, seedAsset, seedLocations } from "./fixtures";

const DOOR_CONTACT_ENTITY = "binary_sensor.bedroom_door_sensor_contact";
const SUPPLY_TEMP_ENTITY = "sensor.ventilation_supply_air_temperature";

let server: FakeHa;
let clock: ManualClock;
let handle: DbHandle;
const sockets: HaSocket[] = [];
const bridges: HaBridge[] = [];

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
    },
  });
  sockets.push(socket);
  return socket;
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

function nextState(socket: HaSocket, target: HaStatus["state"]): Promise<HaStatus> {
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
  );
}

function start(options?: {
  onBatterySignal?: (registryId: string, raw: string, at: number) => void;
}): { socket: HaSocket; bridge: HaBridge } {
  const socket = makeSocket();
  const bridge = startHaBridge({
    handle,
    socket,
    clock,
    coalesceMs: 250,
    // The safety-net re-list is exercised explicitly; leaving it armed would fire on every
    // clock.advance in the other tests.
    relistIntervalMs: 0,
    onBatterySignal: options?.onBatterySignal,
    token: server.token,
  });
  bridges.push(bridge);
  return { socket, bridge };
}

beforeEach(async () => {
  server = await FakeHa.start();
  clock = new ManualClock();
  handle = testDb();
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.stop();
  for (const socket of sockets.splice(0)) socket.stop();
  await server.close();
  handle.close();
});

/** Real ws I/O under a fake clock: allow generous wall-clock slack; the assertions are about counts, not timing. */
const settle = <T,>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 8000, interval: 25 });

describe("ha bridge", { retry: 2 }, () => {
  it("persists the registry, the interesting states and the status on connect", async () => {
    seedLocations(handle);
    const { socket } = start();
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_entity`)?.n).toBe(
      server.registry.entities.length,
    );
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_device`)?.n).toBe(
      server.registry.devices.length,
    );
    expect(
      one<{ status: string }>(handle, `SELECT status FROM ha_sync_run ORDER BY started_at_ms`)
        ?.status,
    ).toBe("ok");

    // Only the canonical battery entities, since nothing is linked yet.
    expect(
      rows<{ entity_id: string }>(
        handle,
        `SELECT entity_id FROM ha_entity_state ORDER BY entity_id`,
      ).map((row) => row.entity_id),
    ).toEqual([
      "sensor.bedroom_door_sensor_battery",
      "sensor.lucas_iphone_battery_level",
      "sensor.marja_helenas_iphone_battery_level",
    ]);

    const status = readIntegrationStatus(handle.db);
    expect(status).toMatchObject({
      state: "subscribed",
      haVersion: server.haVersion,
      entityCount: server.registry.entities.length,
    });
    expect(status?.lastOkAtMs).not.toBeNull();

    // HA areas/floors matched our locations by name.
    expect(
      rows<{ ha_id: string; source: string }>(
        handle,
        `SELECT ha_id, source FROM location_mapping ORDER BY ha_id`,
      ),
    ).toEqual([
      { ha_id: "basement", source: "suggested" },
      { ha_id: "ground", source: "suggested" },
      { ha_id: "kitchen", source: "suggested" },
      { ha_id: "technical_room", source: "suggested" },
    ]);
  });

  it("publishes exactly one outbox row for a linked entity and none for an unlinked one", async () => {
    const { socket, bridge } = start();
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });
    const seqBefore = readCursorSeq(handle.db);

    server.emitStateChanged(DOOR_CONTACT_ENTITY, "on");
    server.emitStateChanged(SUPPLY_TEMP_ENTITY, "21.9");
    await flush();

    // Nothing is written until the 250 ms coalescing window closes.
    expect(readCursorSeq(handle.db)).toBe(seqBefore);
    expect(bridge.pending).toBe(2);

    clock.advance(250);
    await flush();

    const published = readOutboxAfter(handle.db, seqBefore);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ topic: "ha.state", key: DOOR_CONTACT_ENTITY });
    expect(published[0]?.payload).toMatchObject({ state: "on" });

    // The unlinked ventilation sensor is not cached either.
    expect(
      one<{ n: number }>(
        handle,
        `SELECT count(*) AS n FROM ha_entity_state WHERE entity_id = ?`,
        SUPPLY_TEMP_ENTITY,
      )?.n,
    ).toBe(0);
  });

  it("collapses a burst on one entity into a single row carrying the last value", async () => {
    const { socket } = start();
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });
    const seqBefore = readCursorSeq(handle.db);

    for (let i = 0; i < 40; i += 1) {
      server.emitStateChanged(DOOR_CONTACT_ENTITY, i % 2 === 0 ? "on" : "off");
    }
    await flush();
    clock.advance(250);
    await flush();

    const published = readOutboxAfter(handle.db, seqBefore);
    expect(published).toHaveLength(1);
    expect(published[0]?.payload).toMatchObject({ state: "off" });
  });

  it("hands canonical battery readings to the injected callback, on snapshot and on change", async () => {
    const signals: { registryId: string; raw: string }[] = [];
    const { socket } = start({
      onBatterySignal: (registryId, raw) => {
        signals.push({ registryId, raw });
      },
    });
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    expect(signals.map((signal) => signal.registryId).sort()).toEqual([
      "reg_door_battery",
      "reg_lucas_battery_level",
      "reg_marja_battery_level",
    ]);
    expect(signals.find((signal) => signal.registryId === "reg_door_battery")?.raw).toBe("68");

    signals.length = 0;
    server.emitStateChanged("sensor.bedroom_door_sensor_battery", "12");
    // A non-canonical entity on the same device must not produce a battery signal.
    server.emitStateChanged("sensor.bedroom_door_sensor_battery_voltage", "2.4");
    await flush();
    clock.advance(250);
    await flush();

    expect(signals).toEqual([{ registryId: "reg_door_battery", raw: "12" }]);
  });

  it("applies a debounced registry re-list, records the rename and never trusts the event payload", async () => {
    const { socket } = start();
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    const linkId = linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });

    server.renameEntity("reg_door_contact", "binary_sensor.bedroom_door_contact");
    await flush();
    // The socket debounces the invalidation signal for 2 s, then re-lists.
    clock.advance(2_000);
    await flush();
    await flush();

    expect(
      one<{ entity_id: string }>(
        handle,
        `SELECT entity_id FROM ha_entity WHERE registry_id = 'reg_door_contact'`,
      )?.entity_id,
    ).toBe("binary_sensor.bedroom_door_contact");
    expect(
      one<{ new_entity_id: string; source: string }>(
        handle,
        `SELECT new_entity_id, source FROM ha_entity_rename`,
      ),
    ).toEqual({ new_entity_id: "binary_sensor.bedroom_door_contact", source: "registry_sync" });
    expect(
      one<{ link_state: string; entity_id_snapshot: string }>(
        handle,
        `SELECT link_state, entity_id_snapshot FROM asset_ha_link WHERE id = ?`,
        linkId,
      ),
    ).toEqual({
      link_state: "active",
      entity_id_snapshot: "binary_sensor.bedroom_door_contact",
    });
  });

  it("re-snapshots after the connection is dropped, and reports the outage in between", async () => {
    const { socket } = start();
    const firstSnapshot = nextSnapshot(socket);
    socket.start();
    await firstSnapshot;
    await flush();
    expect(readIntegrationStatus(handle.db)?.state).toBe("subscribed");
    const runsBefore = one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)!.n;

    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });

    // The state moved while we were away: this is exactly what a re-snapshot exists for.
    server.registry.states.set(DOOR_CONTACT_ENTITY, {
      entity_id: DOOR_CONTACT_ENTITY,
      state: "on",
      attributes: { friendly_name: "Contact", device_class: "door" },
      last_changed: new Date(clock.now()).toISOString(),
      last_updated: new Date(clock.now()).toISOString(),
    });

    const secondSnapshot = nextSnapshot(socket);
    server.dropAllClients();

    const backoff = await nextState(socket, "backoff");
    expect(readIntegrationStatus(handle.db)?.state).toBe("disconnected");

    clock.advance(backoff.retryInMs ?? 1_000);
    await nextState(socket, "subscribed");
    await secondSnapshot;
    await flush();

    expect(server.connectionCount).toBe(2);
    await settle(() => {
      expect(readIntegrationStatus(handle.db)).toMatchObject({
        state: "subscribed",
        reconnectCount: 1,
      });
    });
    expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)!.n).toBe(
      runsBefore + 1,
    );
    expect(
      one<{ state: string }>(
        handle,
        `SELECT state FROM ha_entity_state WHERE entity_id = ?`,
        DOOR_CONTACT_ENTITY,
      )?.state,
    ).toBe("on");
    // The reconnect snapshot published the state the browser missed.
    expect(
      readOutboxAfter(handle.db, 0).filter((row) => row.key === DOOR_CONTACT_ENTITY),
    ).not.toHaveLength(0);
  });

  it("runs the hourly re-list safety net and keeps rescheduling", async () => {
    // The heartbeat is parked far out of the way: advancing an hour of fake time would otherwise
    // trip two pong timeouts (the pongs need real I/O) and take the socket down first.
    const socket = makeSocket({ pingIntervalMs: 10_000_000 });
    const bridge = startHaBridge({
      handle,
      socket,
      clock,
      coalesceMs: 250,
      relistIntervalMs: 3_600_000,
      token: server.token,
    });
    bridges.push(bridge);

    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();
    const runsBefore = one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)!.n;

    clock.advance(3_600_000);

    // One `ha_sync_run` for all four registries, not four.
    await settle(() => {
      expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)!.n).toBe(
        runsBefore + 1,
      );
    });

    // And it re-arms itself.
    clock.advance(3_600_000);
    await settle(() => {
      expect(one<{ n: number }>(handle, `SELECT count(*) AS n FROM ha_sync_run`)!.n).toBe(
        runsBefore + 2,
      );
    });
  });

  it("stop() detaches: later HA events change nothing", async () => {
    const { socket, bridge } = start();
    const snapshotSeen = nextSnapshot(socket);
    socket.start();
    await snapshotSeen;
    await flush();

    const assetId = seedAsset(handle, { name: "Bedroom door sensor" });
    linkEntity(handle, {
      assetId,
      registryId: "reg_door_contact",
      entityIdSnapshot: DOOR_CONTACT_ENTITY,
    });
    const seqBefore = readCursorSeq(handle.db);

    bridge.stop();
    bridge.stop(); // idempotent

    server.emitStateChanged(DOOR_CONTACT_ENTITY, "on");
    await flush();
    clock.advance(1_000);
    await flush();

    expect(readCursorSeq(handle.db)).toBe(seqBefore);
    expect(bridge.pending).toBe(0);
  });

  it("records auth failure without leaking the token", async () => {
    server.setToken(false);
    const { socket } = start();
    const failed = nextState(socket, "auth_failed");
    socket.start();
    await failed;
    await flush();

    const status = readIntegrationStatus(handle.db);
    expect(status?.state).toBe("auth_failed");
    expect(status?.lastError ?? "").not.toContain(server.token);
  });
});
