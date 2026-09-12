import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachment } from "@/db/schema/attachments";
import { serviceDocument } from "@/db/schema/maintenance";
import { documentText } from "@/db/schema/documentText";
import { attachmentPath } from "@/server/files/store";
export const EXTRACTOR_VERSION = "pdfjs-6-v1";
export const MAX_PDF_PAGES = 300;
export const MAX_PDF_TEXT = 1_000_000;
export type ExtractedPage = { page: number; text: string };
export async function extractPdf(row: typeof attachment.$inferSelect) {
  const path = attachmentPath(row, "orig");
  if (!path) throw new Error("File missing");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(path)), useSystemFonts: true });
  const deadline = Date.now() + 30000;
  const timeout = setTimeout(() => { void task.destroy(); }, 30000);
  try {
    const pdf = await task.promise;
    const pages: ExtractedPage[] = [];
    let total = 0;
    let textTruncated = false;
    for (let page = 1; page <= Math.min(pdf.numPages, MAX_PDF_PAGES) && total < MAX_PDF_TEXT; page++) {
      if (Date.now() > deadline) throw new Error("Extraction time limit exceeded");
      const p = await pdf.getPage(page);
      const content = await p.getTextContent();
      const source = content.items.map(i => "str" in i ? i.str + (i.hasEOL ? "\n" : " ") : "").join("");
      const text = source.slice(0, Math.min(100_000, MAX_PDF_TEXT - total));
      if (text.length < source.length) textTruncated = true;
      total += text.length; pages.push({ page, text }); p.cleanup();
    }
    return { pages, status: (pdf.numPages > pages.length || total >= MAX_PDF_TEXT || textTruncated ? "truncated" : pages.some(p => p.text.trim()) ? "ready" : "scan") as "ready" | "scan" | "truncated" };
  } finally { clearTimeout(timeout); await task.destroy(); }
}
export function readDocumentText(db: Db, attachmentId: string, options: { page?: number; maxChars?: number; offset?: number } = {}): {id:string;status:string;page:number;text:string;nextPage:number|null;nextOffset:number|null;pageCount?:number;url?:string;error?:string|null} {
  const file = db.select().from(attachment).where(eq(attachment.id, attachmentId)).get();
  if (!file) {
    const record = db.select().from(serviceDocument).where(eq(serviceDocument.id, attachmentId)).get();
    if (!record) throw new Error("Document not found");
    if (record.attachmentId) return { ...readDocumentText(db,record.attachmentId,options), id:record.id, url:`/documents/${record.id}` };
    const source = record.notes ?? "";
    const offset = Math.max(0,Math.trunc(options.offset ?? 0));
    const max = Math.max(1,Math.min(20000,Math.trunc(options.maxChars ?? 4000)));
    const text = source.slice(offset,offset+max);
    return {id:record.id,status:"ready",page:1,pageCount:1,text,nextOffset:offset+text.length<source.length?offset+text.length:null,nextPage:null,url:`/documents/${record.id}`};
  }
  const row = db.select().from(documentText).where(eq(documentText.attachmentId, attachmentId)).get();
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  if (!row || row.sha256 !== file.sha256 || row.extractorVersion !== EXTRACTOR_VERSION) return { id: attachmentId, status: file.mime === "application/pdf" ? "pending" : "not_pdf", page, text: "", nextPage: null, nextOffset: null };
  const pages = JSON.parse(row.pagesJson) as ExtractedPage[];
  const source = pages.find(p => p.page === page)?.text ?? "";
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const max = Math.max(1, Math.min(20000, Math.trunc(options.maxChars ?? 4000)));
  const text = source.slice(offset, offset + max);
  return { id: attachmentId, status: row.status, page, pageCount: pages.length, text, nextOffset: offset + text.length < source.length ? offset + text.length : null, nextPage: page < pages.length ? page + 1 : null, url: `/documents/${attachmentId}`, error: row.error };
}
