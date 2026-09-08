/**
 * Integration tests for linking uploaded files to equipment.
 *
 * The bytes themselves are never exercised here — `/api/upload` and `src/server/files/store.ts`
 * own that path and have their own tests. What this file protects is the `attachment_link` write:
 * an asset that does not exist is refused, a role outside the small vocabulary is refused by zod
 * before it ever reaches the database, and removing a link never touches the `attachment` row
 * itself (the same property `maintenance/attachments.ts` guarantees for task photos).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

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
import { newId, nowMs } from "@/db/ids";
import { attachment, attachmentLink, auditLog } from "@/db/schema";
import {
  linkAssetAttachment,
  unlinkAssetAttachment,
} from "@/server/actions/assets/attachments";
import {
  expectRefusal,
  makeWorld,
  seedAsset,
  teardown,
  unwrap,
  type World,
} from "../inventory/actionSetup";

let world: World;

beforeEach(() => {
  world = makeWorld();
  mocks.userId.current = world.user.id;
});

afterEach(() => {
  mocks.userId.current = null;
  teardown(world);
});

/** A bare `attachment` row, as if `/api/upload` had already staged the file. */
function seedAttachment(input: { kind?: "photo" | "pdf"; originalFilename?: string } = {}): string {
  const id = newId();
  const at = nowMs();
  writeTx(world.handle.db, (tx) => {
    tx.insert(attachment)
      .values({
        id,
        kind: input.kind ?? "photo",
        mime: input.kind === "pdf" ? "application/pdf" : "image/jpeg",
        byteSize: 12_345,
        sha256: `sha-${id}`,
        storagePath: `2026/09/${id}${input.kind === "pdf" ? ".pdf" : ".jpg"}`,
        originalFilename: input.originalFilename ?? "nameplate.jpg",
        hasWebCopy: input.kind !== "pdf",
        createdAtMs: at,
        createdBy: world.user.id,
        updatedAtMs: at,
        updatedBy: world.user.id,
      })
      .run();
  });
  return id;
}

describe("linkAssetAttachment", () => {
  it("links an uploaded file to the asset with the given role", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment({ originalFilename: "close-up.jpg" });

    const { linkId } = unwrap(
      await linkAssetAttachment({ assetId, attachmentId, role: "close_up" }),
    );

    const row = writeTx(world.handle.db, (tx) =>
      tx.select().from(attachmentLink).where(eq(attachmentLink.id, linkId)).get(),
    );
    expect(row).toBeDefined();
    expect(row?.entityKind).toBe("asset");
    expect(row?.entityId).toBe(assetId);
    expect(row?.attachmentId).toBe(attachmentId);
    expect(row?.role).toBe("close_up");
  });

  it("records the actor in the audit log", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();

    const { linkId } = unwrap(
      await linkAssetAttachment({ assetId, attachmentId, role: "manual" }),
    );

    const entry = writeTx(world.handle.db, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityTable, "attachment_link"), eq(auditLog.entityId, linkId)))
        .get(),
    );
    expect(entry).toBeDefined();
    expect(entry?.actorUserId).toBe(world.user.id);
    expect(entry?.action).toBe("created");
  });

  it("sets the attachment's caption when one is given", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();

    unwrap(
      await linkAssetAttachment({
        assetId,
        attachmentId,
        role: "nameplate",
        caption: "Boiler nameplate",
      }),
    );

    const row = writeTx(world.handle.db, (tx) =>
      tx.select().from(attachment).where(eq(attachment.id, attachmentId)).get(),
    );
    expect(row?.caption).toBe("Boiler nameplate");
  });

  it("is a no-op the second time the same file is linked with the same role", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();

    const first = unwrap(await linkAssetAttachment({ assetId, attachmentId, role: "manual" }));
    const second = unwrap(await linkAssetAttachment({ assetId, attachmentId, role: "manual" }));
    expect(second.linkId).toBe(first.linkId);

    const rows = writeTx(world.handle.db, (tx) =>
      tx.select().from(attachmentLink).where(eq(attachmentLink.attachmentId, attachmentId)).all(),
    );
    expect(rows).toHaveLength(1);
  });

  it("refuses an asset that does not exist", async () => {
    const attachmentId = seedAttachment();
    const error = expectRefusal(
      await linkAssetAttachment({ assetId: newId(), attachmentId, role: "close_up" }),
    );
    expect(error).toBe("not_found");
  });

  it("refuses an attachment that does not exist", async () => {
    const assetId = seedAsset(world);
    const error = expectRefusal(
      await linkAssetAttachment({ assetId, attachmentId: newId(), role: "close_up" }),
    );
    expect(error).toBe("not_found");
  });

  it("refuses a role outside the small vocabulary", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();
    const error = expectRefusal(
      await linkAssetAttachment({
        assetId,
        attachmentId,
        // Deliberately outside the enum: `action()` takes `unknown`, so this is a runtime check,
        // not a compile-time one — proving the server rejects it even if a caller's types lied.
        role: "receipt" as never,
      }),
    );
    expect(error).toBe("invalid_request");
  });
});

describe("unlinkAssetAttachment", () => {
  it("removes the link but keeps the attachment row", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();
    unwrap(await linkAssetAttachment({ assetId, attachmentId, role: "document" }));

    unwrap(await unlinkAssetAttachment({ assetId, attachmentId }));

    const link = writeTx(world.handle.db, (tx) =>
      tx
        .select()
        .from(attachmentLink)
        .where(
          and(eq(attachmentLink.attachmentId, attachmentId), eq(attachmentLink.entityId, assetId)),
        )
        .get(),
    );
    expect(link).toBeUndefined();

    const file = writeTx(world.handle.db, (tx) =>
      tx.select().from(attachment).where(eq(attachment.id, attachmentId)).get(),
    );
    expect(file).toBeDefined();
  });

  it("refuses when there is no such link", async () => {
    const assetId = seedAsset(world);
    const attachmentId = seedAttachment();
    const error = expectRefusal(await unlinkAssetAttachment({ assetId, attachmentId }));
    expect(error).toBe("not_found");
  });
});
