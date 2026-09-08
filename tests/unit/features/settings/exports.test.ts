/**
 * The inventory and equipment export routes.
 *
 * The property these defend is §8.4's whole reason for existing: **a coordinate without its frame
 * is a number without a unit.** Every response carries the model id, the revision, the content
 * hash and the coordinate system, and the placement rows repeat the revision beside their `pos_*`
 * columns — so a file opened in five years is still interpretable.
 *
 * They also pin the CSV conventions: an ISO instant plus a local-date companion, a decimal
 * quantity beside its `*_milli` integer, and NULL as an empty field rather than the four letters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
vi.mock("server-only", () => ({}));

vi.mock("@/server/auth/session", () => {
  class UnauthorizedError extends Error {
    readonly status = 401 as const;
  }
  return {
    UnauthorizedError,
    requireSession: async () => {
      if (mocks.userId.current === null) throw new UnauthorizedError();
      return { user: { id: mocks.userId.current }, session: { id: "test-session" } };
    },
  };
});

import { GET as inventoryExport } from "@/app/api/exports/inventory/route";
import { GET as equipmentExport } from "@/app/api/exports/equipment/route";
import { writeTx } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { modelRevision } from "@/db/schema";
import { purchase } from "@/domain/inventory";
import { systemClock } from "@/domain/time";
import { makeWorld, seedAsset, seedPart, teardown, type World } from "../inventory/actionSetup";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

function request(url: string): Request {
  return new Request(url);
}

/** A current model revision, so the envelope has a frame to report. */
function seedRevision(): string {
  const id = newId();
  const at = nowMs();
  writeTx(world.handle.db, (tx) => {
    tx.insert(modelRevision)
      .values({
        id,
        modelId: "example-house-1",
        schemaVersion: "1.0",
        generatedAtMs: at,
        contentHash: "sha256:deadbeef",
        coordinateSystemJson: JSON.stringify({
          units: "m",
          upAxis: "y",
          handedness: "right",
          originDescription: "model-frame",
        }),
        nodeCount: 42,
        importedAtMs: at,
        status: "current",
      })
      .run();
  });
  return id;
}

