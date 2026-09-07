import { defineConfig } from "drizzle-kit";

// drizzle-kit only needs the schema to GENERATE migrations; applying them is done by
// `src/db/migrate.ts` (so we control pre-migration backups and pragmas).
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.VH_DB_PATH ?? "./.local/dev.db" },
  strict: true,
  verbose: true,
});
