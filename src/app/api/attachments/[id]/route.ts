/**
 * GET /api/attachments/[id]?v=web|thumb — private household files.
 *
 * Served only through this authenticated handler; nothing under `attachments/` is ever reachable
 * from `public/` (`docs/design-notes/auth-security-operations.md` §9.6).
 *
 * Caching is `private, immutable` with a sha-derived ETag: an id + variant names one immutable
 * blob, so the bytes for a URL never change — but `private` (never `public`) keeps a shared cache
 * from ever holding a household photo.
 *
 * Range support is deliberately PDF-only: iOS Safari's PDF viewer issues range requests for large
 * manuals, and a 200-only server makes it download the whole file before showing page 1.
 */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { attachment } from "@/db/schema";
import { authed, badRequest, notFound } from "@/server/api/handler";
import { attachmentPath, type AttachmentVariant } from "@/server/files/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const CACHE = "private, max-age=31536000, immutable";

/** RFC 5987 / RFC 8187 `ext-value`: percent-encoded UTF-8, with the attr-char exceptions escaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * `inline` for what a browser can display, `attachment` otherwise. The filename is always sent
 * twice: a sanitised ASCII fallback and an RFC 5987 UTF-8 form, because Finnish filenames with
 * `ä`/`ö` break naive quoting. CR/LF is stripped at storage time and again here — a filename must
 * never be able to inject a header.
 */
export function contentDisposition(mime: string, filename: string): string {
  const inline = mime.startsWith("image/") || mime === "application/pdf";
  const clean = filename.replace(/[\r\n\0]/g, "").replace(/[/\\]/g, "_");
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // A name that survived as nothing but placeholders ("äöä" → "___") tells the user less than a
  // generic one, so it is not worth sending; the UTF-8 form below still carries the real name.
  const fallback = /[a-zA-Z0-9]/.test(ascii) ? ascii : "file";
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(clean)}`;
}

/** `bytes=start-end` against a known size, or null when the header is not a single valid range. */
export function parseRange(header: string, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  // A suffix range (`bytes=-500`) means the last N bytes.
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (length <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

function variantFrom(url: string): AttachmentVariant {
  const raw = new URL(url).searchParams.get("v");
  if (raw === null) return "orig";
  if (raw === "web" || raw === "thumb") return raw;
  throw badRequest("invalid_variant");
}

export const GET = authed<Ctx>(async (_session, req, ctx) => {
  const { id } = await ctx.params;
  const row = getDb().db.select().from(attachment).where(eq(attachment.id, id)).get();
  if (!row) throw notFound("unknown_attachment");

  const variant = variantFrom(req.url);
  const abs = attachmentPath(row, variant);
  if (!abs) throw notFound("variant_missing");

  // Derivatives are always JPEG; only the original keeps the sniffed type.
  const mime = variant === "orig" ? row.mime : "image/jpeg";
  const etag = `"${row.sha256.slice(0, 32)}-${variant}"`;
  const base: Record<string, string> = {
    ETag: etag,
    "Cache-Control": CACHE,
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: base });
  }

  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isFile()) throw notFound("variant_missing");

  const disposition = contentDisposition(mime, row.originalFilename);
  const rangeHeader = req.headers.get("range");
  if (rangeHeader && mime === "application/pdf") {
    const range = parseRange(rangeHeader, st.size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { ...base, "Content-Range": `bytes */${st.size}` },
      });
    }
    if (range) {
      const stream = createReadStream(abs, { start: range.start, end: range.end });
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        status: 206,
        headers: {
          ...base,
          "Content-Type": mime,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${st.size}`,
          "Accept-Ranges": "bytes",
          "Content-Disposition": disposition,
        },
      });
    }
  }

  return new Response(Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream, {
    headers: {
      ...base,
      "Content-Type": mime,
      "Content-Length": String(st.size),
      "Accept-Ranges": "bytes",
      "Content-Disposition": disposition,
    },
  });
});
