/**
 * The attachment store: staging, containment, dedupe, derivatives and metadata
 * (`docs/design-notes/auth-security-operations.md` §9.1–9.5).
 *
 * Nothing is ever written straight into `attachments/`. An upload lands in `tmp/` on the same
 * filesystem, is identified, normalised and hashed there, and only then `rename`d into place —
 * so a file becomes visible at its final path atomically, fully written, or not at all.
 *
 * Blobs never go into SQLite; the row is metadata plus a relative path.
 */
import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { getDb, writeTx, type Db } from "@/db/client";
import { newId, nowMs } from "@/db/ids";
import { attachment, type AttachmentKind } from "@/db/schema";
import { loadEnv } from "@/env";
import { log } from "@/server/log";
import { stripPrivateMetadata, type ExifStripResult } from "./exif";
import { makeDerivatives, decodeHeif, type DerivativeSet } from "./images";
import { kindFor, sniffOrThrow, SNIFF_HEAD_BYTES, type SniffResult } from "./sniff";

/** Extensions the store may ever create or serve. Anything else is a bug or an attack. */
export const ALLOWED_ATTACHMENT_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".heic",
  ".avif",
  ".pdf",
]);

/** Private data directories are 0700; files inside them 0600. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

// ---------------------------------------------------------------------------
// path containment
// ---------------------------------------------------------------------------

/**
 * Join user-influenced path segments under `root`, or return null.
 *
 * Every rule here has a test in `tests/unit/files/safeJoin.test.ts`:
 *  - a segment may not contain NUL, a path separator, or be `.`/`..`/empty — so `..`, `..%2f`
 *    once decoded, `....//` and absolute paths are all rejected before `resolve` ever runs;
 *  - the resolved path must still be inside `root` (belt and braces after the segment rules);
 *  - `lstat` — never `stat` — is what rejects a **symlink** pointing at `~/.ssh/id_ed25519`, and
 *    it also rejects directories, sockets and missing files;
 *  - the extension must be allow-listed.
 */
