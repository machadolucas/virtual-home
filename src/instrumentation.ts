/** Runs once when the Next.js server starts: validate configuration before serving anything. */
export async function register() {
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadEnv, exitOnEnvError } = await import("@/env");
  try {
    const env = loadEnv("web");
    const { log } = await import("@/server/log");
    log.info({ port: env.PORT, host: env.HOST, baseUrl: env.VH_BASE_URL, dataDir: env.VH_DATA_DIR }, "web starting");
  } catch (err) {
    exitOnEnvError(err);
  }
}
