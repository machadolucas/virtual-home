import "server-only";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { attachment } from "@/db/schema";
import { loadEnv } from "@/env";
import { MAX_MODEL_FIX_IMAGE_BYTES } from "@/house/modelFixTypes";
import { badRequest, HttpError, notFound } from "@/server/api/handler";
import { sniff, SNIFF_HEAD_BYTES } from "@/server/files/sniff";
import { attachmentPath, relDirFor, type AttachmentRow } from "@/server/files/store";
import { log } from "@/server/log";

const IMAGE_OPTIONS = { failOn: "error", limitInputPixels: 12_000_000 } as const;
const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MCP_MAX_IMAGE_BYTES = 512 * 1024;

interface PreparedScreenshot {
  file: string;
  row: AttachmentRow;
}

export async function prepareScreenshot(source: Buffer, actor: string, at: number): Promise<PreparedScreenshot> {
  if (source.byteLength === 0 || source.byteLength > MAX_MODEL_FIX_IMAGE_BYTES) throw badRequest("invalid_screenshot_size");
  const format = sniff(source.subarray(0, SNIFF_HEAD_BYTES));
  if (!format || !ACCEPTED_MIMES.has(format.mime)) throw badRequest("invalid_screenshot_image");
  const image = sharp(source, IMAGE_OPTIONS);
  const encoded = await (async () => {
    try {
      const metadata = await image.metadata();
      if ((metadata.pages ?? 1) > 1) throw badRequest("invalid_screenshot_image");
      return await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    } catch {
      throw badRequest("invalid_screenshot_image");
    }
  })();
  const id = newId();
  const storagePath = path.posix.join(relDirFor(at), `${id}.webp`);
  const file = path.join(loadEnv().attachDir, storagePath);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.part`;
  try {
    await fs.writeFile(staging, encoded.data, { flag: "wx", mode: 0o600 });
    await fs.rename(staging, file);
  } finally {
    await removeScreenshotFile(staging);
  }
  return {
    file,
    row: {
      id, kind: "photo", mime: "image/webp", byteSize: encoded.data.length,
      sha256: createHash("sha256").update(encoded.data).digest("hex"), storagePath,
      originalFilename: "Model fix screenshot.webp",
      width: encoded.info.width, height: encoded.info.height, hasWebCopy: false,
      takenAtMs: at, caption: null, createdBy: actor, updatedBy: actor, createdAtMs: at, updatedAtMs: at,
    },
  };
}

export function registerScreenshot(tx: Db, prepared: PreparedScreenshot): string {
  const old = tx.select({ id: attachment.id }).from(attachment).where(eq(attachment.sha256, prepared.row.sha256)).get();
  if (old) return old.id;
  tx.insert(attachment).values(prepared.row).run();
  return prepared.row.id;
}

export async function removeScreenshotFile(file: string) {
  await fs.rm(file, { force: true }).catch((err: unknown) => log.error({ err }, "model fix screenshot cleanup failed"));
}

export async function readScreenshotImage(row: AttachmentRow, forMcp = false): Promise<Buffer> {
  const file = attachmentPath(row);
  if (!file) throw notFound("screenshot_file_missing");
  if (!forMcp) return fs.readFile(file);
  // One bounded preview per call. JPEG's dark background makes transparent overlays readable.
  const bytes = await sharp(file, IMAGE_OPTIONS).resize({
    width: 1024, height: 1024, fit: "inside", withoutEnlargement: true,
  }).flatten({ background: "#151a22" }).jpeg({ quality: 78 }).toBuffer();
  if (bytes.byteLength > MCP_MAX_IMAGE_BYTES) throw new HttpError(413, "screenshot_preview_too_large");
  return bytes;
}
