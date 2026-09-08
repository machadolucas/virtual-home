import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@/db/client";
import { location } from "@/db/schema";
import type { CurrentPackage } from "@/server/house-model/package";
import { registerRevision } from "@/server/house-model/revision";
import { seedUser, testDb } from "../../helpers/db";
import { FIXTURE_DIR, loadManifest } from "../house/glb";

const base = loadManifest(FIXTURE_DIR);

function pkgOf(fingerprint: string): CurrentPackage {
  return { modelId: base.modelId, fingerprint, dir: `/nonexistent/${fingerprint}`, manifest: base, diagnostics: [], assetFiles: new Map(), lock: null };
}

let handle: DbHandle;
let actor: string;

beforeEach(async () => {
  handle = testDb();
  actor = (await seedUser(handle, { username: "lucas", name: "Lucas" })).id;
});
afterEach(() => handle.close());

describe("location sync on import", () => {
  it("mirrors the package's buildings, floors and rooms into the location tree", () => {
    registerRevision(handle, pkgOf("fp-1"), actor);
    const rows = handle.db.select().from(location).all();
    const kinds = rows.reduce<Record<string, number>>((acc, r) => ((acc[r.kind] = (acc[r.kind] ?? 0) + 1), acc), {});
    expect(kinds.property).toBe(1);
    expect(kinds.building).toBe(base.buildings.length);
    expect(kinds.floor).toBe(base.floors.length);
    expect(kinds.room).toBe(base.rooms.length);
    const room = rows.find((r) => r.kind === "room")!;
    const floor = rows.find((r) => r.id === room.parentId)!;
    expect(floor.kind).toBe("floor");
    expect(room.modelNodeId).toBe(room.slug);
    expect(new Set(rows.map((r) => r.slug)).size).toBe(rows.length);
  });

  it("re-imports update in place and keep user-edited names", () => {
    const first = registerRevision(handle, pkgOf("fp-1"), actor);
    const room = handle.db.select().from(location).where(eq(location.kind, "room")).get()!;
    handle.db.update(location).set({ name: "Our kitchen" }).where(eq(location.id, room.id)).run();
    const before = handle.db.select().from(location).all().length;

    const second = registerRevision(handle, pkgOf("fp-2"), actor); // same ids, new fingerprint
    expect(second.status).toBe("auto_carried");
    const rows = handle.db.select().from(location).all();
    expect(rows.length).toBe(before);
    const again = rows.find((r) => r.id === room.id)!;
    expect(again.name).toBe("Our kitchen");
    expect(again.modelRevisionId).toBe(second.revisionId);
    expect(again.modelRevisionId).not.toBe(first.revisionId);
  });
});
