import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { eq } from "drizzle-orm";
import { writeTx } from "@/db/client";
import { newId } from "@/db/ids";
import { memberAccess, user, session, mcpConnection, mcpRequest, maintenancePlan, maintenanceOccurrence, notificationRecipientState, userNotifyDevice, completion } from "@/db/schema";
import { loadMembers } from "@/server/queries/maintenance/context";
import { activeMemberIds, isActiveMember, readMemberAccess } from "@/domain/memberAccess";
import { bootstrapOwner, updateMember } from "@/server/services/members";
import { ensureRecipientStates } from "@/domain/notify/recipients";
import { makeDevice, makeOccurrence, makePlan, makeWorld, type TestWorld } from "../domain/fixtures";
import { seedUser } from "../../helpers/db";
let world: TestWorld;
beforeEach(() => { world = makeWorld("2026-09-13T10:00:00Z"); });
afterEach(() => world.close());
const rule = { v: 1, kind: "one_off" } as const;
describe("household member lifecycle", () => {
  it("defaults everyone to member and bootstraps exactly one existing owner by username", () => {
    expect(readMemberAccess(world.handle.db, world.lucas.id)).toEqual({ role: "member", active: true });
    expect(() => writeTx(world.handle.db, tx => bootstrapOwner(tx, "missing"))).toThrow();
    writeTx(world.handle.db, tx => bootstrapOwner(tx, "lucas"));
    expect(readMemberAccess(world.handle.db, world.marja.id)?.role).toBe("member");
    expect(() => writeTx(world.handle.db, tx => bootstrapOwner(tx, "marja"))).toThrow(/already exists/);
    expect(world.handle.db.select().from(user).all().every(row => row.role !== "admin")).toBe(true);
  });
  it("rejects ordinary members, last-owner removal and inactive replacement targets", () => {
    const input = { userId: world.lucas.id, name: "Lucas", role: "member" as const, active: true };
    expect(() => writeTx(world.handle.db, tx => updateMember(tx, world.marja.id, input))).toThrow(/owner/);
    writeTx(world.handle.db, tx => bootstrapOwner(tx, "lucas"));
    expect(() => writeTx(world.handle.db, tx => updateMember(tx, world.lucas.id, input))).toThrow(/owner/);
    expect(() => writeTx(world.handle.db, tx => updateMember(tx, world.lucas.id, { ...input, userId: world.marja.id, active: false, replacementId: world.marja.id }))).toThrow(/active member/);
  });
  it("deactivates access atomically, reassigns open work and retains recorded identities", () => {
    const db = world.handle.db; const owner = world.lucas.id, target = world.marja.id;
    writeTx(db, tx => bootstrapOwner(tx, "lucas"));
    const third = seedUser(world.handle, { username: "guest", name: "Guest" });
    expect(activeMemberIds(db)).toHaveLength(3);
    makeDevice(world, target);
    const planId = makePlan(world, { rule, anchorDate: "2026-09-13", assignmentMode: "user", assigneeUserId: target });
    const occurrenceId = makeOccurrence(world, { planId, dueDate: "2026-09-13", assignmentMode: "user", assigneeUserId: target });
    const connectionId = newId();
    writeTx(db, tx => {
      ensureRecipientStates(tx, world.ctx, tx.select().from(maintenanceOccurrence).where(eq(maintenanceOccurrence.id, occurrenceId)).get()!);
      tx.insert(session).values({ id: newId(), userId: target, token: "test-signed-session", expiresAt: new Date("2030-01-01") }).run();
      tx.insert(mcpConnection).values({ id: connectionId, userId: target, name: "Test", tokenHash: "hash", tokenPrefix: "test", scopesJson: "[]", createdAtMs: 1, expiresAtMs: 9999999999999 }).run();
      tx.insert(mcpRequest).values({ id: newId(), connectionId, operation: "test", payloadJson: "{}", summary: "Test", createdAtMs: 1, expiresAtMs: 9999999999999 }).run();
      updateMember(tx, owner, { userId: target, name: "Marja", role: "member", active: false, replacementId: third.id });
    });
    expect(isActiveMember(db, target)).toBe(false);
    expect(loadMembers(db).some(member => member.id === target)).toBe(false);
    expect(loadMembers(db, { includeInactive: true }).find(member => member.id === target)?.name).toBe("Marja");
    expect(activeMemberIds(db)).toHaveLength(2);
    expect(db.select().from(session).all()).toHaveLength(0);
    expect(db.select().from(mcpConnection).get()?.revokedAtMs).not.toBeNull();
    expect(db.select().from(mcpRequest).get()?.state).toBe("rejected");
    expect(db.select().from(maintenancePlan).get()?.assigneeUserId).toBe(third.id);
    expect(db.select().from(maintenanceOccurrence).get()?.assigneeUserId).toBe(third.id);
    expect(db.select().from(userNotifyDevice).get()?.isActive).toBe(false);
    expect(db.select().from(notificationRecipientState).all().find(row => row.recipientUserId === target)?.state).toBe("suppressed");
    expect(db.select().from(user).all()).toHaveLength(3);
    expect(db.select().from(completion).all()).toHaveLength(0);
    writeTx(db, tx => updateMember(tx, owner, { userId: target, name: "Marja", role: "member", active: true }));
    expect(isActiveMember(db, target)).toBe(true);
    expect(db.select().from(mcpConnection).get()?.revokedAtMs).not.toBeNull();
    expect(db.select().from(userNotifyDevice).get()?.isActive).toBe(false);
  });
  it("excludes banned accounts even without an explicit member-access row", () => {
    writeTx(world.handle.db, tx => tx.update(user).set({ banned: true }).where(eq(user.id, world.marja.id)).run());
    expect(activeMemberIds(world.handle.db)).toEqual([world.lucas.id]);
    expect(world.handle.db.select().from(memberAccess).all()).toHaveLength(0);
  });
});


it("requires an explicit reassignment decision and supports shared household work", () => {
  const db = world.handle.db;
  writeTx(db, tx => bootstrapOwner(tx, "lucas"));
  const planId = makePlan(world, { rule, anchorDate: "2026-09-13", assignmentMode: "user", assigneeUserId: world.marja.id });
  const input = { userId: world.marja.id, name: "Marja", role: "member" as const, active: false };
  expect(() => writeTx(db, tx => updateMember(tx, world.lucas.id, input))).toThrow(/active member/);
  writeTx(db, tx => updateMember(tx, world.lucas.id, { ...input, replacementId: null }));
  expect(db.select().from(maintenancePlan).where(eq(maintenancePlan.id, planId)).get()).toMatchObject({ assignmentMode: "shared", assigneeUserId: null });
});

it("renames login identity without changing historical user IDs and rejects duplicates", () => {
  const db = world.handle.db;
  writeTx(db, tx => bootstrapOwner(tx, "lucas"));
  const input = { userId: world.marja.id, name: "Renamed member", role: "member" as const, active: true };
  expect(() => writeTx(db, tx => updateMember(tx, world.lucas.id, { ...input, username: "LUCAS" }))).toThrow(/already in use/);
  writeTx(db, tx => updateMember(tx, world.lucas.id, { ...input, username: "renamed.member" }));
  expect(db.select().from(user).where(eq(user.id, world.marja.id)).get()).toMatchObject({ id: world.marja.id, username: "renamed.member", email: "renamed.member@virtual-home.local", name: "Renamed member" });
});
