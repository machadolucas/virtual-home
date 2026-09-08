/**
 * Shared fixtures for the server-action integration tests.
 *
 * The mocks themselves live in each test file, because `vi.mock` has to be hoisted above the
 * imports it replaces and that only works at the top level of the file doing the mocking. What
 * lives here is the part worth sharing: an in-memory database built by the **real migrations**,
 * one user, one room, one shelf, and direct inserts for the rows a given action does not create.
 *
 * Two mocks every action test needs:
 *  - `@/server/auth/session`, because `action()` calls `requireSession()` first thing (CLAUDE.md
 *    rule 2), and standing up Better Auth for each test would be a different test;
 *  - `next/cache`, because `revalidatePath` throws outside a request scope and cache invalidation
 *    is not what these tests are about.
 *
 * Imported by the assets and settings action tests as well: this slice has no shared test-helper
 * directory of its own.
 */
import { eq } from "drizzle-orm";
import { setDbForTests, writeTx, type DbHandle } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import {
  HOUSEHOLD_SETTING_ID,
  asset,
  householdSetting,
  kitComponent,
  location,
  part,
  storagePlace,
  type AssetCategory,
  type PartTrackingMode,
  type PartUnit,
} from "@/db/schema";
import { seedUser, testDb, type SeededUser } from "../../../helpers/db";

export interface World {
  handle: DbHandle;
  user: SeededUser;
  propertyId: string;
  locationId: string;
  storagePlaceId: string;
}

/** A database with the migrations applied, one user, one room and one shelf. */
export function makeWorld(): World {
  const handle = testDb();
  setDbForTests(handle);
  const user = seedUser(handle, { username: "lucas", name: "Lucas" });

  const at = nowMs();
  const propertyId = newId();
  const locationId = newId();
  const storagePlaceId = newId();

  writeTx(handle.db, (tx) => {
    tx.insert(location)
      .values({
        id: propertyId,
        kind: "property",
        parentId: null,
        name: "Example House",
        slug: "property",
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    tx.insert(location)
      .values({
        id: locationId,
        kind: "zone",
        parentId: propertyId,
        name: "Autotalli",
        slug: "garage",
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    tx.insert(storagePlace)
      .values({
        id: storagePlaceId,
        name: "Shelf B",
        locationId,
        createdAtMs: at,
        updatedAtMs: at,
      })
      .run();
    // The migrations seed `household_setting`; pin the fields these tests depend on so a change
    // to the seed defaults cannot quietly change what a test is asserting.
    tx.update(householdSetting)
      .set({ timezone: "Europe/Helsinki", reorderHorizonDays: 90, updatedAtMs: at })
      .where(eq(householdSetting.id, HOUSEHOLD_SETTING_ID))
      .run();
  });

  return { handle, user, propertyId, locationId, storagePlaceId };
}

export function teardown(world: World): void {
  setDbForTests(null);
  world.handle.close();
}

export interface SeedPartInput {
  name?: string;
  trackingMode?: PartTrackingMode;
  unit?: PartUnit;
  isKit?: boolean;
  stockMode?: "stocked" | "not_stocked";
  tracksLots?: boolean;
  reorderThresholdMilli?: number | null;
  reorderTargetMilli?: number | null;
  defaultStoragePlaceId?: string | null;
}

export function seedPart(world: World, input: SeedPartInput = {}): string {
  const id = newId();
  const at = nowMs();
  writeTx(world.handle.db, (tx) => {
    tx.insert(part)
      .values({
        id,
        name: input.name ?? "HEPA filter F7",
        trackingMode: input.trackingMode ?? "discrete",
        unit: input.unit ?? "pcs",
        isKit: input.isKit ?? false,
        stockMode: input.stockMode ?? "stocked",
        tracksLots: input.tracksLots ?? false,
        reorderThresholdMilli: input.reorderThresholdMilli ?? null,
        reorderTargetMilli: input.reorderTargetMilli ?? null,
        defaultStoragePlaceId: input.defaultStoragePlaceId ?? null,
        createdAtMs: at,
        createdBy: world.user.id,
        updatedAtMs: at,
        updatedBy: world.user.id,
      })
      .run();
  });
  return id;
}

export function seedKitComponent(
  world: World,
  kitPartId: string,
  componentPartId: string,
  qtyMilli: number,
): void {
  writeTx(world.handle.db, (tx) => {
    tx.insert(kitComponent).values({ kitPartId, componentPartId, qtyMilli }).run();
  });
}

export interface SeedAssetInput {
  name?: string;
  category?: AssetCategory;
  locationId?: string | null;
  status?: "planned" | "installed" | "removed" | "retired" | "lost";
  installedOn?: string | null;
}

export function seedAsset(world: World, input: SeedAssetInput = {}): string {
  const id = newId();
  const at = nowMs();
  writeTx(world.handle.db, (tx) => {
    tx.insert(asset)
      .values({
        id,
        name: input.name ?? "Ilmanvaihtokone",
        category: input.category ?? "hvac",
        locationId: input.locationId === undefined ? world.locationId : input.locationId,
        status: input.status ?? "installed",
        installedOn: input.installedOn ?? "2019-05-01",
        installedOnPrecision: "exact",
        createdAtMs: at,
        createdBy: world.user.id,
        updatedAtMs: at,
        updatedBy: world.user.id,
      })
      .run();
  });
  return id;
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: unknown };

/** Unwrap an `ActionResult`, failing the test with the server's own code on the unhappy path. */
export function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `action failed: ${result.error}${result.details === undefined ? "" : ` ${JSON.stringify(result.details)}`}`,
    );
  }
  return result.data;
}

/** Assert the action refused, and return the code so the test can name it. */
export function expectRefusal<T>(result: ActionResult<T>): string {
  if (result.ok) throw new Error("expected the action to refuse, but it succeeded");
  return result.error;
}