describe("the session boundary", () => {
  it("returns 401 without a session", async () => {
    mocks.userId.current = null;
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory"),
      undefined,
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/exports/inventory", () => {
  it("carries the §8.4 envelope, including the coordinate system", async () => {
    seedRevision();
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory"),
      undefined,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["exportedAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body["app"]).toMatchObject({ name: "virtual-home" });
    expect(body["household"]).toMatchObject({ timezone: "Europe/Helsinki" });
    const model = body["model"] as Record<string, unknown>;
    expect(model["modelId"]).toBe("example-house-1");
    expect(model["contentHash"]).toBe("sha256:deadbeef");
    expect(model["coordinateSystem"]).toMatchObject({ units: "m", upAxis: "y" });
  });

  it("never caches, because it is the whole household's purchase history", async () => {
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory"),
      undefined,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("exports every dataset by default", async () => {
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory"),
      undefined,
    );
    const body = (await response.json()) as { datasets: Record<string, unknown[]> };
    expect(Object.keys(body.datasets).sort()).toEqual(
      [
        "compatibility",
        "kitComponents",
        "lots",
        "parts",
        "storagePlaces",
        "stockTransactions",
        "suppliers",
      ].sort(),
    );
  });

  it("gives every quantity a decimal companion beside its thousandths", async () => {
    const partId = seedPart(world, { name: "HEPA filter", reorderThresholdMilli: 1500 });
    writeTx(world.handle.db, (tx) =>
      purchase(
        tx,
        {
          clock: systemClock,
          tz: "Europe/Helsinki",
          actorUserId: world.user.id,
          actorKind: "user",
        },
        { partId, qtyMilli: 2000 },
      ),
    );

    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?dataset=parts"),
      undefined,
    );
    const body = (await response.json()) as {
      datasets: { parts: Record<string, unknown>[] };
    };
    const row = body.datasets.parts[0]!;
    expect(row["on_hand"]).toBe(2);
    expect(row["on_hand_milli"]).toBe(2000);
    expect(row["reorder_threshold"]).toBe(1.5);
    expect(row["reorder_threshold_milli"]).toBe(1500);
    expect(row["unit"]).toBe("pcs");
  });

  it("gives every instant an ISO value and a local-date companion where the day matters", async () => {
    const partId = seedPart(world);
    writeTx(world.handle.db, (tx) =>
      purchase(
        tx,
        {
          clock: systemClock,
          tz: "Europe/Helsinki",
          actorUserId: world.user.id,
          actorKind: "user",
        },
        { partId, qtyMilli: 1000 },
      ),
    );
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?dataset=stockTransactions"),
      undefined,
    );
    const body = (await response.json()) as {
      datasets: { stockTransactions: Record<string, unknown>[] };
    };
    const row = body.datasets.stockTransactions[0]!;
    expect(row["occurred_at_utc"]).toMatch(/Z$/);
    expect(row["occurred_local_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row["recorded_by"]).toBe("Lucas");
  });

  it("serves CSV with the context block leading the dataset", async () => {
    seedRevision();
    seedPart(world, { name: "HEPA filter" });
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?format=csv&dataset=parts"),
      undefined,
    );
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");

    // The body's *bytes* start with the UTF-8 BOM, which is what stops Excel mangling Nordic
    // characters. `Response.text()` cannot see it: UTF-8 decoding strips a leading BOM by spec.
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = await response.text();
    const lines = text.trimEnd().split("\r\n");
    expect(lines[0]).toBe("context_key,context_value");
    expect(lines.some((line) => line.startsWith("model.modelId,"))).toBe(true);
    const blank = lines.indexOf("");
    expect(blank).toBeGreaterThan(0);
    expect(lines[blank + 1]).toContain("part_id");
  });

  it("writes NULL as an empty CSV field, never the four letters", async () => {
    seedPart(world, { name: "Bare part" });
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?format=csv&dataset=parts"),
      undefined,
    );
    const text = await response.text();
    expect(text).not.toContain(",null,");
  });

  it("refuses an unknown dataset and names the ones it has", async () => {
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?dataset=nonsense"),
      undefined,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; details: { supported: string[] } };
    expect(body.error).toBe("unknown_dataset");
    expect(body.details.supported).toContain("parts");
  });

  it("refuses an unsupported format", async () => {
    const response = await inventoryExport(
      request("http://localhost/api/exports/inventory?format=xlsx"),
      undefined,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("unsupported_format");
  });
});

describe("GET /api/exports/equipment", () => {
  it("exports assets with their location and its model node id", async () => {
    seedRevision();
    seedAsset(world, { name: "Ilmanvaihtokone" });
    const response = await equipmentExport(
      request("http://localhost/api/exports/equipment?dataset=assets"),
      undefined,
    );
    const body = (await response.json()) as {
      model: Record<string, unknown>;
      datasets: { assets: Record<string, unknown>[] };
    };
    const row = body.datasets.assets[0]!;
    expect(row["name"]).toBe("Ilmanvaihtokone");
    expect(row["location_name"]).toBe("Autotalli");
    expect(row).toHaveProperty("location_model_node_id");
    expect(body.model["coordinateSystem"]).toMatchObject({ units: "m" });
  });

  it("repeats the model revision beside every placement's coordinates", async () => {
    const response = await equipmentExport(
      request("http://localhost/api/exports/equipment?dataset=placements"),
      undefined,
    );
    const body = (await response.json()) as {
      datasets: { placements: Record<string, unknown>[] };
    };
    // No placements in this fixture, but the shape is part of the contract, so assert the columns
    // by round-tripping an empty dataset through CSV instead.
    expect(body.datasets.placements).toEqual([]);

    const csv = await (
      await equipmentExport(
        request("http://localhost/api/exports/equipment?format=csv&dataset=placements"),
        undefined,
      )
    ).text();
    for (const column of ["model_revision_id", "model_node_id", "pos_x", "pos_y", "pos_z"]) {
      expect(csv).toContain(column);
    }
  });

  it("exports an HA link's registry id as the identity and the entity id as a snapshot", async () => {
    const csv = await (
      await equipmentExport(
        request("http://localhost/api/exports/equipment?format=csv&dataset=haLinks"),
        undefined,
      )
    ).text();
    expect(csv).toContain("ha_entity_registry_id");
    expect(csv).toContain("entity_id_snapshot");
  });

  it("exports every dataset by default", async () => {
    const response = await equipmentExport(
      request("http://localhost/api/exports/equipment"),
      undefined,
    );
    const body = (await response.json()) as { datasets: Record<string, unknown[]> };
    expect(Object.keys(body.datasets).sort()).toEqual(
      [
        "assets",
        "consumables",
        "haLinks",
        "placements",
        "replacements",
        "systemMembers",
        "systems",
      ].sort(),
    );
  });
});
