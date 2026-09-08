/**
 * The upload pipeline end to end, against the real filesystem and the real migrations
 * (`docs/design-notes/auth-security-operations.md` §9.1–9.5).
 *
 * `tests/setup.ts` points `VH_DATA_DIR` at a temp directory, so `storeUpload` writes into a
 * throwaway copy of the production layout rather than a mock of it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import sharp from "sharp";
import { attachment } from "@/db/schema";
import { setDbForTests, type DbHandle } from "@/db/client";
import { loadEnv } from "@/env";
import { seedUser, testDb } from "../../helpers/db";
import {
  attachmentPath,
  deleteAttachment,
  derivativeRelPath,
  relDirFor,
  sanitizeOrigName,
  storeUpload,
  UploadError,
} from "@/server/files/store";

let handle: DbHandle;
let uploader: string;

/** A JPEG big enough to need shrinking, carrying EXIF that must not survive into derivatives. */
async function photo(seed: number): Promise<Buffer> {
  return sharp({
    create: { width: 2600, height: 1800, channels: 3, background: { r: seed % 256, g: 90, b: 160 } },
  })
    .withMetadata({ exif: { IFD0: { Copyright: `household-${seed}`, Artist: "Lucas" } } })
    .jpeg({ quality: 92 })
    .toFile(path.join(loadEnv().tmpDir, `src-${seed}.jpg`))
    .then(() => fs.readFile(path.join(loadEnv().tmpDir, `src-${seed}.jpg`)));
}

const minimalPdf = (): Buffer =>
  Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "latin1",
  );

const tmpEntries = async (): Promise<string[]> =>
  (await fs.readdir(loadEnv().tmpDir).catch(() => [])).filter((f) => !f.startsWith("src-"));

beforeAll(async () => {
  await fs.mkdir(loadEnv().tmpDir, { recursive: true });
  handle = testDb();
  setDbForTests(handle);
  uploader = seedUser(handle, { username: "lucas", name: "Lucas" }).id;
});

afterAll(() => {
  setDbForTests(null);
  handle.close();
});

beforeEach(() => {
  handle.db.delete(attachment).run();
});

describe("pure helpers", () => {
  it("relDirFor uses a UTC yyyy/mm path", () => {
    expect(relDirFor(Date.UTC(2026, 8, 8, 12))).toBe("2026/09");
    expect(relDirFor(Date.UTC(2026, 0, 1))).toBe("2026/01");
  });

  it("derivativeRelPath replaces the extension, keeping the directory", () => {
    expect(derivativeRelPath("2026/09/abc.heic", "web")).toBe("2026/09/abc.web.jpg");
    expect(derivativeRelPath("2026/09/abc.jpg", "thumb")).toBe("2026/09/abc.thumb.jpg");
  });

  it("sanitizeOrigName strips directories and header-injection characters", () => {
    expect(sanitizeOrigName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeOrigName("C:\\Users\\me\\kuva.jpg")).toBe("kuva.jpg");
    expect(sanitizeOrigName("bad\r\nSet-Cookie: a=b")).toBe("badSet-Cookie: a=b");
    expect(sanitizeOrigName("   ")).toBe("upload");
    expect(sanitizeOrigName("mökki-ohjekirja.pdf")).toBe("mökki-ohjekirja.pdf");
  });
});

