/**
 * Content-type sniffing for uploads (`docs/design-notes/auth-security-operations.md` §9.3).
 *
 * The client's `Content-Type` and the filename are ignored **entirely**: both are attacker-chosen,
 * and the whole point of storing a sniffed mime is that what we later serve back with
 * `X-Content-Type-Options: nosniff` is what the bytes actually are.
 *
 * Hand-rolled rather than a dependency, because the allow-list is six types and this is the code
 * that decides what gets written to disk — it should stay short enough to audit in one sitting.
 */

/** Enough for the ISO-BMFF `ftyp` box including a long compatible-brand list. */
export const SNIFF_HEAD_BYTES = 4100;

/** How much of a PDF is scanned for active content. */
export const PDF_SCAN_BYTES = 4096;

export const SNIFFED_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/avif",
  "application/pdf",
] as const;
export type SniffedMime = (typeof SNIFFED_MIMES)[number];

export interface SniffResult {
  mime: SniffedMime;
  /** Canonical extension for the stored original, including the dot. */
  ext: string;
  /** True for the formats the derivative pipeline can process. */
  isImage: boolean;
  /** Needs decoding through libheif or `sips` before sharp can touch it. */
  isHeif: boolean;
}

const RESULTS: Record<SniffedMime, SniffResult> = {
  "image/jpeg": { mime: "image/jpeg", ext: ".jpg", isImage: true, isHeif: false },
  "image/png": { mime: "image/png", ext: ".png", isImage: true, isHeif: false },
  "image/webp": { mime: "image/webp", ext: ".webp", isImage: true, isHeif: false },
  "image/heic": { mime: "image/heic", ext: ".heic", isImage: true, isHeif: true },
  "image/avif": { mime: "image/avif", ext: ".avif", isImage: true, isHeif: true },
  "application/pdf": { mime: "application/pdf", ext: ".pdf", isImage: false, isHeif: false },
};

/** ISO-BMFF brands that mean "HEIF still image or sequence". */
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** Tokens that make a PDF active content rather than a document. */
export const PDF_ACTIVE_CONTENT_MARKERS = ["/JavaScript", "/JS", "/OpenAction"] as const;

export type SniffRejection =
  | "empty"
  | "too_short"
  | "unsupported_type"
  | "pdf_active_content"
  | "heif_brand_unknown";

export class SniffError extends Error {
  constructor(readonly reason: SniffRejection, message: string) {
    super(message);
    this.name = "SniffError";
  }
}

const startsWith = (buf: Buffer, bytes: readonly number[], at = 0): boolean => {
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
};

const ascii = (buf: Buffer, start: number, end: number): string =>
  buf.length < end ? "" : buf.subarray(start, end).toString("latin1");

/**
 * Brands declared by an ISO-BMFF `ftyp` box: the major brand plus every compatible brand.
 * Bounded by the box size so a hostile file cannot make us walk the whole buffer as brands.
 */
function isoBrands(head: Buffer): string[] {
  if (ascii(head, 4, 8) !== "ftyp") return [];
  const boxSize = head.readUInt32BE(0);
  const end = Math.min(head.length, boxSize > 0 ? boxSize : head.length);
  const brands = [ascii(head, 8, 12)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(head, at, at + 4));
  return brands.filter((b) => b.length === 4);
}

/** Does the head of a PDF declare JavaScript or an automatic action? */
export function pdfHasActiveContent(head: Buffer): boolean {
  const text = head.subarray(0, PDF_SCAN_BYTES).toString("latin1");
  return PDF_ACTIVE_CONTENT_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Identify `head` (the first `SNIFF_HEAD_BYTES` of a file), or return null when it is not one of
 * the six allow-listed types. A PDF carrying active content is *not* allow-listed.
 */
export function sniff(head: Buffer): SniffResult | null {
  if (head.length < 12) return null;

  if (startsWith(head, [0xff, 0xd8, 0xff])) return RESULTS["image/jpeg"];
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return RESULTS["image/png"];
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return RESULTS["image/webp"];

  const brands = isoBrands(head);
  if (brands.length > 0) {
    if (brands.some((b) => AVIF_BRANDS.has(b))) return RESULTS["image/avif"];
    if (brands.some((b) => HEIF_BRANDS.has(b))) return RESULTS["image/heic"];
    return null; // an `ftyp` we do not accept: mp4, mov, jpeg-xl containers, …
  }

  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return pdfHasActiveContent(head) ? null : RESULTS["application/pdf"];
  }
  return null;
}

/** `sniff` with a caller-facing reason, for the 415 body of the upload route. */
export function sniffOrThrow(head: Buffer): SniffResult {
  if (head.length === 0) throw new SniffError("empty", "the uploaded file is empty");
  if (head.length < 12) throw new SniffError("too_short", "the uploaded file is too small to identify");
  const result = sniff(head);
  if (result) return result;
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new SniffError(
      "pdf_active_content",
      "this PDF contains JavaScript or an automatic action, so it is not accepted. " +
        "Print or re-export it as a plain PDF and try again.",
    );
  }
  const brands = isoBrands(head);
  if (brands.length > 0) {
    throw new SniffError(
      "heif_brand_unknown",
      `this file is a media container (${brands[0]}) that is not supported. ` +
        "Upload a JPEG, PNG, WebP, HEIC, AVIF or PDF.",
    );
  }
  throw new SniffError(
    "unsupported_type",
    "only JPEG, PNG, WebP, HEIC, AVIF and PDF files can be uploaded (the file's real content " +
      "is checked, not its name).",
  );
}

/** The `attachment.kind` a sniffed type maps to. */
export function kindFor(result: SniffResult): "photo" | "pdf" {
  return result.isImage ? "photo" : "pdf";
}
