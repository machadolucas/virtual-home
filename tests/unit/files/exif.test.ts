/**
 * GPS removal from stored originals (`docs/design-notes/auth-security-operations.md` §9.5).
 *
 * `exiftool` is a Homebrew dependency, so the fallback path is what these tests pin down: the
 * built-in JPEG segment stripper is forced by injecting `exiftool: null`, which is exactly the
 * situation on a machine where nobody ran `brew install exiftool`.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import sharp from "sharp";
import { stripJpegAppSegments, stripPrivateMetadata } from "@/server/files/exif";

let dir: string;

/** A JPEG carrying EXIF (APP1) and an ICC profile (APP2), which must survive. */
async function jpegWithMetadata(file: string): Promise<void> {
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#2f6f4f" } })
    .withMetadata({
      exif: { IFD0: { Copyright: "household", Artist: "Lucas" } },
      icc: "srgb",
    })
    .jpeg({ quality: 90 })
    .toFile(file);
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vh-exif-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("stripJpegAppSegments", () => {
  it("removes APP1 while keeping the image decodable and the ICC profile intact", async () => {
    const file = path.join(dir, "meta.jpg");
    await jpegWithMetadata(file);
    const original = await fs.readFile(file);
    expect((await sharp(original).metadata()).exif).toBeInstanceOf(Buffer);

    const stripped = stripJpegAppSegments(original)!;
    expect(stripped.length).toBeLessThan(original.length);

    const meta = await sharp(stripped).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(64);
    // APP2 (ICC) is deliberately kept: dropping it would change how the photo looks.
    expect(meta.icc).toBeInstanceOf(Buffer);
  });

  it("returns the input untouched when there is nothing to remove", async () => {
    const file = path.join(dir, "plain.jpg");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#111111" } })
      .jpeg()
      .toFile(file);
    const original = await fs.readFile(file);
    expect(stripJpegAppSegments(original)).toBe(original);
  });

  it("refuses anything that is not a JPEG marker stream rather than corrupting it", async () => {
    expect(stripJpegAppSegments(Buffer.from("%PDF-1.7\n..."))).toBeNull();
    expect(stripJpegAppSegments(Buffer.alloc(2))).toBeNull();
    // A JPEG SOI followed by garbage where a marker must be.
    expect(stripJpegAppSegments(Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});

describe("stripPrivateMetadata", () => {
  it("falls back to the segment stripper when exiftool is absent", async () => {
    const file = path.join(dir, "fallback.jpg");
    await jpegWithMetadata(file);
    const before = (await fs.stat(file)).size;

    const result = await stripPrivateMetadata(file, "image/jpeg", { exiftool: null });
    expect(result.method).toBe("jpeg-segments");
    expect(result.residual).toBe(false);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect((await fs.stat(file)).size).toBe(before - result.removedBytes);
    expect((await sharp(file).metadata()).exif).toBeUndefined();
  });

  it("reports a residual risk for a non-JPEG original with no exiftool", async () => {
    const file = path.join(dir, "meta.png");
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#333333" } })
      .png()
      .toFile(file);
    const result = await stripPrivateMetadata(file, "image/png", { exiftool: null });
    expect(result).toEqual({ method: "none", removedBytes: 0, residual: true });
  });

  it("uses exiftool when it is available, editing metadata only", async () => {
    const file = path.join(dir, "exiftool.jpg");
    await jpegWithMetadata(file);
    const calls: string[][] = [];
    const result = await stripPrivateMetadata(file, "image/jpeg", {
      exiftool: "/fake/exiftool",
      runExiftool: async (_bin, args) => void calls.push(args),
    });
    expect(result.method).toBe("exiftool");
    expect(calls[0]).toEqual(["-overwrite_original", "-gps:all=", "-geotag=", file]);
  });

  it("falls back to the segment stripper when exiftool fails", async () => {
    const file = path.join(dir, "exiftool-fail.jpg");
    await jpegWithMetadata(file);
    const result = await stripPrivateMetadata(file, "image/jpeg", {
      exiftool: "/fake/exiftool",
      runExiftool: async () => {
        throw new Error("exiftool: not executable");
      },
    });
    expect(result.method).toBe("jpeg-segments");
    expect((await sharp(file).metadata()).exif).toBeUndefined();
  });
});
