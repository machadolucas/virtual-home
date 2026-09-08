/**
 * `updateHouseBackground`, against a real in-memory database built by the real migrations.
 *
 * Three properties, one per way this can go wrong:
 *  - a chosen background **persists** and comes back out of the query unchanged;
 *  - "follow the theme" is stored as **NULL**, so "never chosen" and "chose the default" are the
 *    same row rather than two states the UI would have to distinguish;
 *  - a stored value the schema no longer accepts **falls back to the theme**. The column carries no
 *    CHECK on purpose (adding one to this table would make drizzle-kit rebuild it, and the rebuild
 *    cascades into children — see `drizzle/0002_sad_raza.sql`), so a hand-edited row is a real
 *    possibility and the House page must survive it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ userId: { current: null as string | null } }));

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
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
import { HOUSEHOLD_SETTING_ID, auditLog, householdSetting } from "@/db/schema";
import { DEFAULT_HOUSE_BACKGROUND, type HouseBackground } from "@/house/model/background";
import { updateHouseBackground } from "@/server/actions/settings/household";
import { readHouseBackground, readHouseholdRow } from "@/server/queries/settings/household";
import { makeWorld, teardown, unwrap, type World } from "../inventory/actionSetup";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
});

afterEach(() => {
  teardown(world);
  mocks.userId.current = null;
});

/** Write straight into the column, the way a hand-edited or older row would look. */
function storeRaw(value: string | null): void {
  writeTx(world.handle.db, (tx) => {
    tx.update(householdSetting)
      .set({ houseBackgroundJson: value })
      .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
      .run();
  });
}

describe("updateHouseBackground", () => {
  it("starts out following the theme, with a NULL column", () => {
    expect(readHouseholdRow(world.handle.db).houseBackgroundJson).toBeNull();
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);
  });

  it("persists a solid colour and round-trips it through the query", async () => {
    const background: HouseBackground = { mode: "solid", color: "#14161a" };
    unwrap(await updateHouseBackground({ background }));
    expect(readHouseBackground(world.handle.db)).toEqual(background);
  });

  it("persists a gradient, including its angle", async () => {
    const background: HouseBackground = {
      mode: "gradient",
      from: "#1b2430",
      to: "#0b0d10",
      angleDeg: 45,
    };
    unwrap(await updateHouseBackground({ background }));
    expect(readHouseBackground(world.handle.db)).toEqual(background);
  });

  it("stores 'follow the theme' as NULL rather than as JSON", async () => {
    unwrap(await updateHouseBackground({ background: { mode: "solid", color: "#14161a" } }));
    expect(readHouseholdRow(world.handle.db).houseBackgroundJson).not.toBeNull();

    unwrap(await updateHouseBackground({ background: { mode: "theme" } }));
    expect(readHouseholdRow(world.handle.db).houseBackgroundJson).toBeNull();
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);
  });

  it("refuses a colour the schema does not accept, and changes nothing", async () => {
    const result = await updateHouseBackground({ background: { mode: "solid", color: "red" } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("invalid_request");
    expect(readHouseholdRow(world.handle.db).houseBackgroundJson).toBeNull();
  });

  it("refuses a mode that does not exist", async () => {
    const result = await updateHouseBackground({
      background: { mode: "texture", url: "/x.png" },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("invalid_request");
  });

  it("records who changed it", async () => {
    unwrap(await updateHouseBackground({ background: { mode: "solid", color: "#14161a" } }));
    const row = readHouseholdRow(world.handle.db);
    expect(row.updatedBy).toBe(world.user.id);

    const entries = world.handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, HOUSEHOLD_SETTING_ID))
      .all();
    const entry = entries.find((e) => e.summary.includes("3D background"));
    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe(world.user.id);
  });

  it("writes nothing when the value has not changed", async () => {
    const background: HouseBackground = { mode: "solid", color: "#14161a" };
    unwrap(await updateHouseBackground({ background }));
    const first = readHouseholdRow(world.handle.db).updatedAtMs;

    unwrap(await updateHouseBackground({ background }));
    expect(readHouseholdRow(world.handle.db).updatedAtMs).toBe(first);
    const audits = world.handle.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, HOUSEHOLD_SETTING_ID))
      .all()
      .filter((e) => e.summary.includes("3D background"));
    expect(audits).toHaveLength(1);
  });

  it("falls back to the theme when the stored JSON is malformed", () => {
    storeRaw("{ this is not json");
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);

    storeRaw('{"mode":"solid"}');
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);

    storeRaw('{"mode":"gradient","from":"#1b2430","to":"chartreuse"}');
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);
  });

  it("recovers from a malformed value: the next write is stored and read back", async () => {
    storeRaw("nonsense");
    expect(readHouseBackground(world.handle.db)).toEqual(DEFAULT_HOUSE_BACKGROUND);
    unwrap(await updateHouseBackground({ background: { mode: "solid", color: "#f4f4f2" } }));
    expect(readHouseBackground(world.handle.db)).toEqual({ mode: "solid", color: "#f4f4f2" });
  });

  it("requires a session", async () => {
    mocks.userId.current = null;
    const result = await updateHouseBackground({ background: { mode: "theme" } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("unauthorized");
  });
});
