/**
 * A stand-in for launchd, so the shell side of the launchd modes (`scripts/lib/launchd.sh`, the
 * `run-*.sh` wrappers, `services.sh`, `restore.sh --force`) can run for real in a test without
 * touching the machine's actual launchd jobs.
 *
 *  - `bin/launchctl` answers `print <target>` from state files (loaded marker, pid) and logs every
 *    call; anything else is logged and succeeds. It is first on the scripts' `PATH`, so no real
 *    `launchctl` is ever reached.
 *  - `supervise(domain, role)` emulates a `KeepAlive=true` job: it runs the repo's real wrapper in a
 *    loop and publishes the current child's pid (which the wrapper's `exec` hands to "node").
 *  - The wrappers' `node` is a shim: `-p`/`-v` answer a version check, anything else execs the real
 *    Node running a tiny server — the web one answers `/api/health`, both exit 0 on SIGTERM.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO_ROOT = path.resolve(__dirname, "../..");
export const LABEL_PREFIX = "net.machadolucas.virtual-home";

const LAUNCHCTL = `#!/bin/bash
echo "$*" >>"$FAKE_LAUNCHD_DIR/calls.log"
case "$1" in
  print)
    f="$FAKE_LAUNCHD_DIR/state/$(printf '%s' "$2" | tr '/' '_')"
    [ -f "$f.loaded" ] || { echo "Could not find service \\"$2\\"" >&2; exit 113; }
    printf '%s = {\\n\\tstate = running\\n' "$2"
    if [ -f "$f.pid" ] && kill -0 "$(cat "$f.pid")" 2>/dev/null; then printf '\\tpid = %s\\n' "$(cat "$f.pid")"; fi
    printf '\\tusername = %s\\n}\\n' "$(id -un)"
    ;;
esac
exit 0
`;

const SUPERVISOR = `#!/bin/bash
# $1 = state file prefix, $2 = wrapper. KeepAlive=true: relaunch whatever exits.
touch "$1.loaded"
while [ ! -e "$FAKE_LAUNCHD_DIR/stop" ]; do
  /bin/bash "$2" >>"$1.out" 2>&1 &
  echo $! >"$1.pid"
  wait $! || true
  sleep 0.2
done
`;

const NODE_SHIM = `#!/bin/bash
case "$1" in -p) echo 26; exit 0;; -v) echo v26.0.0; exit 0;; esac
exec "$REAL_NODE" "$FAKE_SERVER_JS" "$@"
`;

const SERVER_JS = `
const http = require("node:http");
const args = process.argv.slice(2);
const i = args.indexOf("--port");
let server = null;
if (args.includes("start") && i >= 0) {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === "/api/health" ? 200 : 404, { "content-type": "application/json" });
    res.end('{"status":"ok"}');
  });
  server.listen(Number(args[i + 1]), "127.0.0.1");
} else {
  setInterval(() => {}, 60_000);
}
process.on("SIGTERM", () => { if (server) server.close(); process.exit(0); });
`;

export interface FakeLaunchd {
  root: string;
  dataDir: string;
  port: number;
  /** Environment for any script under test: fake launchctl first on PATH, the throwaway data dir. */
  env: NodeJS.ProcessEnv;
  supervise(domain: "gui" | "system", role: "web" | "worker"): void;
  /** The pid the fake launchctl reports for a job, or null. */
  launchdPid(domain: "gui" | "system", role: string): number | null;
  pidfile(role: string): number | null;
  alive(pid: number | null): boolean;
  calls(): string[];
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  cleanup(): void;
}

export function targetOf(domain: "gui" | "system", role: string): string {
  return domain === "system"
    ? `system/${LABEL_PREFIX}.${role}`
    : `gui/${process.getuid?.() ?? 0}/${LABEL_PREFIX}.${role}`;
}

/** A free TCP port, picked by asking the OS for one. */
export function freePort(): number {
  const out = spawnSync(
    process.execPath,
    ["-e", "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"],
    { encoding: "utf8" },
  );
  return Number(out.stdout.trim());
}

export function createFakeLaunchd(opts: { domain?: "gui" | "system"; extraEnv?: string[] } = {}): FakeLaunchd {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-launchd-"));
  const bin = path.join(root, "bin");
  const nodeDir = path.join(root, "node-bin");
  const appDir = path.join(root, "app");
  const dataDir = path.join(root, "data");
  for (const dir of [bin, nodeDir, appDir, path.join(root, "state"), path.join(dataDir, "secrets"), path.join(dataDir, "logs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.chmodSync(dataDir, 0o700);
  fs.writeFileSync(path.join(bin, "launchctl"), LAUNCHCTL, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "supervise.sh"), SUPERVISOR, { mode: 0o755 });
  fs.writeFileSync(path.join(nodeDir, "node"), NODE_SHIM, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "server.js"), SERVER_JS);
  const port = freePort();
  fs.writeFileSync(
    path.join(dataDir, "secrets", "vh.env"),
    [
      "NODE_ENV=production",
      `VH_DATA_DIR=${dataDir}`,
      `PORT=${port}`,
      `VH_NODE_DIR=${nodeDir}`,
      ...(opts.domain ? [`VH_LAUNCHD_DOMAIN=${opts.domain}`] : []),
      ...(opts.extraEnv ?? []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    VH_DATA_DIR: dataDir,
    VH_APP_DIR: appDir,
    VH_HOLD_POLL_S: "0.2",
    VH_START_TIMEOUT_S: "30",
    FAKE_LAUNCHD_DIR: root,
    REAL_NODE: process.execPath,
    FAKE_SERVER_JS: path.join(root, "server.js"),
  };
  // Never inherit a mode from the developer's shell: the file decides unless a test says otherwise.
  delete env.VH_LAUNCHD_DOMAIN;

  const children: ChildProcess[] = [];
  const stateFile = (domain: "gui" | "system", role: string): string =>
    path.join(root, "state", targetOf(domain, role).replaceAll("/", "_"));
  const readPid = (file: string): number | null => {
    try {
      const n = Number(fs.readFileSync(file, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };
  const alive = (pid: number | null): boolean => {
    if (pid === null) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    root,
    dataDir,
    port,
    env,
    supervise(domain, role) {
      const child = spawn(
        "/bin/bash",
        [path.join(root, "supervise.sh"), stateFile(domain, role), path.join(REPO_ROOT, "scripts/launchd", `run-${role}.sh`)],
        { env, detached: true, stdio: "ignore" },
      );
      children.push(child);
    },
    launchdPid(domain, role) {
      const pid = readPid(`${stateFile(domain, role)}.pid`);
      return alive(pid) ? pid : null;
    },
    pidfile(role) {
      return readPid(path.join(dataDir, "run", `${role}.pid`));
    },
    alive,
    calls() {
      try {
        return fs.readFileSync(path.join(root, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    async waitFor(predicate, timeoutMs = 15_000) {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    cleanup() {
      fs.writeFileSync(path.join(root, "stop"), "");
      fs.rmSync(path.join(dataDir, "run", "hold"), { force: true });
      for (const child of children) {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      // The supervised wrappers run in the supervisor's process group, so they went with it.
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