describe("storeUpload — photo", () => {
  it("stores the original plus two derivatives and records the metadata", async () => {
    const bytes = await photo(1);
    const stored = await storeUpload({
      buffer: bytes,
      origName: "IMG_0042.JPG",
      uploadedBy: uploader,
    });

    expect(stored.deduped).toBe(false);
    expect(stored.row).toMatchObject({
      kind: "photo",
      mime: "image/jpeg",
      hasWebCopy: true,
      width: 2600,
      height: 1800,
      originalFilename: "IMG_0042.JPG",
      createdBy: uploader,
      updatedBy: uploader,
    });
    expect(stored.row.storagePath).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
    expect(stored.row.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (const variant of ["orig", "web", "thumb"] as const) {
      const abs = attachmentPath(stored.row, variant);
      expect(abs, variant).not.toBeNull();
      expect((await fs.stat(abs!)).isFile(), variant).toBe(true);
    }
    // The row's byte size is the stored original's, after GPS/EXIF removal.
    const abs = attachmentPath(stored.row, "orig")!;
    expect((await fs.stat(abs)).size).toBe(stored.row.byteSize);
  });

  it("leaves no EXIF whatsoever in the derivatives", async () => {
    const stored = await storeUpload({ buffer: await photo(2), origName: "a.jpg", uploadedBy: uploader });
    for (const variant of ["web", "thumb"] as const) {
      const meta = await sharp(attachmentPath(stored.row, variant)!).metadata();
      expect(meta.exif, variant).toBeUndefined();
      expect(meta.xmp, variant).toBeUndefined();
    }
  });

  /**
   * The stored original is deliberately *not* re-encoded, so it keeps its EXIF — minus the
   * location. Which layer did the removal depends on the machine, and each has a different
   * observable outcome (§9.5), so the assertion follows the layer that actually ran.
   */
  it("removes the location from the stored original", async () => {
    const withGps = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: "#204060" },
    })
      .withMetadata({
        exif: {
          IFD0: { Copyright: "household" },
          IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "E" },
        },
      })
      .jpeg()
      .toBuffer();

    const stored = await storeUpload({ buffer: withGps, origName: "geo.jpg", uploadedBy: uploader });
    const abs = attachmentPath(stored.row, "orig")!;

    if (stored.exif?.method === "exiftool") {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const bin = (await import("@/server/files/exif")).findExiftool;
      const { stdout } = await promisify(execFile)((await bin())!, ["-gps:all", "-s", abs]);
      expect(stdout.trim()).toBe("");
      // Non-location metadata survives: no re-encode, no generation loss.
      expect((await sharp(abs).metadata()).exif).toBeInstanceOf(Buffer);
    } else if (stored.exif?.method === "jpeg-segments") {
      expect((await sharp(abs).metadata()).exif).toBeUndefined();
    } else {
      expect(stored.exif?.residual).toBe(true);
    }
  });

  it("hashes the bytes actually on disk, so the row and the file always agree", async () => {
    const stored = await storeUpload({ buffer: await photo(3), origName: "a.jpg", uploadedBy: uploader });
    const { createHash } = await import("node:crypto");
    const onDisk = createHash("sha256")
      .update(await fs.readFile(attachmentPath(stored.row, "orig")!))
      .digest("hex");
    expect(onDisk).toBe(stored.row.sha256);
  });

  it("dedupes a re-upload of the same file instead of storing it twice", async () => {
    const bytes = await photo(4);
    const first = await storeUpload({ buffer: bytes, origName: "manual.jpg", uploadedBy: uploader });
    const second = await storeUpload({ buffer: bytes, origName: "manual-copy.jpg", uploadedBy: uploader });

    expect(second.deduped).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect(handle.db.select().from(attachment).all()).toHaveLength(1);
  });

  it("dedupes two concurrent uploads of the same bytes instead of failing the loser", async () => {
    const bytes = await photo(6);
    const dir = path.join(loadEnv().attachDir, ...relDirFor(Date.now()).split("/"));
    const before = new Set(await fs.readdir(dir).catch(() => []));

    // The dedupe read before the insert is not the arbiter: both calls stage, hash and build their
    // derivatives before either writes, so both can see an empty table. `writeTx` (BEGIN IMMEDIATE)
    // re-reads inside the transaction, so the loser returns the winner's row rather than tripping
    // `ux_attachment_sha256` — which would surface to the browser as a 500 on a duplicate upload.
    const [first, second] = await Promise.all([
      storeUpload({ buffer: bytes, origName: "phone.jpg", uploadedBy: uploader }),
      storeUpload({ buffer: bytes, origName: "laptop.jpg", uploadedBy: uploader }),
    ]);

    expect(second.row.id).toBe(first.row.id);
    expect([first.deduped, second.deduped].sort()).toEqual([false, true]);
    expect(handle.db.select().from(attachment).all()).toHaveLength(1);

    // The loser leaves nothing behind: the only new files are the winner's original and its two
    // derivatives.
    const added = (await fs.readdir(dir)).filter((f) => !before.has(f));
    expect(added).toHaveLength(3);
    expect(added.filter((f) => f.startsWith(first.row.id))).toHaveLength(3);
    expect(await tmpEntries()).toEqual([]);
  });

  it("cleans up its staging files", async () => {
    await storeUpload({ buffer: await photo(5), origName: "a.jpg", uploadedBy: uploader });
    expect(await tmpEntries()).toEqual([]);
  });
});

