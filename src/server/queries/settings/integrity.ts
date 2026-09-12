import "server-only";
import fs from "node:fs";
import { integrityFilePath } from "@/server/files/integrityPaths";
import path from "node:path";
import { desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { integrityQuarantine, attachment, projectLink } from "@/db/schema";
import { loadEnv } from "@/env";
import { systemClock } from "@/domain/time";
import { runIntegrityCheck } from "@/worker/jobs/integrity";
import { householdTimezone } from "./household";
export function integrityReport() {
  const handle = getDb();
  const report = runIntegrityCheck({ handle, clock: systemClock, tz: householdTimezone(handle.db), attachDir: path.join(loadEnv().VH_DATA_DIR, "attachments"), reportOnly: true });
  const names = new Map(handle.db.select({ id: attachment.id, name: attachment.originalFilename }).from(attachment).all().map((r) => [r.id, r.name]));
  const links = handle.db.select().from(projectLink).all();
  return { ...report, missing: report.missingFiles.map((id) => ({ id, name: names.get(id) ?? id })), dangling: links.filter((row) => report.danglingLinks.includes(row.id)), quarantine: handle.db.select().from(integrityQuarantine).orderBy(desc(integrityQuarantine.quarantinedAtMs)).limit(100).all().map((row) => { let hasQuarantineCopy = false; try { hasQuarantineCopy = Boolean(fs.lstatSync(integrityFilePath(path.join(loadEnv().VH_DATA_DIR, "quarantine"), row.id), { throwIfNoEntry: false })?.isFile()); } catch { /* Invalid storage is reported by the repair action. */ } return { ...row, hasQuarantineCopy }; }) };
}
