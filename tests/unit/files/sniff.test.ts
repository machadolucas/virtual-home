/**
 * Magic-byte sniffing (`docs/design-notes/auth-security-operations.md` §9.3).
 *
 * The headers here are built by hand rather than loaded from fixtures, because what is being
 * tested is the byte-level decision itself — a fixture would only prove that one particular file
 * happens to work.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  kindFor,
  pdfHasActiveContent,
  sniff,
  SniffError,
  sniffOrThrow,
  SNIFF_HEAD_BYTES,
} from "@/server/files/sniff";

/** Pad a header out so it clears the minimum length the sniffer requires. */
const pad = (head: number[] | Buffer, size = 64): Buffer => {
  const buf = Buffer.alloc(size);
  Buffer.from(head).copy(buf);
  return buf;
};

const jpeg = (): Buffer => pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const png = (): Buffer => pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const webp = (): Buffer => {
  const buf = Buffer.alloc(64);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(56, 4);
  buf.write("WEBPVP8 ", 8, "latin1");
  return buf;
};

/** An ISO-BMFF `ftyp` box: size, "ftyp", major brand, minor version, compatible brands. */
const isoBmff = (major: string, compatible: string[] = []): Buffer => {
  const boxSize = 16 + compatible.length * 4;
  const buf = Buffer.alloc(Math.max(64, boxSize));
  buf.writeUInt32BE(boxSize, 0);
  buf.write("ftyp", 4, "latin1");
  buf.write(major, 8, "latin1");
  buf.writeUInt32BE(0, 12);
  compatible.forEach((brand, i) => buf.write(brand, 16 + i * 4, "latin1"));
  return buf;
};

const pdf = (body = "1 0 obj\n<< /Type /Catalog >>\nendobj\n"): Buffer =>
  Buffer.concat([Buffer.from("%PDF-1.7\n", "latin1"), Buffer.from(body, "latin1")]);

describe("sniff accepts the six allow-listed types", () => {
  it("JPEG", () => expect(sniff(jpeg())).toMatchObject({ mime: "image/jpeg", ext: ".jpg", isImage: true }));
  it("PNG", () => expect(sniff(png())).toMatchObject({ mime: "image/png", ext: ".png" }));
  it("WebP", () => expect(sniff(webp())).toMatchObject({ mime: "image/webp", ext: ".webp" }));
  it("PDF", () =>
    expect(sniff(pdf())).toMatchObject({ mime: "application/pdf", ext: ".pdf", isImage: false }));

  it("HEIC, for every brand a phone might write", () => {
    for (const brand of ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"]) {
      expect(sniff(isoBmff(brand)), brand).toMatchObject({ mime: "image/heic", isHeif: true });
    }
  });

  it("HEIC declared only as a compatible brand", () => {
    expect(sniff(isoBmff("mp42", ["mp41", "heic"]))).toMatchObject({ mime: "image/heic" });
  });

  it("AVIF, and AVIF wins over a HEIF compatible brand", () => {
    expect(sniff(isoBmff("avif"))).toMatchObject({ mime: "image/avif", isHeif: true });
    expect(sniff(isoBmff("avis", ["mif1"]))).toMatchObject({ mime: "image/avif" });
  });

  it("maps images to the `photo` kind and PDFs to `pdf`", () => {
    expect(kindFor(sniff(jpeg())!)).toBe("photo");
    expect(kindFor(sniff(pdf())!)).toBe("pdf");
  });
});

describe("sniff rejects everything else", () => {
  it("a Windows executable renamed to .jpg", () => {
    // `MZ` — the client can call it whatever it likes; the bytes decide.
    const exe = pad([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
    expect(sniff(exe)).toBeNull();
    expect(() => sniffOrThrow(exe)).toThrow(SniffError);
    try {
      sniffOrThrow(exe);
    } catch (err) {
      expect((err as SniffError).reason).toBe("unsupported_type");
    }
  });

  it("an mp4 — an `ftyp` box we do not accept", () => {
    expect(sniff(isoBmff("mp42", ["isom", "mp41"]))).toBeNull();
    try {
      sniffOrThrow(isoBmff("mp42"));
    } catch (err) {
      expect((err as SniffError).reason).toBe("heif_brand_unknown");
    }
  });

  it("an SVG, which would be script-bearing markup", () => {
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
  });

  it("a RIFF container that is not WebP", () => {
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0, "latin1");
    wav.write("WAVEfmt ", 8, "latin1");
    expect(sniff(wav)).toBeNull();
  });

  it("an empty or truncated file", () => {
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull(); // a JPEG magic and nothing else
    expect(() => sniffOrThrow(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => sniffOrThrow(Buffer.from([0xff, 0xd8, 0xff]))).toThrow(/too small/);
  });
});

describe("PDF active content", () => {
  it("rejects /OpenAction", () => {
    const hostile = pdf("<< /OpenAction << /S /JavaScript /JS (app.alert('hi')) >> >>\n");
    expect(pdfHasActiveContent(hostile)).toBe(true);
    expect(sniff(hostile)).toBeNull();
    try {
      sniffOrThrow(hostile);
    } catch (err) {
      expect((err as SniffError).reason).toBe("pdf_active_content");
      expect((err as SniffError).message).toMatch(/JavaScript or an automatic action/);
    }
  });

  it("rejects /JavaScript and /JS on their own", () => {
    expect(sniff(pdf("<< /Names [ (script) << /JavaScript 1 0 R >> ] >>\n"))).toBeNull();
    expect(sniff(pdf("<< /S /JS >>\n"))).toBeNull();
  });

  it("accepts a plain PDF", () => {
    expect(sniff(pdf("<< /Type /Page /Contents 4 0 R >>\n"))).not.toBeNull();
  });

  it("only scans the head, so a marker beyond the window does not change the verdict", () => {
    const filler = "x".repeat(SNIFF_HEAD_BYTES);
    // Beyond PDF_SCAN_BYTES: accepted here, and defence in depth is the `nosniff` + `private`
    // serving path plus the fact that we never execute a stored file.
    expect(sniff(pdf(`${filler}/OpenAction`))).not.toBeNull();
  });
});
