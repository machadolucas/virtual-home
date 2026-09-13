import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { haDevice, haEntity, haReview, assetHaLink } from "@/db/schema";
import { changeHaReview, ignoredHaItems, isHaIgnored } from "@/server/services/haReview";
import { makeWorld, type TestWorld } from "../../domain/fixtures";
let world: TestWorld;
beforeEach(() => { world = makeWorld("2026-09-13T10:00:00Z"); writeTx(world.handle.db, tx => {
  tx.insert(haDevice).values({ deviceId: "stable-device", name: "Old name", firstSeenMs: 1, lastSeenMs: 1 }).run();
  tx.insert(haEntity).values({ registryId: "stable-entity", entityId: "sensor.old_name", domain: "sensor", deviceId: "stable-device", firstSeenMs: 1, lastSeenMs: 1 }).run();
}); });
afterEach(() => world.close());
describe("persistent Home Assistant import preferences", () => {
  it("uses stable identities across name changes, independently for devices and entities", () => {
    const db = world.handle.db;
    writeTx(db, tx => changeHaReview(tx, world.lucas.id, [{ kind: "entity", registryId: "stable-entity" }], true));
    writeTx(db, tx => tx.update(haEntity).set({ entityId: "sensor.new_name", name: "New name" }).where(eq(haEntity.registryId, "stable-entity")).run());
    expect(isHaIgnored(db, "entity", "stable-entity")).toBe(true);
    expect(isHaIgnored(db, "device", "stable-device")).toBe(false);
    expect(ignoredHaItems(db)[0]?.name).toBe("New name");
    expect(db.select().from(assetHaLink).all()).toEqual([]);
    expect(db.select().from(haEntity).get()?.entityId).toBe("sensor.new_name");
  });
  it("survives registry cache removal and supports restoring a removed item", () => {
    const db = world.handle.db;
    writeTx(db, tx => { changeHaReview(tx, world.lucas.id, [{ kind: "device", registryId: "stable-device" }], true); tx.delete(haDevice).run(); });
    expect(ignoredHaItems(db)).toEqual([{ kind: "device", registryId: "stable-device", name: "Removed registry item" }]);
    writeTx(db, tx => changeHaReview(tx, world.lucas.id, [{ kind: "device", registryId: "stable-device" }], false));
    expect(ignoredHaItems(db)).toEqual([]);
    writeTx(db, tx => changeHaReview(tx, world.lucas.id, [{ kind: "device", registryId: "stable-device" }], true));
    expect(isHaIgnored(db, "device", "stable-device")).toBe(true);
  });
  it("deduplicates bulk requests and rolls the whole write back for an unknown item", () => {
    const db = world.handle.db;
    expect(() => writeTx(db, tx => changeHaReview(tx, world.lucas.id, [{ kind: "device", registryId: "stable-device" }, { kind: "entity", registryId: "missing" }], true))).toThrow();
    expect(db.select().from(haReview).all()).toEqual([]);
    const target = { kind: "device" as const, registryId: "stable-device" };
    expect(writeTx(db, tx => changeHaReview(tx, world.lucas.id, [target, target], true))).toEqual([target]);
    expect(db.select().from(haReview).all()).toHaveLength(1);
  });
});
