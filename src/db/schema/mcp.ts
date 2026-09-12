import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./auth";

/** Only a SHA-256 digest is stored; the bearer secret is shown once on creation. */
export const mcpConnection = sqliteTable("mcp_connection", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  scopesJson: text("scopes_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  revokedAtMs: integer("revoked_at_ms"),
  lastUsedAtMs: integer("last_used_at_ms"),
}, (t) => [uniqueIndex("ux_mcp_connection_hash").on(t.tokenHash), index("ix_mcp_connection_user").on(t.userId)]);

/** Mutation and its replay record commit together. Payload/operation are bound to each key. */
export const mcpMutation = sqliteTable("mcp_mutation", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull().references(() => mcpConnection.id, { onDelete: "restrict" }),
  requestKey: text("request_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  resultJson: text("result_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
}, (t) => [uniqueIndex("ux_mcp_mutation_request").on(t.connectionId, t.requestKey)]);

/** Immutable requested payload; only browser authorization can move pending to an outcome. */
export const mcpRequest = sqliteTable("mcp_request", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id").notNull().references(() => mcpConnection.id, { onDelete: "restrict" }),
  operation: text("operation").notNull(),
  payloadJson: text("payload_json").notNull(),
  summary: text("summary").notNull(),
  state: text("state").$type<"pending" | "approved" | "rejected" | "expired" | "failed">().notNull().default("pending"),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  decidedAtMs: integer("decided_at_ms"),
  decidedBy: text("decided_by").references(() => user.id, { onDelete: "restrict" }),
  resultJson: text("result_json"),
}, (t) => [index("ix_mcp_request_state").on(t.state, t.createdAtMs)]);