export function safeJoin(root: string, ...segs: string[]): string | null {
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") return null;
    if (seg.includes("\0") || seg.includes("/") || seg.includes("\\")) return null;
  }
  const abs = path.resolve(root, ...segs);
  const rel = path.relative(root, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const st = lstatSync(abs, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  if (!ALLOWED_ATTACHMENT_EXT.has(path.extname(abs).toLowerCase())) return null;
  return abs;
}

export type AttachmentVariant = "orig" | "web" | "thumb";

export interface AttachmentPathRow {
  /** Relative to `env.attachDir`, POSIX separators: `yyyy/mm/<id><ext>`. */
  storagePath: string;
  hasWebCopy: boolean;
}

/** Derivative names are the original's, with the extension replaced: `<id>.web.jpg`. */
export function derivativeRelPath(storagePath: string, variant: "web" | "thumb"): string {
  const dir = path.posix.dirname(storagePath);
  const base = path.posix.basename(storagePath, path.posix.extname(storagePath));
  return path.posix.join(dir, `${base}.${variant}.jpg`);
}

/**
 * Absolute path of one variant of an attachment, or null when it does not exist (or would escape
 * the attachments directory). The route turns null into a 404, never into a filesystem error.
 */
export function attachmentPath(row: AttachmentPathRow, variant: AttachmentVariant = "orig"): string | null {
  if (variant !== "orig" && !row.hasWebCopy) return null;
  const rel = variant === "orig" ? row.storagePath : derivativeRelPath(row.storagePath, variant);
  return safeJoin(loadEnv().attachDir, ...rel.split("/"));
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

interface StagedFile {
  path: string;
  bytes: number;
  sha256: string;
  head: Buffer;
}

/**
 * Copy `source` to `dest`, counting bytes and aborting the moment the cap is exceeded.
 *
 * `Content-Length` is a hint that an attacker controls; this is the limit that actually holds. The
 * first `SNIFF_HEAD_BYTES` are kept so the type can be identified without re-reading the file.
 */
async function stageStream(source: Readable, dest: string, maxBytes: number): Promise<StagedFile> {
  const hash = createHash("sha256");
  const out = createWriteStream(dest, { mode: FILE_MODE });
  const headParts: Buffer[] = [];
  let headBytes = 0;
  let bytes = 0;

  try {
    for await (const chunk of source) {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buf.length;
      if (bytes > maxBytes) {
        throw new UploadError(
          413,
          "upload_too_large",
          `the file is larger than the ${maxBytes}-byte limit`,
        );
      }
      hash.update(buf);
      if (headBytes < SNIFF_HEAD_BYTES) {
        const slice = buf.subarray(0, SNIFF_HEAD_BYTES - headBytes);
        headParts.push(Buffer.from(slice));
        headBytes += slice.length;
      }
      if (!out.write(buf)) await once(out, "drain");
    }
    out.end();
    await finished(out);
  } catch (err) {
    out.destroy();
    await fs.rm(dest, { force: true });
    throw err;
  }

  return { path: dest, bytes, sha256: hash.digest("hex"), head: Buffer.concat(headParts) };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface StoreUploadInput {
  /** Exactly one of `stream` or `buffer`. */
  stream?: Readable;
  buffer?: Buffer;
  /** The client's filename: kept for display only, never used to build a path or a type. */
  origName: string;
  /** `user.id` of the uploader; recorded as `created_by`/`updated_by`. */
  uploadedBy: string;
  /** Override the kind derived from the sniffed type (`photo` / `pdf`). */
  kind?: AttachmentKind;
  caption?: string;
  /** Defaults to `VH_UPLOAD_MAX_BYTES`. */
  maxBytes?: number;
  /** Trusted transport authorization recheck after streaming, inside metadata registration. */
  beforeCommit?: (tx:Db) => void;
  /** Trusted adapter hook; audit/events commit atomically with a newly registered attachment. */
  onRegistered?: (tx:Db,row:AttachmentRow) => void;
}

export type AttachmentRow = typeof attachment.$inferSelect;

export interface StoredAttachment {
  row: AttachmentRow;
  /** The bytes were already stored under a different id; no new file was written. */
  deduped: boolean;
  sniffed: SniffResult;
  derivatives: DerivativeSet | null;
  exif: ExifStripResult | null;
}

/** `attachments/yyyy/mm` for an instant, POSIX separators (the value stored in the row). */
export function relDirFor(atMs: number): string {
  const at = new Date(atMs);
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}/${mm}`;
}

/** Client filenames are display-only; CR/LF and separators would end up in a header otherwise. */
export function sanitizeOrigName(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\0]/g, "")
    .split(/[/\\]/)
    .pop();
  const trimmed = (cleaned ?? "").trim().slice(0, 200);
  return trimmed === "" ? "upload" : trimmed;
}

/**
 * Store one uploaded file and return its row.
 *
 * Order matters: identify → normalise (GPS out of the original) → hash → dedupe → derive →
 * rename → insert. The hash is taken *after* metadata stripping, so `attachment.sha256` always
 * describes the bytes actually on disk — which is what makes it usable both for dedupe and for
 * the backup round-trip check.
 */
export async function storeUpload(input: StoreUploadInput): Promise<StoredAttachment> {
  const env = loadEnv();
  const maxBytes = input.maxBytes ?? env.VH_UPLOAD_MAX_BYTES;
  await fs.mkdir(env.tmpDir, { recursive: true, mode: DIR_MODE });

  const stagingId = newId();
  const tmpOriginal = path.join(env.tmpDir, `${stagingId}.part`);
  const temps = new Set<string>([tmpOriginal]);
  const finalFiles = new Set<string>();
  let registered = false;
  const cleanup = async (): Promise<void> => {
    for (const file of temps) await fs.rm(file, { force: true });
  };

  try {
    const source = input.stream ?? (input.buffer ? Readable.from([input.buffer]) : null);
    if (!source) throw new UploadError(400, "no_file", "no file content was provided");

    const staged = await stageStream(source, tmpOriginal, maxBytes);
    const sniffed = sniffOrThrow(staged.head);

    // GPS leaves the original before anything else touches it.
    const exif = sniffed.isImage ? await stripPrivateMetadata(tmpOriginal, sniffed.mime) : null;
    if (exif?.residual) {
      log.warn(
        { mime: sniffed.mime },
        "stored original may retain private metadata: exiftool is not installed and this format has no built-in stripper",
      );
    }
    const bytes = (await fs.stat(tmpOriginal)).size;
    const sha256 =
      exif && exif.removedBytes !== 0 ? await sha256File(tmpOriginal) : staged.sha256;

    const db = getDb().db;
    const existing = db.select().from(attachment).where(eq(attachment.sha256, sha256)).get();
    if (existing) {
      input.beforeCommit?.(db);
      await cleanup();
      return { row: existing, deduped: true, sniffed, derivatives: null, exif };
    }

    const id = newId();
    const relDir = relDirFor(nowMs());
    const storagePath = `${relDir}/${id}${sniffed.ext}`;

    // Derivatives are produced in tmp/ so a sharp failure never leaves a half-written variant
    // next to a good original.
    let derivatives: DerivativeSet | null = null;
    if (sniffed.isImage) {
      let derivativeSource = tmpOriginal;
      if (sniffed.isHeif) {
        const decoded = path.join(env.tmpDir, `${stagingId}.decoded.jpg`);
        temps.add(decoded);
        derivativeSource = (await decodeHeif(tmpOriginal, decoded)).path;
      }
      const tmpWeb = path.join(env.tmpDir, `${stagingId}.web.jpg`);
      const tmpThumb = path.join(env.tmpDir, `${stagingId}.thumb.jpg`);
      temps.add(tmpWeb);
      temps.add(tmpThumb);
      derivatives = await makeDerivatives(derivativeSource, { web: tmpWeb, thumb: tmpThumb });
    }

    const absDir = path.join(env.attachDir, ...relDir.split("/"));
    await fs.mkdir(absDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(tmpOriginal, FILE_MODE);
    await fs.rename(tmpOriginal, path.join(absDir, `${id}${sniffed.ext}`));
    finalFiles.add(path.join(absDir, `${id}${sniffed.ext}`));
    temps.delete(tmpOriginal);
    if (derivatives) {
      await fs.chmod(derivatives.web.path, FILE_MODE);
      await fs.chmod(derivatives.thumb.path, FILE_MODE);
      await fs.rename(derivatives.web.path, path.join(absDir, `${id}.web.jpg`));
      finalFiles.add(path.join(absDir, `${id}.web.jpg`));
      await fs.rename(derivatives.thumb.path, path.join(absDir, `${id}.thumb.jpg`));
      finalFiles.add(path.join(absDir, `${id}.thumb.jpg`));
      temps.delete(derivatives.web.path);
      temps.delete(derivatives.thumb.path);
    }

    const at = nowMs();
    const row: AttachmentRow = {
      id,
      kind: input.kind ?? kindFor(sniffed),
      mime: sniffed.mime,
      byteSize: bytes,
      sha256,
      storagePath,
      originalFilename: sanitizeOrigName(input.origName),
      width: derivatives?.source?.width ?? null,
      height: derivatives?.source?.height ?? null,
      hasWebCopy: derivatives !== null,
      takenAtMs: null,
      caption: input.caption ?? null,
      createdAtMs: at,
      createdBy: input.uploadedBy,
      updatedAtMs: at,
      updatedBy: input.uploadedBy,
    };
    // Two identical uploads can race past the dedupe read above; the sha256 unique index is the
    // arbiter. The loser cleans up its files and returns the winner's row.
    let winner: typeof attachment.$inferSelect | null = null;
    writeTx(db, (tx) => {
      input.beforeCommit?.(tx);
      const again = tx.select().from(attachment).where(eq(attachment.sha256, sha256)).get();
      if (again) {
        winner = again;
        return;
      }
      tx.insert(attachment).values(row).run();
      input.onRegistered?.(tx,row);
    });
    registered = winner === null;
    if (winner) {
      await fs.rm(path.join(absDir, `${id}${sniffed.ext}`), { force: true });
      await fs.rm(path.join(absDir, `${id}.web.jpg`), { force: true });
      await fs.rm(path.join(absDir, `${id}.thumb.jpg`), { force: true });
      await cleanup();
      return { row: winner, deduped: true, sniffed, derivatives: null, exif };
    }

    await cleanup();
    return { row, deduped: false, sniffed, derivatives, exif };
  } catch (err) {
    if(!registered) for(const file of finalFiles) await fs.rm(file,{force:true});
    await cleanup();
    throw err;
  }
}

/** Remove the row and every file that belongs to it. Missing files are not an error. */
export async function deleteAttachment(id: string): Promise<boolean> {
  const db = getDb().db;
  const row = db.select().from(attachment).where(eq(attachment.id, id)).get();
  if (!row) return false;

  const env = loadEnv();
  const relatives = [
    row.storagePath,
    ...(row.hasWebCopy
      ? [derivativeRelPath(row.storagePath, "web"), derivativeRelPath(row.storagePath, "thumb")]
      : []),
  ];
  for (const rel of relatives) {
    // Not `safeJoin`: it refuses paths whose file is already gone, and deletion must be
    // idempotent. The containment check is the same, minus the existence requirement.
    const abs = path.resolve(env.attachDir, ...rel.split("/"));
    if (!path.relative(env.attachDir, abs).startsWith("..")) await fs.rm(abs, { force: true });
  }
  writeTx(db, (tx) => tx.delete(attachment).where(eq(attachment.id, id)).run());
  return true;
}
