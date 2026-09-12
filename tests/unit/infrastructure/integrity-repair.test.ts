import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const auth = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/server/auth/session", () => ({ requireFreshSession: async () => { if (!auth.allowed) throw new Error("Sign in again to repair storage."); return { user: { id: "01900000-0000-7000-8000-000000000001" } }; } }));
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { appAlert, attachment, integrityQuarantine } from "@/db/schema";
import { quarantineOrphan, restoreQuarantined } from "@/server/actions/settings/integrity";
import { stageRegularFile } from "@/server/files/integrityPaths";
import { runIntegrityCheck } from "@/worker/jobs/integrity";
import { setupHarness, teardownHarness, type Harness } from "./harness";
let h: Harness;
let now: number;
beforeEach(async () => { auth.allowed = true; h = await setupHarness(); now = Date.now() + 120_000; vi.spyOn(Date, "now").mockImplementation(() => now); });
afterEach(() => { vi.restoreAllMocks(); teardownHarness(h); });
function orphan(relative = "2026/09/orphan.pdf") { const absolute = path.join(h.dataDir, "attachments", relative); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, "original bytes"); return { relative, absolute }; }
function rows() { return h.handle.db.select().from(integrityQuarantine).all(); }
function registered(relative: string, hasWebCopy = false) {
  const id = "registered-file";
  writeTx(h.handle.db, tx => tx.insert(attachment).values({ id, kind: "manual", mime: "application/pdf", byteSize: 14, sha256: "synthetic-hash", storagePath: relative, originalFilename: "manual.pdf", hasWebCopy, createdAtMs: now, updatedAtMs: now }).run());
  return id;
}
function report(reportOnly = true) { return runIntegrityCheck({ handle: h.handle, clock: { now: () => now }, tz: "Europe/Helsinki", attachDir: path.join(h.dataDir, "attachments"), reportOnly }); }
function rejectCommit() {
  const original = h.handle.db.transaction.bind(h.handle.db);
  return vi.spyOn(h.handle.db, "transaction").mockImplementation((callback, config) => original(tx => { callback(tx); throw new Error("simulated commit failure"); }, config));
}
describe("reversible integrity repair", () => {
  it("quarantines and restores bytes and makes repeat restore harmless", async () => {
    const file = orphan();
    const moved = await quarantineOrphan(file.relative);
    expect(moved.ok).toBe(true); if (!moved.ok) return;
    expect(fs.existsSync(file.absolute)).toBe(false);
    const quarantined = path.join(h.dataDir, "quarantine", moved.id);
    expect(fs.readFileSync(quarantined, "utf8")).toBe("original bytes");
    expect((await restoreQuarantined(moved.id)).ok).toBe(true);
    expect(fs.readFileSync(file.absolute, "utf8")).toBe("original bytes");
    expect(fs.existsSync(quarantined)).toBe(false);
    expect(rows()[0]?.restoredAtMs).toBe(now);
    expect((await restoreQuarantined(moved.id)).ok).toBe(true);
  });
  it("keeps the original and rolls back staging when a database commit fails", async () => {
    const file = orphan(); const failure = rejectCommit();
    expect((await quarantineOrphan(file.relative)).ok).toBe(false);
    failure.mockRestore();
    expect(fs.readFileSync(file.absolute, "utf8")).toBe("original bytes");
    expect(rows()).toHaveLength(0);
    expect(fs.readdirSync(path.join(h.dataDir, "quarantine"))).toEqual([]);
  });
  it("keeps quarantine bytes when restoration cannot commit", async () => {
    const file = orphan(); const moved = await quarantineOrphan(file.relative); if (!moved.ok) throw new Error(moved.error);
    const failure = rejectCommit();
    expect((await restoreQuarantined(moved.id)).ok).toBe(false); failure.mockRestore();
    expect(fs.existsSync(file.absolute)).toBe(false);
    expect(fs.readFileSync(path.join(h.dataDir, "quarantine", moved.id), "utf8")).toBe("original bytes");
    expect(rows()[0]?.restoredAtMs).toBeNull();
  });
  it("retains a recoverable journal when source cleanup fails, and Restore cleans the duplicate", async () => {
    const file = orphan(), unlink = fs.unlinkSync;
    const originalPath = fs.realpathSync(file.absolute);
    const failed = vi.spyOn(fs, "unlinkSync").mockImplementation(target => { if (String(target) === originalPath) throw Object.assign(new Error("denied"), { code: "EACCES" }); unlink(target); });
    expect((await quarantineOrphan(file.relative)).ok).toBe(false); failed.mockRestore();
    const row = rows()[0]!; expect(row).toBeDefined();
    expect(fs.existsSync(file.absolute)).toBe(true);
    expect(fs.existsSync(path.join(h.dataDir, "quarantine", row.id))).toBe(true);
    expect((await restoreQuarantined(row.id)).ok).toBe(true);
    expect(fs.readFileSync(file.absolute, "utf8")).toBe("original bytes");
    expect(fs.existsSync(path.join(h.dataDir, "quarantine", row.id))).toBe(false);
  });
  it("keeps restored bytes and allows retry when removing the quarantine copy fails", async () => {
    const file = orphan(); const moved = await quarantineOrphan(file.relative); if (!moved.ok) throw new Error(moved.error);
    const quarantined = fs.realpathSync(path.join(h.dataDir, "quarantine", moved.id));
    const unlink = fs.unlinkSync;
    const failure = vi.spyOn(fs, "unlinkSync").mockImplementation(target => { if (String(target) === quarantined) throw Object.assign(new Error("denied"), { code: "EACCES" }); unlink(target); });
    expect(await restoreQuarantined(moved.id)).toMatchObject({ ok: false, error: expect.stringContaining("file is restored") });
    failure.mockRestore();
    expect(fs.readFileSync(file.absolute, "utf8")).toBe("original bytes");
    expect(rows()[0]?.restoredAtMs).toBe(now);
    expect((await restoreQuarantined(moved.id)).ok).toBe(true);
    expect(fs.existsSync(quarantined)).toBe(false);
  });
  it("never removes the only staged copy if the original disappears before rollback", () => {
    const file = orphan(), saved = path.join(h.dataDir, "saved-copy");
    const stage = stageRegularFile(file.absolute, saved);
    fs.unlinkSync(file.absolute);
    expect(() => stage.rollback()).toThrow("preserved for recovery");
    expect(fs.readFileSync(saved, "utf8")).toBe("original bytes");
  });
  it("does not overwrite an occupied original or quarantine destination", async () => {
    const file = orphan(); const moved = await quarantineOrphan(file.relative); if (!moved.ok) throw new Error(moved.error);
    fs.writeFileSync(file.absolute, "new occupant");
    expect((await restoreQuarantined(moved.id)).ok).toBe(false);
    expect(fs.readFileSync(file.absolute, "utf8")).toBe("new occupant");
    expect(() => stageRegularFile(path.join(h.dataDir, "quarantine", moved.id), file.absolute)).toThrow();
    expect(fs.readFileSync(path.join(h.dataDir, "quarantine", moved.id), "utf8")).toBe("original bytes");
  });
  it("rejects source/root symlinks, traversal and fresh uploads", async () => {
    const file = orphan(), outside = path.join(h.dataDir, "outside"); fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(path.dirname(file.absolute), "link.pdf"));
    expect((await quarantineOrphan("2026/09/link.pdf")).ok).toBe(false);
    expect((await quarantineOrphan("../../outside")).ok).toBe(false);
    fs.symlinkSync(path.dirname(file.absolute), path.join(h.dataDir, "quarantine"));
    expect((await quarantineOrphan(file.relative)).ok).toBe(false);
    fs.unlinkSync(path.join(h.dataDir, "quarantine"));
    now = fs.lstatSync(file.absolute).ctimeMs + 10;
    expect(await quarantineOrphan(file.relative)).toMatchObject({ ok: false, error: expect.stringContaining("recently") });
    expect(fs.readFileSync(outside, "utf8")).toBe("outside"); expect(rows()).toHaveLength(0);
  });
  it("revalidates current references, the stored original path, and a fresh session", async () => {
    const file = orphan(); const moved = await quarantineOrphan(file.relative); if (!moved.ok) throw new Error(moved.error);
    registered(file.relative);
    expect(await restoreQuarantined(moved.id)).toMatchObject({ ok: false, error: expect.stringContaining("references") });
    writeTx(h.handle.db, tx => tx.update(integrityQuarantine).set({ originalPath: "../escaped" }).where(eq(integrityQuarantine.id, moved.id)).run());
    expect((await restoreQuarantined(moved.id)).ok).toBe(false);
    auth.allowed = false;
    expect((await quarantineOrphan("anything.pdf")).ok).toBe(false);
    expect((await restoreQuarantined(moved.id)).ok).toBe(false);
  });
});
describe("honest read-only storage reports", () => {
  it("reports missing derivatives and never changes alerts during interactive inspection", () => {
    const file = orphan(); const id = registered(file.relative, true);
    const first = report(false); expect(first.missingFiles).toEqual([id]);
    const before = h.handle.db.select().from(appAlert).all();
    expect(before[0]?.kind).toBe("integrity");
    report(true);
    expect(h.handle.db.select().from(appAlert).all()).toEqual(before);
    for (const variant of ["web", "thumb"]) fs.writeFileSync(path.join(path.dirname(file.absolute), `orphan.${variant}.jpg`), "derived");
    expect(report().missingFiles).toEqual([]);
    expect(h.handle.db.select().from(appAlert).all()).toEqual(before);
  });
  it("does not follow attachment-directory symlinks or report a failed scan as clean", () => {
    const outside = path.join(h.dataDir, "outside-dir"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "private.txt"), "outside");
    fs.symlinkSync(outside, path.join(h.dataDir, "attachments"));
    const result = report(false);
    expect(result.storageError).toBeTruthy(); expect(result.orphanFiles).toEqual([]);
    expect(h.handle.db.select().from(appAlert).all()[0]?.resolvedAtMs).toBeNull();
    expect(fs.readFileSync(path.join(outside, "private.txt"), "utf8")).toBe("outside");
  });
});
