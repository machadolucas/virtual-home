/**
 * Better Auth 1.7.3 tables — GIVEN, not designed here. Do not hand-tune the column set.
 *
 * Derived from `getSchema()` of the exact options in `src/server/auth/auth.ts` (email+password,
 * `username()` and `admin()` plugins, `rateLimit.storage = 'database'` with `modelName: 'rateLimit'`,
 * `user.additionalFields.displayColor`, `advanced.database.generateId = 'uuid'`) and cross-checked
 * against the schema the Better Auth CLI generates for the Drizzle sqlite provider.
 *
 * Two rules keep this file compatible with the adapter:
 *  1. **Export names are model names.** `@better-auth/drizzle-adapter` addresses tables as
 *     `schema[model]` and columns as `table[field]` — by the *JavaScript* keys, never by SQL names.
 *     So `user`/`session`/`account`/`verification`/`rateLimit` and the camelCase property names
 *     below are load-bearing; the SQL names are not, and are kept camelCase to match what the
 *     library's own generator produces (the only place in this database that is not snake_case).
 *  2. **These five tables are the one exception to the epoch-ms rule** in CLAUDE.md: the adapter
 *     hands the driver `Date` objects, so their instants use `integer(..., { mode: 'timestamp_ms' })`.
 *     Domain tables use plain `integer('*_ms')` numbers. Never copy this pattern outside this file.
 *
 * On a Better Auth upgrade: regenerate (`pnpm dlx @better-auth/cli generate`) and diff, rather than
 * editing by hand.
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** `DEFAULT (cast(unixepoch('subsecond') * 1000 as integer))` — a fresh SQL node per column. */
const nowDefault = () => sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowDefault()),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
    .notNull()
    .default(nowDefault())
    .$onUpdate(() => new Date()),
  // username plugin
  username: text("username").unique(),
  displayUsername: text("displayUsername"),
  // admin plugin
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("banReason"),
  banExpires: integer("banExpires", { mode: "timestamp_ms" }),
  // user.additionalFields
  displayColor: text("displayColor"),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowDefault()),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
      .notNull()
      .$onUpdate(() => new Date()),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // admin plugin
    impersonatedBy: text("impersonatedBy"),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowDefault()),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull().default(nowDefault()),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" })
      .notNull()
      .default(nowDefault())
      .$onUpdate(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Database-backed rate limit store (`rateLimit.storage = 'database'`). `lastRequest` is epoch
 * milliseconds written by the library as a plain number, not a Date.
 */
export const rateLimit = sqliteTable("rateLimit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("lastRequest").notNull(),
});
