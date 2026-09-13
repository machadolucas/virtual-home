import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { newId } from "@/db/ids";
import { auditLog, haReview, haDevice, haEntity } from "@/db/schema";
import { HttpError } from "@/server/api/handler";

export type ReviewTarget = { kind: "device" | "entity"; registryId: string };
export function isHaIgnored(db: Db, kind: ReviewTarget["kind"], registryId: string): boolean {
  return db.select({ ignored: haReview.ignored }).from(haReview).where(and(eq(haReview.kind, kind), eq(haReview.registryId, registryId))).get()?.ignored === true;
}
export function changeHaReview(db: Db, actorId: string, targets: ReviewTarget[], ignored: boolean) {
  const unique = [...new Map(targets.map(target => [`${target.kind}:${target.registryId}`, target])).values()];
  for (const target of unique) {
    const known = target.kind === "device" ? db.select({ id: haDevice.deviceId }).from(haDevice).where(eq(haDevice.deviceId, target.registryId)).get() : db.select({ id: haEntity.registryId }).from(haEntity).where(eq(haEntity.registryId, target.registryId)).get();
    const reviewed = db.select({ id: haReview.registryId }).from(haReview).where(and(eq(haReview.kind, target.kind), eq(haReview.registryId, target.registryId))).get();
    if (!known && !reviewed) throw new HttpError(404, "not_found", "Registry item no longer exists.");
    db.insert(haReview).values({ ...target, ignored, updatedAtMs: Date.now(), updatedBy: actorId }).onConflictDoUpdate({ target: [haReview.kind, haReview.registryId], set: { ignored, updatedAtMs: Date.now(), updatedBy: actorId } }).run();
  }
  db.insert(auditLog).values({ id: newId(), atMs: Date.now(), actorKind: "user", actorUserId: actorId, entityTable: "ha_review", entityId: unique.map(target => `${target.kind}:${target.registryId}`).join(","), action: ignored ? "ignored" : "restored", summary: `${ignored ? "Ignored" : "Restored"} ${unique.length} Home Assistant import items` }).run();
  return unique;
}
export function ignoredHaItems(db: Db) {
  const devices = new Map(db.select().from(haDevice).all().map(row => [row.deviceId, row.nameByUser ?? row.name ?? row.deviceId]));
  const entities = new Map(db.select().from(haEntity).all().map(row => [row.registryId, row.name ?? row.originalName ?? row.entityId]));
  return db.select().from(haReview).where(eq(haReview.ignored, true)).all().map(row => ({ kind: row.kind, registryId: row.registryId, name: (row.kind === "device" ? devices : entities).get(row.registryId) ?? "Removed registry item" }));
}
