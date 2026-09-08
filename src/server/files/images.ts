/**
 * Derivative generation and HEIF decoding (`docs/design-notes/auth-security-operations.md` §9.4–9.5).
 *
 * Two rules drive everything here:
 *  - `.rotate()` runs **before** any resize, so EXIF orientation is baked into the pixels. Strip
 *    orientation without applying it and every portrait photo from a phone appears sideways.
 *  - sharp writes no metadata unless `withMetadata()` is called, so derivatives are EXIF-free
 *    (GPS included) *by construction*. Never add `withMetadata()` to these pipelines.
 *
 * HEIC is the awkward case: sharp's prebuilt binary advertises `heif` input but ships only an AV1
 * decoder, so a real HEVC-coded `.heic` from a phone fails at decode time rather than at probe
 * time. The strategy is therefore "try sharp, fall back to `/usr/bin/sips`", with both halves
 * injectable so the choice can be unit-tested without a HEIC fixture.
 */
import "server-only";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** 16k × 16k — a decompression-bomb guard, not a product limit. */
export const LIMIT_INPUT_PIXELS = 268_402_689;

export const WEB_MAX_PX = 2048;
export const WEB_QUALITY = 82;
export const THUMB_MAX_PX = 400;
export const THUMB_QUALITY = 72;

export const SIPS_PATH = "/usr/bin/sips";
export const SIPS_TIMEOUT_MS = 20_000;
/** Quality of the intermediate JPEG a HEIC is decoded into, before the derivative pipeline. */
const HEIF_INTERMEDIATE_QUALITY = 90;

export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ImageError";
  }
}

export interface ImageCapabilities {
  /** sharp reports a HEIF file reader (true for AVIF-only builds too — hence the fallback). */
  heifViaSharp: boolean;
  /** macOS `sips` is present, which decodes HEVC-coded HEIC as well. */
  heifViaSips: boolean;
  sharpVersion: string;
  libvipsVersion: string;
}

let capabilities: ImageCapabilities | null = null;

/**
 * Probe once per process and cache. Logged at startup and surfaced on `/settings/system`, so HEIC
 * behaviour is a known property of the installation rather than something discovered in
 * production by a user whose upload failed.
 */
export function imageCapabilities(): ImageCapabilities {
  capabilities ??= {
    heifViaSharp: Boolean(sharp.format.heif?.input?.file),
    heifViaSips: existsSync(SIPS_PATH),
    sharpVersion: sharp.versions.sharp ?? "unknown",
    libvipsVersion: sharp.versions.vips ?? "unknown",
  };
  return capabilities;
}

/** Tests only: forget the probe result. */
export function resetImageCapabilitiesForTests(): void {
  capabilities = null;
}

export type HeifDecoder = "sharp" | "sips";

/** The decoders to try, in order. Empty means HEIC cannot be handled at all on this machine. */
export function heifDecoderOrder(caps: ImageCapabilities = imageCapabilities()): HeifDecoder[] {
  const order: HeifDecoder[] = [];
  if (caps.heifViaSharp) order.push("sharp");
  if (caps.heifViaSips) order.push("sips");
  return order;
}

export const HEIF_UNSUPPORTED_MESSAGE =
  "Your phone sent a HEIC file and this machine cannot convert it. Set Settings → Camera → " +
  "Formats → Most Compatible on the phone, or upload a JPEG.";

/** `sips` is invoked with `execFile` (never a shell) and a hard timeout. */
export async function runSips(src: string, dest: string): Promise<void> {
  await execFileAsync(
    SIPS_PATH,
    ["-s", "format", "jpeg", "-s", "formatOptions", String(HEIF_INTERMEDIATE_QUALITY), src, "--out", dest],
    { timeout: SIPS_TIMEOUT_MS, windowsHide: true },
  );
}

async function decodeWithSharp(src: string, dest: string): Promise<void> {
  await sharp(src, { failOn: "error", limitInputPixels: LIMIT_INPUT_PIXELS })
    .rotate()
    .jpeg({ quality: HEIF_INTERMEDIATE_QUALITY, mozjpeg: true })
    .toFile(dest);
}

