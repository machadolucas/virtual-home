import { getSchema } from "better-auth/db";
import { admin, username } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth";

const options = {
  appName: "virtual-home",
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: true, storage: "database", modelName: "rateLimit" },
  advanced: { database: { generateId: "uuid" } },
  user: { additionalFields: { displayColor: { type: "string", required: false, input: false } } },
  plugins: [username({ minUsernameLength: 3, maxUsernameLength: 30 }), admin()],
} as unknown as BetterAuthOptions;

const schema = getSchema(options);
console.log(JSON.stringify(schema, (_k, v) => (typeof v === "function" ? "[fn]" : v), 2));
