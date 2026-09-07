/**
 * Global Vitest setup: a deterministic environment so tests never read the developer's real
 * configuration or touch the real data directory.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parseEnv, setEnvForTests } from "@/env";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-test-"));
setEnvForTests(
  parseEnv(
    {
      NODE_ENV: "test",
      VH_DATA_DIR: dataDir,
      VH_BASE_URL: "http://localhost:3010",
      VH_HOUSEHOLD_TZ: "Europe/Helsinki",
      VH_DELIVERY_TIME: "09:00",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
      LOG_LEVEL: "fatal",
      HA_URL: "http://ha.test:8123",
      HA_TOKEN: "test-token-test-token-test-token",
    },
    "test",
  ),
);
