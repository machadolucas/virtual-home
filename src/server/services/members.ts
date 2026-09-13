import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { newId } from "@/db/ids";
import type { Db } from "@/db/client";
import { auditLog, conditionRule, maintenanceOccurrence, maintenancePlan, mcpConnection, mcpRequest, memberAccess, session, user, userNotifyDevice, notificationRecipientState, haNotifyCommand } from "@/db/schema";
import { activeMemberIds, isActiveMember, readMemberAccess } from "@/domain/memberAccess";
import { ensureRecipientStates, enqueueClearCommands } from "@/domain/notify/recipients";
import { systemClock } from "@/domain/time";
import { assertOwner } from "@/server/auth/owner";
import { HttpError } from "@/server/api/handler";
import { normalizeUsername, syntheticEmail, USERNAME_PATTERN } from "@/server/auth/provisioning";
import { householdTimezone } from "@/server/queries/settings/household";

export function auditMember(db: Db, actorId: string | null, targetId: string, action: string, summary: string) {
  db.insert(auditLog).values({ id: newId(), atMs: Date.now(), actorKind: actorId ? "user" : "system", actorUserId: actorId, entityTable: "user", entityId: targetId, action, summary }).run();
}
export function bootstrapOwner(db: Db, username: string): string {
  const target = db.select().from(user).where(eq(user.username, username.trim().toLowerCase())).get();
  if (!target || !isActiveMember(db, target.id)) throw new Error("Choose an existing active username.");
  const owners = db.select().from(memberAccess).where(eq(memberAccess.role, "owner")).all();
  if (owners.length) {
    if (owners.length === 1 && owners[0]!.userId === target.id) return target.id;
    throw new Error("An owner already exists. Use owner account management for further changes.");
  }
  db.insert(memberAccess).values({ userId: target.id, role: "owner", isActive: true, updatedAtMs: Date.now(), updatedBy: null }).onConflictDoUpdate({ target: memberAccess.userId, set: { role: "owner", updatedAtMs: Date.now() } }).run();
  auditMember(db, null, target.id, "owner_bootstrapped", "Initial household owner assigned by local CLI");
  return target.id;
}
export function updateMember(db: Db, actorId: string, input: { userId: string; name: string; username?: string; role: "owner" | "member"; active: boolean; replacementId?: string | null }) {
  assertOwner(db, actorId);
  const target = db.select().from(user).where(eq(user.id, input.userId)).get();
  if (!target) throw new HttpError(404, "not_found", "Member not found.");
  const before = readMemberAccess(db, input.userId)!;
  const otherOwners = db.select().from(memberAccess).where(and(eq(memberAccess.role, "owner"), eq(memberAccess.isActive, true))).all().filter(row => row.userId !== input.userId && isActiveMember(db, row.userId));
  if (before.role === "owner" && (!input.active || input.role !== "owner") && !otherOwners.length) throw new HttpError(409, "last_owner", "Keep at least one active owner.");
  if (!input.active && !activeMemberIds(db).some(id => id !== input.userId)) throw new HttpError(409, "last_member", "Keep at least one active member.");
  if (!input.active && (input.replacementId === undefined || (input.replacementId !== null && (input.replacementId === input.userId || !isActiveMember(db, input.replacementId))))) throw new HttpError(400, "replacement_required", "Choose an active member to receive open work.");
  const username = input.username === undefined ? target.username : normalizeUsername(input.username);
  if (!username || !USERNAME_PATTERN.test(username)) throw new HttpError(400, "invalid_username", "Choose a valid username.");
  const duplicate = db.select({ id: user.id }).from(user).where(eq(sql`lower(${user.username})`, username)).get();
  if (duplicate && duplicate.id !== input.userId) throw new HttpError(409, "user_exists", "That username is already in use.");
  const now = Date.now();
  db.update(user).set({ name: input.name, username, displayUsername: input.name, email: syntheticEmail(username), updatedAt: new Date(now) }).where(eq(user.id, input.userId)).run();
  db.insert(memberAccess).values({ userId: input.userId, role: input.role, isActive: input.active, updatedAtMs: now, updatedBy: actorId }).onConflictDoUpdate({ target: memberAccess.userId, set: { role: input.role, isActive: input.active, updatedAtMs: now, updatedBy: actorId } }).run();
  if (!input.active) {
    const ctx = { clock: systemClock, tz: householdTimezone(db), actorUserId: actorId, actorKind: "user" as const };
    for (const state of db.select().from(notificationRecipientState).where(eq(notificationRecipientState.recipientUserId, input.userId)).all()) enqueueClearCommands(db, ctx, state);
    db.update(maintenancePlan).set({ assigneeUserId: input.replacementId ?? null, assignmentMode: input.replacementId === null ? "shared" : "user", updatedAtMs: now, updatedBy: actorId }).where(and(eq(maintenancePlan.assigneeUserId, input.userId), inArray(maintenancePlan.status, ["active", "paused"]))).run();
    db.update(conditionRule).set({ assigneeUserId: input.replacementId ?? null, assignmentMode: input.replacementId === null ? "shared" : "user", updatedAtMs: now, updatedBy: actorId }).where(eq(conditionRule.assigneeUserId, input.userId)).run();
    db.update(maintenanceOccurrence).set({ assigneeUserId: input.replacementId ?? null, assignmentMode: input.replacementId === null ? "shared" : "user", updatedAtMs: now, updatedBy: actorId }).where(and(eq(maintenanceOccurrence.assigneeUserId, input.userId), inArray(maintenanceOccurrence.status, ["pending", "due"]))).run();
    for (const occurrence of db.select().from(maintenanceOccurrence).where(inArray(maintenanceOccurrence.status, ["pending", "due"])).all()) ensureRecipientStates(db, ctx, occurrence);
    db.delete(session).where(eq(session.userId, input.userId)).run();
    const connections = db.select({ id: mcpConnection.id }).from(mcpConnection).where(eq(mcpConnection.userId, input.userId)).all().map(row => row.id);
    db.update(mcpConnection).set({ revokedAtMs: now }).where(and(eq(mcpConnection.userId, input.userId), isNull(mcpConnection.revokedAtMs))).run();
    if (connections.length) db.update(mcpRequest).set({ state: "rejected", decidedAtMs: now, decidedBy: actorId }).where(and(inArray(mcpRequest.connectionId, connections), eq(mcpRequest.state, "pending"))).run();
    const services = db.select({ name: userNotifyDevice.notifyService }).from(userNotifyDevice).where(eq(userNotifyDevice.userId, input.userId)).all().map(row => row.name);
    if (services.length) db.update(haNotifyCommand).set({ state: "abandoned", lastError: "member_deactivated" }).where(and(inArray(haNotifyCommand.notifyService, services), eq(haNotifyCommand.kind, "notify"), inArray(haNotifyCommand.state, ["queued", "claimed"]))).run();
    db.update(userNotifyDevice).set({ isActive: false }).where(eq(userNotifyDevice.userId, input.userId)).run();
  }
  auditMember(db, actorId, input.userId, input.active ? "member_updated" : "member_deactivated", input.active ? "Member profile and access updated" : "Member deactivated; open work reassigned and access revoked");
}
