"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, writeTx } from "@/db/client";
import { user } from "@/db/schema";
import { assertOwner, ownerAction } from "@/server/auth/owner";
import { createUser, setPassword, ProvisioningError } from "@/server/auth/provisioning";
import { HttpError } from "@/server/api/handler";
import { auditMember, updateMember } from "@/server/services/members";

export const createMember = ownerAction(z.object({ username: z.string().trim().min(3).max(30), name: z.string().trim().min(1).max(120), password: z.string().min(12).max(128) }), async (input, session) => {
  const result = await createUser(input).catch(error => { if (error instanceof ProvisioningError) throw new HttpError(400, error.code, error.message); throw error; });
  writeTx(getDb().db, tx => { assertOwner(tx, session.user.id); auditMember(tx, session.user.id, result.id, "member_created", "Household member created"); });
  revalidatePath("/settings/users"); return { userId: result.id };
});
export const saveMember = ownerAction(z.object({ userId: z.string().uuid(), username: z.string().trim().min(3).max(30), name: z.string().trim().min(1).max(120), role: z.enum(["owner", "member"]), active: z.boolean(), replacementId: z.string().uuid().nullable().optional() }), (input, session) => {
  writeTx(getDb().db, tx => updateMember(tx, session.user.id, input));
  revalidatePath("/settings/users"); revalidatePath("/today"); revalidatePath("/plans"); return {};
});
export const resetMemberPassword = ownerAction(z.object({ userId: z.string().uuid(), password: z.string().min(12).max(128) }), async (input, session) => {
  const db = getDb().db;
  const target = db.select().from(user).where(eq(user.id, input.userId)).get();
  if (!target?.username) throw new Error("Member not found");
  await setPassword(target.username, input.password).catch(error => { if (error instanceof ProvisioningError) throw new HttpError(400, error.code, error.message); throw error; });
  writeTx(db, tx => { assertOwner(tx, session.user.id); auditMember(tx, session.user.id, input.userId, "password_reset", "Member password reset and sessions revoked"); });
  revalidatePath("/settings/users"); return {};
});