describe("storeUpload — document", () => {
  it("stores a PDF with no derivatives", async () => {
    const stored = await storeUpload({
      buffer: minimalPdf(),
      origName: "lämmitys-ohje.pdf",
      uploadedBy: uploader,
    });
    expect(stored.row).toMatchObject({ kind: "pdf", mime: "application/pdf", hasWebCopy: false });
    expect(stored.derivatives).toBeNull();
    expect(attachmentPath(stored.row, "web")).toBeNull();
    expect(attachmentPath(stored.row, "thumb")).toBeNull();
    expect((await fs.stat(attachmentPath(stored.row, "orig")!)).isFile()).toBe(true);
  });

  it("honours an explicit kind, so a PDF can be filed as a manual", async () => {
    const stored = await storeUpload({
      buffer: minimalPdf(),
      origName: "manual.pdf",
      uploadedBy: uploader,
      kind: "manual",
      caption: "Boiler manual",
    });
    expect(stored.row.kind).toBe("manual");
    expect(stored.row.caption).toBe("Boiler manual");
  });
});

describe("storeUpload — rejections", () => {
  it("aborts mid-stream once the byte cap is passed, and writes nothing", async () => {
    const big = Buffer.alloc(60_000, 7);
    // A stream, in chunks, so the abort really happens part-way through.
    const chunks = Readable.from(
      Array.from({ length: 6 }, (_, i) => big.subarray(i * 10_000, (i + 1) * 10_000)),
    );
    await expect(
      storeUpload({ stream: chunks, origName: "huge.jpg", uploadedBy: uploader, maxBytes: 25_000 }),
    ).rejects.toBeInstanceOf(UploadError);

    expect(handle.db.select().from(attachment).all()).toHaveLength(0);
    expect(await tmpEntries()).toEqual([]);
  });

  it("reports the cap in the error, with a 413", async () => {
    try {
      await storeUpload({
        buffer: Buffer.alloc(4096),
        origName: "x.jpg",
        uploadedBy: uploader,
        maxBytes: 1024,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UploadError);
      expect((err as UploadError).status).toBe(413);
      expect((err as UploadError).code).toBe("upload_too_large");
    }
  });

  it("rejects an executable renamed to .jpg — the filename is never trusted", async () => {
    const exe = Buffer.alloc(4096);
    Buffer.from([0x4d, 0x5a, 0x90, 0x00]).copy(exe);
    await expect(
      storeUpload({ buffer: exe, origName: "holiday.jpg", uploadedBy: uploader }),
    ).rejects.toThrow(/only JPEG, PNG, WebP, HEIC, AVIF and PDF/);
    expect(handle.db.select().from(attachment).all()).toHaveLength(0);
    expect(await tmpEntries()).toEqual([]);
  });

  it("rejects a PDF with an automatic action", async () => {
    const hostile = Buffer.from(
      "%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF\n",
      "latin1",
    );
    await expect(
      storeUpload({ buffer: hostile, origName: "manual.pdf", uploadedBy: uploader }),
    ).rejects.toThrow(/JavaScript or an automatic action/);
    expect(await tmpEntries()).toEqual([]);
  });

  it("rejects a request with neither a stream nor a buffer", async () => {
    await expect(storeUpload({ origName: "x.jpg", uploadedBy: uploader })).rejects.toThrow(/no file/);
  });
});

describe("deleteAttachment", () => {
  it("removes the row and every variant on disk", async () => {
    const stored = await storeUpload({ buffer: await photo(6), origName: "a.jpg", uploadedBy: uploader });
    const paths = (["orig", "web", "thumb"] as const).map((v) => attachmentPath(stored.row, v)!);

    expect(await deleteAttachment(stored.row.id)).toBe(true);
    expect(handle.db.select().from(attachment).all()).toHaveLength(0);
    for (const p of paths) {
      await expect(fs.stat(p)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("is a no-op for an unknown id", async () => {
    expect(await deleteAttachment("00000000-0000-7000-8000-000000000000")).toBe(false);
  });
});
