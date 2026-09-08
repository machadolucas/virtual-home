/**
 * Make `import "server-only"` a no-op for genuinely server-side Node processes.
 *
 * Why this exists: `src/server/**` guards itself with `import "server-only"`, whose default entry
 * *throws by design* — the package only resolves to an empty module under Node's `react-server`
 * condition, which Next sets for server components. The recovery CLI and the e2e bootstrap are
 * about as server-side as code gets, but they run under plain `tsx`, so that import would abort
 * them before the first line of work.
 *
 * `tsx` compiles to CommonJS here, so `import "server-only"` becomes `require("server-only")` and
 * pre-seeding the module cache with an empty module satisfies the guard without touching the
 * package or the app code. **Import this module first, before anything under `@/server`.**
 *
 * The tidier alternative, if `package.json` and `playwright.config.ts` may be edited, is to pass
 * Node's own flag instead and delete this file: `tsx --conditions=react-server …`.
 */
import Module from "node:module";

export function allowServerOnlyImports(): void {
  // ESM output (no `require`): nothing to seed. The `--conditions=react-server` flag is then the
  // only fix, and the thrown error from `server-only` says so clearly enough.
  if (typeof require === "undefined") return;
  let resolved: string;
  try {
    resolved = require.resolve("server-only");
  } catch {
    return; // not installed: the guard is not in the way either
  }
  if (require.cache[resolved]) return;
  const stub = new Module(resolved, undefined);
  stub.filename = resolved;
  stub.loaded = true;
  stub.exports = {};
  require.cache[resolved] = stub;
}

allowServerOnlyImports();
