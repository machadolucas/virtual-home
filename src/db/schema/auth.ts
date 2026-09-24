/**
 * Better Auth 1.7.5 tables — GIVEN, not designed here. Do not hand-tune the column set.
 *
 * Derived from `getSchema()` of the exact options in `src/server/auth/auth.ts` (email+password,
 * `username()`, `admin()` and `passkey()` plugins, `rateLimit.storage = 'database'` with
 * `modelName: 'rateLimit'`, `user.additionalFields.displayColor`,
 * `advanced.database.generateId = 'uuid'`) and cross-checked against the schema the Better Auth
 * CLI generates for the Drizzle sqlite provider.
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
 * On a Better Auth upgrade: regenerate and diff, rather than editing by hand. The CLI moved from
 * `@better-auth/cli` (last release 1.4.x) to the `auth` package, pinned to the same version as
 * `better-auth`: `pnpm dlx auth@<version> generate --config <file> --output <file>` against a
 * throwaway config that mirrors `buildAuthOptions()` (the real module imports `server-only`).
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
 * WebAuthn credentials (`@better-auth/passkey`). One row per registered passkey; deleting the user
 * cascades. `publicKey` is the COSE public key (base64) — not a secret, but never shown in the UI.
 * `credentialID` is indexed rather than unique because that is what the plugin's schema declares.
 * `createdAt` has no SQL default because the plugin's schema gives it none and always writes it.
 */
export const passkey = sqliteTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("publicKey").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credentialID").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("deviceType").notNull(),
    backedUp: integer("backedUp", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("passkey_userId_idx").on(t.userId),
    index("passkey_credentialID_idx").on(t.credentialID),
  ],
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
