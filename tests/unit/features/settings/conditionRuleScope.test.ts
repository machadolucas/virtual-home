/**
 * A condition rule's target columns follow its scope.
 *
 * Two things this pins:
 *  - an **entity-scoped rule can actually be created**. The scope select has always offered "One
 *    specific entity", but the dialog rendered a picker for `asset` only, so `haEntityRegistryId`
 *    stayed null and the action's refine rejected with `invalid_request` on a path nothing on
 *    screen pointed at;
 *  - **the unused target is cleared**, not carried. The write had `scope === "asset" ? assetId :
 *    assetId` — both branches identical — so a rule narrowed from one appliance to "every battery"
 *    kept the appliance in `asset_id` and read as scoped to something it no longer watched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

vi.mock("server-only", () => ({}));

vi.mock("next/cache", () => ({
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));

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

import { writeTx } from "@/db/client";
import { conditionRule, haEntity } from "@/db/schema";
import { upsertConditionRule } from "@/server/actions/ha/rules";
import { makeWorld, seedAsset, teardown, type World } from "../inventory/actionSetup";

const T0 = 1_760_000_000_000;
const REGISTRY_ID = "reg_hrv_supply_temp";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
  writeTx(world.handle.db, (tx) => {
    tx.insert(haEntity)
      .values({
        registryId: REGISTRY_ID,
        entityId: "sensor.hrv_supply_temperature",
        domain: "sensor",
        firstSeenMs: T0,
        lastSeenMs: T0,
      })
      .run();
  });
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

function baseInput(overrides: Record<string, unknown>) {
  return {
    ruleId: null,
    name: "Supply air too cold",
    kind: "threshold_below" as const,
    scope: "entity" as const,
    priority: "normal" as const,
    titleTemplate: "Check the HRU: {{asset}}",
    enabled: true,
    ...overrides,
  };
}

function ruleRow(id: string) {
  return world.handle.db.select().from(conditionRule).where(eq(conditionRule.id, id)).get();
}

describe("upsertConditionRule scope targets", () => {
  it("creates an entity-scoped rule when the entity is supplied", async () => {
    const result = await upsertConditionRule(
      baseInput({ haEntityRegistryId: REGISTRY_ID }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = ruleRow(result.data.ruleId);
    expect(row?.scope).toBe("entity");
    expect(row?.haEntityRegistryId).toBe(REGISTRY_ID);
  });

  it("refuses an entity-scoped rule with no entity, naming the field", async () => {
    const result = await upsertConditionRule(baseInput({ haEntityRegistryId: null }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("invalid_request");
    // The dialog reads this path to highlight the picker; without a picker there was nothing to
    // highlight, which is what made the whole scope unreachable.
    const details = result.details as { fieldErrors?: Record<string, string[]> };
    expect(Object.keys(details.fieldErrors ?? {})).toContain("haEntityRegistryId");
  });

  it("clears the entity when the rule is widened to every battery", async () => {
    const created = await upsertConditionRule(baseInput({ haEntityRegistryId: REGISTRY_ID }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const widened = await upsertConditionRule(
      baseInput({
        ruleId: created.data.ruleId,
        kind: "low_battery",
        scope: "all_batteries",
        // The form still posts what it last held; the server is what must not keep it.
        haEntityRegistryId: REGISTRY_ID,
      }),
    );
    expect(widened.ok).toBe(true);

    const row = ruleRow(created.data.ruleId);
    expect(row?.scope).toBe("all_batteries");
    expect(row?.haEntityRegistryId).toBeNull();
  });

  it("clears the equipment when the rule is narrowed to one entity", async () => {
    const assetId = seedAsset(world, { name: "Heat recovery unit" });

    const created = await upsertConditionRule(
      baseInput({ kind: "low_battery", scope: "asset", assetId }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(ruleRow(created.data.ruleId)?.assetId).toBe(assetId);

    const narrowed = await upsertConditionRule(
      baseInput({
        ruleId: created.data.ruleId,
        scope: "entity",
        assetId,
        haEntityRegistryId: REGISTRY_ID,
      }),
    );
    expect(narrowed.ok).toBe(true);

    const row = ruleRow(created.data.ruleId);
    expect(row?.assetId).toBeNull();
    expect(row?.haEntityRegistryId).toBe(REGISTRY_ID);
  });
});