/** An output that exists but is empty or absurdly small means the converter failed quietly. */
const MIN_PLAUSIBLE_JPEG_BYTES = 512;

export interface HeifDeps {
  capabilities?: ImageCapabilities;
  decodeWithSharp?: (src: string, dest: string) => Promise<void>;
  runSips?: (src: string, dest: string) => Promise<void>;
  /** Injected in tests so the size sanity check does not need a real JPEG. */
  fileSize?: (file: string) => Promise<number>;
}

export interface HeifDecodeResult {
  path: string;
  via: HeifDecoder;
  /** Decoders that were tried and threw, in order. */
  failed: HeifDecoder[];
}

/**
 * Decode a HEIC/AVIF file at `src` into a JPEG at `dest`, trying every available decoder.
 *
 * Both decoders are tried because the probe cannot tell an AVIF-only sharp build from a full one;
 * the honest test is whether the decode succeeds.
 */
export async function decodeHeif(src: string, dest: string, deps: HeifDeps = {}): Promise<HeifDecodeResult> {
  const caps = deps.capabilities ?? imageCapabilities();
  const order = heifDecoderOrder(caps);
  if (order.length === 0) throw new ImageError(HEIF_UNSUPPORTED_MESSAGE, "heif_unsupported");

  const decoders: Record<HeifDecoder, (s: string, d: string) => Promise<void>> = {
    sharp: deps.decodeWithSharp ?? decodeWithSharp,
    sips: deps.runSips ?? runSips,
  };
  const size = deps.fileSize ?? (async (file) => (await fs.stat(file)).size);

  const failed: HeifDecoder[] = [];
  let lastError: unknown;
  for (const decoder of order) {
    try {
      await decoders[decoder](src, dest);
      const bytes = await size(dest);
      if (bytes < MIN_PLAUSIBLE_JPEG_BYTES) {
        throw new ImageError(`${decoder} produced only ${bytes} bytes`, "heif_output_too_small");
      }
      return { path: dest, via: decoder, failed };
    } catch (err) {
      lastError = err;
      failed.push(decoder);
      await fs.rm(dest, { force: true });
    }
  }
  throw new ImageError(
    `could not decode the HEIC/AVIF file (tried ${failed.join(", ")}): ` +
      (lastError instanceof Error ? lastError.message : String(lastError)),
    "heif_decode_failed",
  );
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Pixel dimensions *after* EXIF orientation is applied, which is what the derivatives will have. */
export async function readImageSize(file: string): Promise<ImageSize | null> {
  const meta = await sharp(file, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
  const upright = meta.orientation !== undefined && meta.orientation >= 5;
  const width = upright ? meta.height : meta.width;
  const height = upright ? meta.width : meta.height;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return { width, height };
}

export interface DerivativeFile {
  path: string;
  bytes: number;
  width: number;
  height: number;
}

export interface DerivativeSet {
  web: DerivativeFile;
  thumb: DerivativeFile;
  /** Dimensions of the source, upright. */
  source: ImageSize | null;
}

/**
 * Write the two JPEG derivatives. `withoutEnlargement` keeps a small image small: an 800 px photo
 * gets an 800 px "web" copy rather than an upscaled blur.
 */
export async function makeDerivatives(
  input: string,
  targets: { web: string; thumb: string },
): Promise<DerivativeSet> {
  const pipeline = sharp(input, { failOn: "error", limitInputPixels: LIMIT_INPUT_PIXELS }).rotate();

  const web = await pipeline
    .clone()
    .resize({ width: WEB_MAX_PX, height: WEB_MAX_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: WEB_QUALITY, mozjpeg: true })
    .toFile(targets.web);

  const thumb = await pipeline
    .clone()
    .resize({ width: THUMB_MAX_PX, height: THUMB_MAX_PX, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toFile(targets.thumb);

  return {
    web: { path: targets.web, bytes: web.size, width: web.width, height: web.height },
    thumb: { path: targets.thumb, bytes: thumb.size, width: thumb.width, height: thumb.height },
    source: await readImageSize(input).catch(() => null),
  };
}
