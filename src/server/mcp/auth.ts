import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { type Db, writeTx } from "@/db/client";
import { mcpConnection } from "@/db/schema/mcp";
import { user } from "@/db/schema/auth";
import { newId } from "@/db/ids";
import { HttpError } from "@/server/api/handler";

export const MCP_SCOPES = ["read", "author", "request_actions"] as const;
export type McpScope = typeof MCP_SCOPES[number];
export interface McpIdentity { connectionId: string; userId: string; name: string; scopes: McpScope[]; credentialHash?:string }
export const connectionInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).max(3),
  expiresInDays: z.number().int().min(1).max(365).default(90),
}).strict();
export function hashSecret(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function createConnection(db: Db, userId: string, raw: unknown, now = Date.now()) {
  const input = connectionInput.parse(raw);
  const token = `vh_mcp_${randomBytes(32).toString("base64url")}`;
  const id = newId();
  writeTx(db, (tx) => {
    if (!tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).get()) throw new HttpError(401, "unauthorized");
    tx.insert(mcpConnection).values({ id, userId, name: input.name, tokenHash: hashSecret(token),
      tokenPrefix: token.slice(0, 14), scopesJson: JSON.stringify([...new Set(["read", ...input.scopes])]),
      createdAtMs: now, expiresAtMs: now + input.expiresInDays * 86_400_000 }).run();
  });
  return { id, token };
}

/** Also called inside writeTx immediately before every mutation/approval. */
export function assertConnection(db: Db, id: string, scope: McpScope, now = Date.now(), credentialHash?:string): McpIdentity {
  const row = db.select().from(mcpConnection).where(eq(mcpConnection.id, id)).get();
  if (!row || row.revokedAtMs !== null || row.expiresAtMs <= now) throw new HttpError(401, "connection_expired_or_revoked");
  if(credentialHash!==undefined&&credentialHash!==row.tokenHash)throw new HttpError(401,"invalid_mcp_token");
  const member = db.select({ id: user.id, banned: user.banned }).from(user).where(eq(user.id, row.userId)).get();
  if (!member || member.banned) throw new HttpError(401, "unauthorized");
  const scopes = z.array(z.enum(MCP_SCOPES)).parse(JSON.parse(row.scopesJson));
  if (!scopes.includes(scope)) throw new HttpError(403, "scope_required", undefined, { scope });
  return { connectionId: row.id, userId: row.userId, name: row.name, scopes, credentialHash:row.tokenHash };
}

/** Caller authenticates with a fresh browser session. Preserves the connection and its grants. */
export function rotateConnectionToken(db:Db,id:string,now=Date.now()){
  return writeTx(db,tx=>{
    assertConnection(tx,id,"read",now);
    const token=`vh_mcp_${randomBytes(32).toString("base64url")}`;
    tx.update(mcpConnection).set({tokenHash:hashSecret(token),tokenPrefix:token.slice(0,14)}).where(eq(mcpConnection.id,id)).run();
    return {id,token};
  });
}

export function authenticateMcp(db: Db, authorization: string | null, now = Date.now()): McpIdentity {
  const token = /^Bearer (vh_mcp_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
  if (!token) throw new HttpError(401, "mcp_token_required");
  const row = db.select({ id: mcpConnection.id, lastUsed: mcpConnection.lastUsedAtMs }).from(mcpConnection)
    .where(eq(mcpConnection.tokenHash, hashSecret(token))).get();
  if (!row) throw new HttpError(401, "invalid_mcp_token");
  const identity = assertConnection(db, row.id, "read", now,hashSecret(token));
  if (row.lastUsed === null || now - row.lastUsed >= 60_000) writeTx(db, (tx) => {
    assertConnection(tx, row.id, "read", now,hashSecret(token));
    tx.update(mcpConnection).set({ lastUsedAtMs: now }).where(eq(mcpConnection.id, row.id)).run();
  });
  return identity;
}
