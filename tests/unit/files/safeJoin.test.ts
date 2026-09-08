/**
 * `safeJoin` is the only thing between a URL segment and the filesystem
 * (`docs/design-notes/auth-security-operations.md` §9.7), so every rejection rule gets a test.
 *
 * The planted symlink is the case that matters most: with `stat` instead of `lstat` a link named
 * `photo.jpg` pointing at `~/.ssh/id_ed25519` would be served happily.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { ALLOWED_ATTACHMENT_EXT, safeJoin } from "@/server/files/store";

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vh-safejoin-"));
  root = path.join(base, "attachments");
  outside = path.join(base, "secrets");
  fs.mkdirSync(path.join(root, "2026", "09"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  fs.writeFileSync(path.join(root, "2026", "09", "photo.jpg"), "jpeg-bytes");
  fs.writeFileSync(path.join(root, "2026", "09", "notes.txt"), "not allow-listed");
  fs.writeFileSync(path.join(outside, "id_ed25519"), "PRIVATE KEY");
  // A link that looks exactly like a legitimate attachment.
  fs.symlinkSync(path.join(outside, "id_ed25519"), path.join(root, "2026", "09", "linked.jpg"));
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("safeJoin", () => {
  it("resolves a legitimate attachment path", () => {
    const abs = safeJoin(root, "2026", "09", "photo.jpg");
    expect(abs).toBe(path.join(root, "2026", "09", "photo.jpg"));
  });

  it("rejects traversal segments", () => {
    expect(safeJoin(root, "..")).toBeNull();
    expect(safeJoin(root, "..", "..", "secrets", "id_ed25519")).toBeNull();
    expect(safeJoin(root, "2026", "..", "..", "secrets")).toBeNull();
  });

  it("rejects a decoded `..%2f` — the segment still contains a separator", () => {
    const decoded = decodeURIComponent("..%2f..%2fsecrets%2fid_ed25519");
    expect(decoded).toContain("../");
    expect(safeJoin(root, decoded)).toBeNull();
  });

  it("rejects `....//` and any other embedded separator", () => {
    expect(safeJoin(root, "....//")).toBeNull();
    expect(safeJoin(root, "2026/09/photo.jpg")).toBeNull();
    expect(safeJoin(root, "2026\\09\\photo.jpg")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(safeJoin(root, path.join(outside, "id_ed25519"))).toBeNull();
    expect(safeJoin(root, "/etc/passwd")).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(safeJoin(root, "2026", "09", "photo.jpg\0.txt")).toBeNull();
    expect(safeJoin(root, "2026", "09", "photo.jpg\0")).toBeNull();
  });

  it("rejects a symlink, because it uses lstat and not stat", () => {
    const target = path.join(root, "2026", "09", "linked.jpg");
    // Proof the file *is* reachable and readable — only the lstat check stops it.
    expect(fs.statSync(target).isFile()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("PRIVATE KEY");
    expect(safeJoin(root, "2026", "09", "linked.jpg")).toBeNull();
  });

  it("rejects a directory and the root itself", () => {
    expect(safeJoin(root, "2026")).toBeNull();
    expect(safeJoin(root, "2026", "09")).toBeNull();
    expect(safeJoin(root, ".")).toBeNull();
  });

  it("rejects an extension that is not allow-listed", () => {
    expect(safeJoin(root, "2026", "09", "notes.txt")).toBeNull();
    expect(ALLOWED_ATTACHMENT_EXT.has(".txt")).toBe(false);
  });

  it("rejects an empty segment", () => {
    expect(safeJoin(root, "")).toBeNull();
    expect(safeJoin(root, "2026", "", "photo.jpg")).toBeNull();
  });

  it("rejects a path that does not exist", () => {
    expect(safeJoin(root, "2026", "09", "missing.jpg")).toBeNull();
  });
});
