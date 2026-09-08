/**
 * GPS removal from stored originals (`docs/design-notes/auth-security-operations.md` §9.5).
 *
 * Derivatives are metadata-free by construction (sharp writes none), but the **original** is kept
 * at full fidelity and must still lose its location. Three layers, in order of preference:
 *
 *  1. `exiftool` — edits metadata only. No re-encode, no generation loss, works on JPEG, HEIC,
 *     PNG and WebP alike. A Homebrew dependency, so not guaranteed.
 *  2. A built-in JPEG segment stripper — drops `APP1` (EXIF *and* XMP, both of which can carry
 *     GPS) and `APP13` (Photoshop IRB), keeps `APP0` (JFIF) and `APP2` (ICC colour profile).
 *     Lossless: the entropy-coded image data is copied through untouched.
 *  3. Give up and report it. Originals are served only to two authenticated household members, so
 *     the residual exposure is one household member seeing a household GPS coordinate — recorded
 *     as an accepted risk rather than hand-waved.
 */
import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Homebrew on Apple Silicon; `exiftool` on PATH is tried as well. */
export const EXIFTOOL_CANDIDATES = ["/opt/homebrew/bin/exiftool", "/usr/local/bin/exiftool", "exiftool"];
export const EXIFTOOL_TIMEOUT_MS = 20_000;

/** APP segments that can carry location data and are therefore dropped. */
const DROP_APP_MARKERS = new Set([0xe1 /* APP1: EXIF, XMP */, 0xed /* APP13: Photoshop IRB */]);

export type ExifStripMethod = "exiftool" | "jpeg-segments" | "none";

export interface ExifStripResult {
  method: ExifStripMethod;
  /** How many bytes the file lost. 0 means there was nothing to remove. */
  removedBytes: number;
  /**
   * True when private metadata may still be in the stored original — no `exiftool` and a format
   * the built-in stripper cannot handle. The caller surfaces this; nothing here re-encodes.
   */
  residual: boolean;
}

let exiftoolPath: string | null | undefined;

/** Resolve `exiftool` once per process; null when it is not installed. */
export async function findExiftool(): Promise<string | null> {
  if (exiftoolPath !== undefined) return exiftoolPath;
  for (const candidate of EXIFTOOL_CANDIDATES) {
    try {
      await execFileAsync(candidate, ["-ver"], { timeout: EXIFTOOL_TIMEOUT_MS, windowsHide: true });
      exiftoolPath = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  exiftoolPath = null;
  return null;
}

/** Tests only: forget the resolved path. */
export function resetExiftoolForTests(): void {
  exiftoolPath = undefined;
}

/**
 * Walk JPEG markers and rewrite the file without the location-bearing APP segments.
 *
 * Returns null — rather than a best effort — for anything that is not a well-formed JPEG marker
 * stream. Refusing is the safe failure here: a half-understood rewrite would corrupt the only
 * full-fidelity copy of a household photo.
 */
export function stripJpegAppSegments(input: Buffer): Buffer | null {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return null;

  const kept: Buffer[] = [input.subarray(0, 2)];
  let at = 2;
  let dropped = false;

  while (at + 1 < input.length) {
    if (input[at] !== 0xff) return null; // not on a marker boundary
    // Fill bytes: any number of 0xFF may precede the marker code.
    let markerAt = at;
    while (markerAt + 1 < input.length && input[markerAt + 1] === 0xff) markerAt++;
    const marker = input[markerAt + 1];
    if (marker === undefined) return null;

    // Standalone markers (TEM, RST0-7) carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(input.subarray(at, markerAt + 2));
      at = markerAt + 2;
      continue;
    }
    // Start of scan: the remainder is entropy-coded data plus EOI. Copy verbatim.
    if (marker === 0xda) {
      kept.push(input.subarray(at));
      return dropped ? Buffer.concat(kept) : input;
    }
    if (marker === 0xd9) {
      kept.push(input.subarray(at, markerAt + 2));
      at = markerAt + 2;
      continue;
    }

    const lengthAt = markerAt + 2;
    if (lengthAt + 2 > input.length) return null;
    const length = input.readUInt16BE(lengthAt);
    if (length < 2 || lengthAt + length > input.length) return null;
    const segmentEnd = lengthAt + length;

    if (DROP_APP_MARKERS.has(marker)) {
      dropped = true;
    } else {
      kept.push(input.subarray(at, segmentEnd));
    }
    at = segmentEnd;
  }

  return dropped ? Buffer.concat(kept) : input;
}

export interface ExifDeps {
  /** Injected in tests: null forces the fallback path. */
  exiftool?: string | null;
  runExiftool?: (bin: string, args: string[]) => Promise<void>;
}

/**
 * Remove GPS (and, on the fallback path, all EXIF/XMP) from the file in place.
 *
 * `mime` is the **sniffed** type, never the client's. Only JPEG has a built-in fallback; a HEIC or
 * PNG original on a machine without `exiftool` keeps its metadata and says so.
 */
export async function stripPrivateMetadata(
  file: string,
  mime: string,
  deps: ExifDeps = {},
): Promise<ExifStripResult> {
  const before = (await fs.stat(file)).size;
  const bin = deps.exiftool !== undefined ? deps.exiftool : await findExiftool();

  if (bin) {
    const run = deps.runExiftool ?? (async (b: string, args: string[]) => {
      await execFileAsync(b, args, { timeout: EXIFTOOL_TIMEOUT_MS, windowsHide: true });
    });
    try {
      // `-gps:all=` deletes every GPS tag; `-geotag=` clears the geotagging group as well.
      await run(bin, ["-overwrite_original", "-gps:all=", "-geotag=", file]);
      const after = (await fs.stat(file)).size;
      return { method: "exiftool", removedBytes: Math.max(0, before - after), residual: false };
    } catch {
      // Fall through to the built-in stripper rather than failing the upload.
    }
  }

  if (mime === "image/jpeg") {
    const original = await fs.readFile(file);
    const stripped = stripJpegAppSegments(original);
    if (stripped) {
      if (stripped.length !== original.length) await fs.writeFile(file, stripped);
      return {
        method: "jpeg-segments",
        removedBytes: original.length - stripped.length,
        residual: false,
      };
    }
  }

  return { method: "none", removedBytes: 0, residual: true };
}
