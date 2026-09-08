/**
 * Header construction for private file responses (`docs/design-notes/auth-security-operations.md` §9.6).
 *
 * The two helpers under test are the ones with real teeth: `Content-Disposition` is a header built
 * from a client-supplied filename, and `Range` is arithmetic that decides which bytes of a file a
 * caller receives.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { contentDisposition, parseRange } from "@/app/api/attachments/[id]/route";

describe("contentDisposition", () => {
  it("is inline for images and PDFs, so the iOS viewer opens them", () => {
    expect(contentDisposition("image/jpeg", "kuva.jpg")).toMatch(/^inline;/);
    expect(contentDisposition("application/pdf", "manual.pdf")).toMatch(/^inline;/);
  });

  it("is an attachment for anything else", () => {
    expect(contentDisposition("application/octet-stream", "blob.bin")).toMatch(/^attachment;/);
  });

  it("RFC 5987-encodes Finnish filenames and still sends an ASCII fallback", () => {
    const header = contentDisposition("application/pdf", "lämmitys-mökki.pdf");
    expect(header).toContain(`filename*=UTF-8''l%C3%A4mmitys-m%C3%B6kki.pdf`);
    expect(header).toContain('filename="l_mmitys-m_kki.pdf"');
  });

  it("escapes the characters that would otherwise terminate the quoted string", () => {
    const header = contentDisposition("image/png", 'we"ird\\name.png');
    expect(header).toContain('filename="we_ird_name.png"');
    expect(header).not.toMatch(/filename="[^"]*"[^;]/);
  });

  it("cannot be used to inject a header or a path", () => {
    const header = contentDisposition("image/png", "a\r\nSet-Cookie: x=y\r\n.png");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
    expect(contentDisposition("image/png", "../../etc/passwd")).toContain('filename=".._.._etc_passwd"');
  });

  it("falls back to a generic name when nothing usable survives the ASCII pass", () => {
    // "äöä" would become "___", which is no more informative than "file" and looks like damage.
    expect(contentDisposition("image/png", "äöä")).toContain('filename="file"');
    expect(contentDisposition("image/png", "äöä")).toContain("filename*=UTF-8''%C3%A4%C3%B6%C3%A4");
  });
});

describe("parseRange", () => {
  const size = 1000;

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-499", size)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-999", size)).toEqual({ start: 500, end: 999 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=900-", size)).toEqual({ start: 900, end: 999 });
  });

  it("clamps an end beyond the file", () => {
    expect(parseRange("bytes=0-99999", size)).toEqual({ start: 0, end: 999 });
  });

  it("parses a suffix range as the last N bytes", () => {
    expect(parseRange("bytes=-200", size)).toEqual({ start: 800, end: 999 });
    // Longer than the file: the whole file, not a negative offset.
    expect(parseRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("reports an unsatisfiable range so the route can answer 416", () => {
    expect(parseRange("bytes=1000-1100", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=600-500", size)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", size)).toBe("unsatisfiable");
  });

  it("ignores anything it does not fully understand, falling back to a 200", () => {
    expect(parseRange("bytes=0-99, 200-299", size)).toBeNull(); // multipart ranges unsupported
    expect(parseRange("items=0-99", size)).toBeNull();
    expect(parseRange("bytes=-", size)).toBeNull();
    expect(parseRange("nonsense", size)).toBeNull();
  });
});
