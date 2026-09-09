import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/session", () => {
  class UnauthorizedError extends Error {}
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (mocks.userId.current === null) throw new UnauthorizedError();
      return { user: { id: mocks.userId.current }, session: { id: "session" } };
    },
  };
});

import { and, eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import {
  assetHaLink,
  haControlCommand,
  haDevice,
  haEntity,
  haEntityState,
  integrationStatus,
} from "@/db/schema";
import {
  assertSupportedCommand,
  capabilitiesForEntity,
  serviceCallForCommand,
} from "@/domain/haControl";
import { drainOneHaControlCommand } from "@/worker/haControls";
import { GET, POST } from "@/app/api/equipment/[assetId]/controls/route";
import { makeWorld, seedAsset, teardown, type World } from "../inventory/actionSetup";

const T0 = 1_788_900_000_000;
const REQUEST_ID = "018fa9e0-1b2c-7abc-8def-0123456789ab";

let world: World;
let assetId: string;

function seedLight(options: {
  linked?: boolean;
  state?: string;
  entityId?: string;
  deviceId?: string | null;
} = {}): string {
  const registryId = newId();
  const entityId = options.entityId ?? "light.garage";
  writeTx(world.handle.db, (tx) => {
    tx.insert(haEntity)
      .values({
        registryId,
        entityId,
        domain: "light",
        name: "Garage light",
        deviceId: options.deviceId ?? null,
        firstSeenMs: T0,
        lastSeenMs: T0,
      })
      .run();
    tx.insert(haEntityState)
      .values({
        entityId,
        registryId,
        state: options.state ?? "on",
        attributesJson: JSON.stringify({
          friendly_name: "Garage light",
          supported_color_modes: ["color_temp", "rgb"],
          brightness: 123,
          color_temp_kelvin: 2700,
          min_color_temp_kelvin: 2000,
          max_color_temp_kelvin: 6500,
          rgb_color: [255, 180, 90],
        }),
        lastChangedMs: T0,
        lastUpdatedMs: T0,
        observedAtMs: T0,
      })
      .run();
    if (options.linked !== false) {
      tx.insert(assetHaLink)
        .values({
          id: newId(),
          assetId,
          linkKind: "entity",
          haEntityRegistryId: registryId,
          role: "control",
          entityIdSnapshot: entityId,
          linkState: "active",
          createdAtMs: T0,
          updatedAtMs: T0,
        })
        .run();
    }
    tx.insert(integrationStatus)
      .values({
        id: "ha",
        state: "subscribed",
        heartbeatAtMs: Date.now(),
        updatedAtMs: Date.now(),
      })
      .onConflictDoUpdate({
        target: integrationStatus.id,
        set: { state: "subscribed", heartbeatAtMs: Date.now(), updatedAtMs: Date.now() },
      })
      .run();
  });
  return registryId;
}

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
  assetId = seedAsset(world, { name: "Garage light", category: "electrical" });
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

describe("HA equipment control", () => {
  it("derives only modern light capabilities and builds allowlisted calls", () => {
    const capabilities = capabilitiesForEntity("light", {
      supported_color_modes: ["color_temp", "rgb"],
      min_color_temp_kelvin: 2000,
      max_color_temp_kelvin: 6500,
    });
    expect(capabilities).toEqual({
      brightness: true,
      colorTemperature: true,
      color: true,
      minKelvin: 2000,
      maxKelvin: 6500,
    });
    expect(assertSupportedCommand("light", capabilities, { type: "turn_on", colorTempKelvin: 1800 }))
      .toBe("color_temperature_range");
    expect(serviceCallForCommand({ type: "turn_on", brightness: 80, rgbColor: [1, 2, 3] }))
      .toEqual({ service: "turn_on", serviceData: { brightness: 80, rgb_color: [1, 2, 3] } });
    expect(capabilitiesForEntity("light", { supported_color_modes: ["future_mode"] }).brightness)
      .toBe(false);
  });

  it("requires a session and returns only linked controls with capabilities", async () => {
    const registryId = seedLight();
    mocks.userId.current = null;
    expect((await GET(new Request("http://example.test"), { params: Promise.resolve({ assetId }) })).status)
      .toBe(401);

    mocks.userId.current = world.user.id;
    const response = await GET(new Request("http://example.test"), {
      params: Promise.resolve({ assetId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: true,
      entities: [{ registryId, entityId: "light.garage", available: true, brightness: 123 }],
    });
  });

  it("deduplicates direct and device links and refuses disabled controls", async () => {
    const deviceId = newId();
    writeTx(world.handle.db, (tx) => {
      tx.insert(haDevice)
        .values({ deviceId, name: "Garage fixture", firstSeenMs: T0, lastSeenMs: T0 })
        .run();
    });
    const registryId = seedLight({ deviceId });
    writeTx(world.handle.db, (tx) => {
      tx.insert(assetHaLink)
        .values({
          id: newId(),
          assetId,
          linkKind: "device",
          haDeviceId: deviceId,
          role: "other",
          linkState: "active",
          createdAtMs: T0,
          updatedAtMs: T0,
        })
        .run();
    });
    const before = await GET(new Request("http://example.test"), {
      params: Promise.resolve({ assetId }),
    });
    expect((await before.json()).entities).toHaveLength(1);

    writeTx(world.handle.db, (tx) => {
      tx.update(haEntity).set({ disabledBy: "integration" }).where(eq(haEntity.registryId, registryId)).run();
    });
    const disabled = await GET(new Request("http://example.test"), {
      params: Promise.resolve({ assetId }),
    });
    expect((await disabled.json()).entities).toMatchObject([{ registryId, available: false }]);
    const response = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    expect(response.status).toBe(409);
  });

  it("does not trust a stale subscribed status after the worker stops", async () => {
    const registryId = seedLight();
    writeTx(world.handle.db, (tx) => {
      tx.update(integrationStatus)
        .set({ heartbeatAtMs: Date.now() - 60_000 })
        .where(eq(integrationStatus.id, "ha"))
        .run();
    });
    const controls = await GET(new Request("http://example.test"), {
      params: Promise.resolve({ assetId }),
    });
    expect((await controls.json()).connected).toBe(false);
    const response = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    expect(response.status).toBe(503);
  });

  it("rejects arbitrary unlinked entities and unavailable linked entities", async () => {
    const unlinked = seedLight({ linked: false });
    const unlinkedResponse = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId: unlinked, command: { type: "turn_on" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    expect(unlinkedResponse.status).toBe(404);

    const unavailable = seedLight({ state: "unavailable", entityId: "light.unavailable_garage" });
    const unavailableResponse = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({
          requestId: "018fa9e0-1b2c-7abc-8def-1123456789ab",
          registryId: unavailable,
          command: { type: "turn_on" },
        }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    expect(unavailableResponse.status).toBe(409);
  });

  it("enqueues idempotently, follows a registry rename, and sends once", async () => {
    const registryId = seedLight();
    const request = () =>
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({
          requestId: REQUEST_ID,
          registryId,
          command: { type: "turn_on", brightness: 80 },
        }),
      });
    const first = await POST(request(), { params: Promise.resolve({ assetId }) });
    const second = await POST(request(), { params: Promise.resolve({ assetId }) });
    const firstBody = await first.json();
    expect((await second.json()).commandId).toBe(firstBody.commandId);
    expect(
      world.handle.db.select().from(haControlCommand).where(eq(haControlCommand.requestId, REQUEST_ID)).all(),
    ).toHaveLength(1);

    writeTx(world.handle.db, (tx) => {
      tx.update(haEntity).set({ entityId: "light.renamed_garage" }).where(eq(haEntity.registryId, registryId)).run();
      tx.update(haEntityState).set({ entityId: "light.renamed_garage" }).where(eq(haEntityState.registryId, registryId)).run();
    });
    const calls: unknown[] = [];
    const sent = await drainOneHaControlCommand({
      handle: world.handle,
      now: () => T0 + 1,
      socket: {
        state: "subscribed",
        async callService(domain, service, serviceData, target) {
          calls.push({ domain, service, serviceData, target });
          return {};
        },
      },
    });
    expect(sent).toBe(true);
    expect(calls).toEqual([
      {
        domain: "light",
        service: "turn_on",
        serviceData: { brightness: 80 },
        target: { entity_id: "light.renamed_garage" },
      },
    ]);
    expect(
      world.handle.db
        .select({ state: haControlCommand.state })
        .from(haControlCommand)
        .where(eq(haControlCommand.id, firstBody.commandId))
        .get()?.state,
    ).toBe("sent");
  });

  it("does not retry an uncertain or rejected service call", async () => {
    const registryId = seedLight();
    await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    let attempts = 0;
    const socket = {
      state: "subscribed",
      async callService() {
        attempts += 1;
        throw new Error("HA rejected call");
      },
    };
    expect(await drainOneHaControlCommand({ handle: world.handle, socket, now: () => T0 + 1 })).toBe(true);
    expect(await drainOneHaControlCommand({ handle: world.handle, socket, now: () => T0 + 2 })).toBe(false);
    expect(attempts).toBe(1);
    expect(
      world.handle.db
        .select({ state: haControlCommand.state, error: haControlCommand.lastError })
        .from(haControlCommand)
        .where(and(eq(haControlCommand.requestId, REQUEST_ID), eq(haControlCommand.assetId, assetId)))
        .get(),
    ).toEqual({ state: "failed", error: "ha_rejected" });
  });

  it("expires a queued command without sending it", async () => {
    const registryId = seedLight();
    const response = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    const { commandId } = await response.json();
    writeTx(world.handle.db, (tx) => {
      tx.update(haControlCommand)
        .set({ createdAtMs: T0, expiresAtMs: T0 + 1 })
        .where(eq(haControlCommand.id, commandId))
        .run();
    });
    let sends = 0;
    expect(
      await drainOneHaControlCommand({
        handle: world.handle,
        now: () => T0 + 2,
        socket: { state: "subscribed", async callService() { sends += 1; return {}; } },
      }),
    ).toBe(false);
    expect(sends).toBe(0);
    expect(
      world.handle.db.select({ state: haControlCommand.state }).from(haControlCommand)
        .where(eq(haControlCommand.id, commandId)).get()?.state,
    ).toBe("expired");
  });

  it("rechecks unlinking and capability removal after enqueue", async () => {
    const registryId = seedLight();
    const enqueue = async (requestId: string, command: object) => {
      const response = await POST(
        new Request("http://example.test", {
          method: "POST",
          body: JSON.stringify({ requestId, registryId, command }),
        }),
        { params: Promise.resolve({ assetId }) },
      );
      return (await response.json()).commandId as string;
    };
    const brightnessId = await enqueue(REQUEST_ID, { type: "turn_on", brightness: 80 });
    writeTx(world.handle.db, (tx) => {
      tx.update(haEntityState)
        .set({ attributesJson: JSON.stringify({ supported_color_modes: ["onoff"] }) })
        .where(eq(haEntityState.registryId, registryId))
        .run();
    });
    let sends = 0;
    const socket = { state: "subscribed", async callService() { sends += 1; return {}; } };
    expect(await drainOneHaControlCommand({ handle: world.handle, socket, now: Date.now })).toBe(false);
    expect(
      world.handle.db.select({ error: haControlCommand.lastError }).from(haControlCommand)
        .where(eq(haControlCommand.id, brightnessId)).get()?.error,
    ).toBe("control_capability_changed");

    const offId = await enqueue("018fa9e0-1b2c-7abc-8def-2123456789ab", { type: "turn_off" });
    writeTx(world.handle.db, (tx) => {
      tx.delete(assetHaLink).where(eq(assetHaLink.assetId, assetId)).run();
    });
    expect(await drainOneHaControlCommand({ handle: world.handle, socket, now: Date.now })).toBe(false);
    expect(sends).toBe(0);
    expect(
      world.handle.db.select({ error: haControlCommand.lastError }).from(haControlCommand)
        .where(eq(haControlCommand.id, offId)).get()?.error,
    ).toBe("control_entity_unlinked");
  });

  it("rechecks disabled entities after enqueue", async () => {
    const registryId = seedLight();
    await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    writeTx(world.handle.db, (tx) => {
      tx.update(haEntity).set({ disabledBy: "integration" }).where(eq(haEntity.registryId, registryId)).run();
    });
    let sends = 0;
    expect(
      await drainOneHaControlCommand({
        handle: world.handle,
        socket: { state: "subscribed", async callService() { sends += 1; return {}; } },
        now: Date.now,
      }),
    ).toBe(false);
    expect(sends).toBe(0);
    expect(
      world.handle.db.select({ error: haControlCommand.lastError }).from(haControlCommand)
        .where(eq(haControlCommand.requestId, REQUEST_ID)).get()?.error,
    ).toBe("control_entity_disabled");
  });

  it("rejects arbitrary command types, service names and extra payload", async () => {
    const registryId = seedLight();
    const commands = [
      { type: "toggle" },
      { type: "turn_on", service: "unlock" },
      { type: "turn_off", entityId: "lock.front_door" },
    ];
    for (const [index, command] of commands.entries()) {
      const response = await POST(
        new Request("http://example.test", {
          method: "POST",
          body: JSON.stringify({
            requestId: `018fa9e0-1b2c-7abc-8de${index}-3123456789ab`,
            registryId,
            command,
          }),
        }),
        { params: Promise.resolve({ assetId }) },
      );
      expect(response.status).toBe(400);
    }
    expect(world.handle.db.select().from(haControlCommand).all()).toHaveLength(0);
  });

  it("marks an abandoned sending command as result unknown without sending again", async () => {
    const registryId = seedLight();
    const response = await POST(
      new Request("http://example.test", {
        method: "POST",
        body: JSON.stringify({ requestId: REQUEST_ID, registryId, command: { type: "turn_off" } }),
      }),
      { params: Promise.resolve({ assetId }) },
    );
    const { commandId } = await response.json();
    const createdAtMs = world.handle.db
      .select({ createdAtMs: haControlCommand.createdAtMs })
      .from(haControlCommand)
      .where(eq(haControlCommand.id, commandId))
      .get()!.createdAtMs;
    writeTx(world.handle.db, (tx) => {
      tx.update(haControlCommand)
        .set({ state: "sending", sendingAtMs: createdAtMs, expiresAtMs: createdAtMs + 1 })
        .where(eq(haControlCommand.id, commandId))
        .run();
    });
    let attempts = 0;
    expect(
      await drainOneHaControlCommand({
        handle: world.handle,
        now: () => createdAtMs + 2,
        socket: { state: "subscribed", async callService() { attempts += 1; return {}; } },
      }),
    ).toBe(false);
    expect(attempts).toBe(0);
    expect(
      world.handle.db
        .select({ state: haControlCommand.state, error: haControlCommand.lastError })
        .from(haControlCommand)
        .where(eq(haControlCommand.id, commandId))
        .get(),
    ).toEqual({ state: "failed", error: "result_unknown" });
  });
});
