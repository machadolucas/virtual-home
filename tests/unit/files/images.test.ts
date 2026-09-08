/**
 * Derivatives and the HEIC decoder choice (`docs/design-notes/auth-security-operations.md` §9.4–9.5).
 *
 * The HEIC tests inject both decoders instead of shipping a HEIC fixture: what needs proving is the
 * *selection and fallback logic*, and a real `.heic` would make the test's outcome depend on which
 * codecs the machine running it happens to have.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import sharp from "sharp";
import {
  decodeHeif,
  heifDecoderOrder,
  HEIF_UNSUPPORTED_MESSAGE,
  ImageError,
  imageCapabilities,
  makeDerivatives,
  readImageSize,
  THUMB_MAX_PX,
  WEB_MAX_PX,
  type ImageCapabilities,
} from "@/server/files/images";

const caps = (heifViaSharp: boolean, heifViaSips: boolean): ImageCapabilities => ({
  heifViaSharp,
  heifViaSips,
  sharpVersion: "test",
  libvipsVersion: "test",
});

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "vh-images-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("capability probe", () => {
  it("reports something for every field and caches the answer", () => {
    const first = imageCapabilities();
    expect(typeof first.heifViaSharp).toBe("boolean");
    expect(typeof first.heifViaSips).toBe("boolean");
    expect(first.sharpVersion).not.toBe("");
    expect(imageCapabilities()).toBe(first);
  });
});

describe("heifDecoderOrder", () => {
  it("prefers sharp, keeps sips as the fallback", () => {
    expect(heifDecoderOrder(caps(true, true))).toEqual(["sharp", "sips"]);
  });
  it("uses sips alone when sharp has no HEIF reader", () => {
    expect(heifDecoderOrder(caps(false, true))).toEqual(["sips"]);
  });
  it("uses sharp alone off macOS", () => {
    expect(heifDecoderOrder(caps(true, false))).toEqual(["sharp"]);
  });
  it("is empty when neither is available", () => {
    expect(heifDecoderOrder(caps(false, false))).toEqual([]);
  });
});

describe("decodeHeif", () => {
  const plausible = async (): Promise<number> => 200_000;

  it("uses sharp when sharp can decode", async () => {
    const calls: string[] = [];
    const result = await decodeHeif("in.heic", "out.jpg", {
      capabilities: caps(true, true),
      decodeWithSharp: async () => void calls.push("sharp"),
      runSips: async () => void calls.push("sips"),
      fileSize: plausible,
    });
    expect(result).toMatchObject({ via: "sharp", path: "out.jpg", failed: [] });
    expect(calls).toEqual(["sharp"]);
  });

  it("falls back to sips when sharp throws — the real iPhone HEVC case", async () => {
    const calls: string[] = [];
    const result = await decodeHeif("in.heic", "out.jpg", {
      capabilities: caps(true, true),
      decodeWithSharp: async () => {
        calls.push("sharp");
        throw new Error("heif: unsupported compression");
      },
      runSips: async () => void calls.push("sips"),
      fileSize: plausible,
    });
    expect(result).toMatchObject({ via: "sips", failed: ["sharp"] });
    expect(calls).toEqual(["sharp", "sips"]);
  });

  it("goes straight to sips when sharp has no HEIF reader at all", async () => {
    const calls: string[] = [];
    await decodeHeif("in.heic", "out.jpg", {
      capabilities: caps(false, true),
      decodeWithSharp: async () => void calls.push("sharp"),
      runSips: async () => void calls.push("sips"),
      fileSize: plausible,
    });
    expect(calls).toEqual(["sips"]);
  });

  it("treats an implausibly small output as a failure, not a success", async () => {
    const calls: string[] = [];
    const result = await decodeHeif("in.heic", "out.jpg", {
      capabilities: caps(true, true),
      decodeWithSharp: async () => void calls.push("sharp"),
      runSips: async () => void calls.push("sips"),
      // sharp "succeeds" with a 12-byte file; sips produces something real.
      fileSize: async () => (calls.length === 1 ? 12 : 200_000),
    });
    expect(result.via).toBe("sips");
    expect(result.failed).toEqual(["sharp"]);
  });

  it("gives the user an actionable message when nothing can decode HEIC", async () => {
    await expect(
      decodeHeif("in.heic", "out.jpg", { capabilities: caps(false, false) }),
    ).rejects.toThrow(HEIF_UNSUPPORTED_MESSAGE);
    await expect(
      decodeHeif("in.heic", "out.jpg", { capabilities: caps(false, false) }),
    ).rejects.toBeInstanceOf(ImageError);
  });

  it("reports both decoders in the error when both fail", async () => {
    await expect(
      decodeHeif("in.heic", "out.jpg", {
        capabilities: caps(true, true),
        decodeWithSharp: async () => {
          throw new Error("no hevc");
        },
        runSips: async () => {
          throw new Error("sips: no such codec");
        },
        fileSize: plausible,
      }),
    ).rejects.toThrow(/tried sharp, sips/);
  });
});

describe("makeDerivatives", () => {
  let source: string;

  beforeAll(async () => {
    source = path.join(dir, "source.jpg");
    await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: { r: 12, g: 120, b: 200 } },
    })
      .withMetadata({ exif: { IFD0: { Copyright: "household", Artist: "Lucas" } } })
      .jpeg({ quality: 95 })
      .toFile(source);
  });

  it("the source really does carry EXIF, so the assertion below means something", async () => {
    const meta = await sharp(source).metadata();
    expect(meta.exif).toBeInstanceOf(Buffer);
  });

  it("bounds the web copy to 2048 px and the thumb to 400 px on the long edge", async () => {
    const out = await makeDerivatives(source, {
      web: path.join(dir, "a.web.jpg"),
      thumb: path.join(dir, "a.thumb.jpg"),
    });
    expect(Math.max(out.web.width, out.web.height)).toBe(WEB_MAX_PX);
    expect(Math.max(out.thumb.width, out.thumb.height)).toBe(THUMB_MAX_PX);
    // Aspect ratio preserved (3:2).
    expect(out.web.width / out.web.height).toBeCloseTo(1.5, 2);
    expect(out.source).toEqual({ width: 3000, height: 2000 });
  });

  it("writes JPEG derivatives with no EXIF at all — GPS included, by construction", async () => {
    const web = path.join(dir, "b.web.jpg");
    const thumb = path.join(dir, "b.thumb.jpg");
    await makeDerivatives(source, { web, thumb });

    for (const file of [web, thumb]) {
      const meta = await sharp(file).metadata();
      expect(meta.format, file).toBe("jpeg");
      expect(meta.exif, file).toBeUndefined();
      expect(meta.xmp, file).toBeUndefined();
      expect(meta.iptc, file).toBeUndefined();
    }
  });

  it("never enlarges: an already-small photo keeps its size in both derivatives", async () => {
    const small = path.join(dir, "small.jpg");
    await sharp({ create: { width: 320, height: 240, channels: 3, background: "#123456" } })
      .jpeg()
      .toFile(small);
    const out = await makeDerivatives(small, {
      web: path.join(dir, "c.web.jpg"),
      thumb: path.join(dir, "c.thumb.jpg"),
    });
    expect(out.web).toMatchObject({ width: 320, height: 240 });
    // 320 is already under the 400 px thumb bound, so upscaling would only add blur.
    expect(out.thumb).toMatchObject({ width: 320, height: 240 });
  });

  it("shrinks a photo between the two bounds only for the thumb", async () => {
    const medium = path.join(dir, "medium.jpg");
    await sharp({ create: { width: 1000, height: 800, channels: 3, background: "#abcdef" } })
      .jpeg()
      .toFile(medium);
    const out = await makeDerivatives(medium, {
      web: path.join(dir, "e.web.jpg"),
      thumb: path.join(dir, "e.thumb.jpg"),
    });
    expect(out.web).toMatchObject({ width: 1000, height: 800 });
    expect(Math.max(out.thumb.width, out.thumb.height)).toBe(THUMB_MAX_PX);
  });

  it("applies EXIF orientation before resizing, so portrait photos are not sideways", async () => {
    // Orientation 6 = rotate 90° clockwise on display: a 400×200 file is really 200×400.
    const rotated = path.join(dir, "rotated.jpg");
    await sharp({ create: { width: 400, height: 200, channels: 3, background: "#654321" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(rotated);

    expect(await readImageSize(rotated)).toEqual({ width: 200, height: 400 });
    const out = await makeDerivatives(rotated, {
      web: path.join(dir, "d.web.jpg"),
      thumb: path.join(dir, "d.thumb.jpg"),
    });
    // Upright in the pixels, with no orientation tag left to interpret.
    expect(out.web.width).toBeLessThan(out.web.height);
    expect((await sharp(out.web.path).metadata()).orientation).toBeUndefined();
  });
});
