import { eq, sql } from "drizzle-orm";
import { writeTx, type DbHandle } from "@/db/client";
import { attachment } from "@/db/schema/attachments";
import { documentText } from "@/db/schema/documentText";
import { extractPdf, EXTRACTOR_VERSION } from "@/server/documents/text";
import { publish, EVENT_TOPICS } from "@/server/events/outbox";
import { log } from "@/server/log";
import type { Job } from "./interval";
/** One PDF per pass, no overlapping extraction and no long-running write transaction. */
export function startDocumentTextJob({ handle }: { handle: DbHandle }): Job {
  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function run() {
    if (stopped || busy) return;
    busy = true;
    try {
      const row = handle.db.select({ file: attachment }).from(attachment).leftJoin(documentText, eq(attachment.id, documentText.attachmentId)).where(sql`${attachment.mime} = 'application/pdf' AND (${documentText.attachmentId} IS NULL OR ${documentText.sha256} != ${attachment.sha256} OR ${documentText.extractorVersion} != ${EXTRACTOR_VERSION})`).limit(1).get()?.file;
      if (row) {
        let result: Pick<typeof documentText.$inferInsert, "status" | "pagesJson" | "error">;
        try {
          const extracted = await extractPdf(row);
          result = { status: extracted.status, pagesJson: JSON.stringify(extracted.pages), error: null };
        } catch (e) {
          result = { status: e instanceof Error && e.name === "PasswordException" ? "encrypted" : "failed", pagesJson: "[]", error: "Text extraction unavailable. The original file is retained." };
        }
        if (!stopped) writeTx(handle.db, tx => { tx.insert(documentText).values({ attachmentId: row.id, sha256: row.sha256, extractorVersion: EXTRACTOR_VERSION, ...result, updatedAtMs: Date.now() }).onConflictDoUpdate({ target: documentText.attachmentId, set: { ...result, sha256: row.sha256, extractorVersion: EXTRACTOR_VERSION, updatedAtMs: Date.now() } }).run(); publish(tx,[{topic:EVENT_TOPICS.documentChanged,entityKey:row.id,payload:{id:row.id,status:result.status}}]); });
      }
    } catch (error) { log.warn({ error }, "document text indexing failed"); }
    finally { busy = false; if (!stopped) timer = setTimeout(() => void run(), 15000); }
  }
  timer = setTimeout(() => void run(), 5000);
  return { stop() { stopped = true; clearTimeout(timer); }, runNow() { clearTimeout(timer); void run(); } };
}
