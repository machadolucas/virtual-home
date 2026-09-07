import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, username } from "better-auth/plugins";

const sqlite = new Database(":memory:");
const db = drizzle(sqlite);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: "database", modelName: "rateLimit" },
  advanced: { database: { generateId: "uuid" } },
  user: { additionalFields: { displayColor: { type: "string", required: false, input: false } } },
  plugins: [username(), admin()],
});
