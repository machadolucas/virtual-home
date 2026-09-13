import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { user, memberAccess } from "@/db/schema";

export function readMemberAccess(db: Db, userId: string) {
  const row = db.select({ id: user.id, banned: user.banned, role: memberAccess.role, active: memberAccess.isActive })
    .from(user).leftJoin(memberAccess, eq(memberAccess.userId, user.id)).where(eq(user.id, userId)).get();
  return row ? { role: row.role ?? "member", active: row.active !== false && row.banned !== true } : null;
}
export function isActiveMember(db: Db, userId: string): boolean {
  return readMemberAccess(db, userId)?.active === true;
}
export function activeMemberIds(db: Db): string[] {
  return db.select({ id: user.id, banned: user.banned, active: memberAccess.isActive }).from(user)
    .leftJoin(memberAccess, eq(memberAccess.userId, user.id)).all()
    .filter(row => row.active !== false && row.banned !== true).map(row => row.id);
}
