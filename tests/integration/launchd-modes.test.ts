/**
 * The two launchd modes (`scripts/lib/launchd.sh`): per-user LaunchAgents (`gui`, the default) and
 * LaunchDaemons that run as the app user (`system`, which survives the end of the login session).
 *
 * Like the backup round trip, this runs the real shell — the wrappers, the library, `services.sh`
 * and `install-macmini.sh --plists-only` — because that is where the failures live. launchd itself
 * is replaced by `tests/helpers/fakeLaunchd.ts` (a fake `launchctl` and a KeepAlive loop), so no
 * test ever reaches the machine's real jobs.
 *
 * What is asserted:
 *  - the mode comes from `VH_LAUNCHD_DOMAIN`, defaults to gui, and anything else is a config error;
 *  - gui plists render exactly as before; system plists gain UserName/GroupName/HOME/USER/LOGNAME
 *    and KeepAlive=true for web and worker, while backup keeps its calendar schedule;
 *  - the installer in system mode only stages plists and prints sudo lines — it never bootstraps;
 *  - a wrapper waits while the hold file exists and writes its pidfile only when it starts node;
 *  - hold → stop by pid → release brings both services back on new pids, web healthy;
 *  - `services.sh restart` restarts by pid in system mode and refuses while held.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeLaunchd, LABEL_PREFIX, REPO_ROOT, type FakeLaunchd } from "../helpers/fakeLaunchd";

const LIB = path.join(REPO_ROOT, "scripts/lib/launchd.sh");
const darwin = process.platform === "darwin";

function sh(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const result = spawnSync("/bin/bash", ["-c", script, "bash", ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const lib = (body: string, env: NodeJS.ProcessEnv, args: string[] = []) =>
  sh(`set -euo pipefail; . "${LIB}"; ${body}`, env, args);

function plistJson(file: string): Record<string, unknown> {
  const out = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

let fake: FakeLaunchd | null = null;
afterEach(() => {
  fake?.cleanup();
  fake = null;
});

describe.skipIf(!darwin)("launchd modes", () => {
  describe("vh_resolve_domain", () => {
    it("defaults to gui, reads the env file without sourcing it, and lets the environment win", () => {
      fake = createFakeLaunchd();
      const file = path.join(fake.root, "vh.env");
      fs.writeFileSync(file, "PORT=3010\n");
      expect(lib(`vh_resolve_domain "$1"`, fake.env, [file]).stdout.trim()).toBe("gui");
      expect(lib("vh_resolve_domain", fake.env).stdout.trim()).toBe("gui");

      fs.writeFileSync(file, "VH_LAUNCHD_DOMAIN=gui\nVH_LAUNCHD_DOMAIN=\"system\"   # after the cutover\n");
      expect(lib(`vh_resolve_domain "$1"`, fake.env, [file]).stdout.trim()).toBe("system");
      expect(lib(`vh_resolve_domain "$1"`, { ...fake.env, VH_LAUNCHD_DOMAIN: "gui" }, [file]).stdout.trim()).toBe("gui");
    });

    it("refuses anything but gui or system with the config-error status", () => {
      fake = createFakeLaunchd();
      const result = lib("vh_resolve_domain", { ...fake.env, VH_LAUNCHD_DOMAIN: "user" });
      expect(result.status).toBe(78);
      expect(result.stderr).toContain("must be 'gui' or 'system'");
    });
  });

  describe("plist rendering", () => {
    const render = (domain: string, job: string, dest: string, env: NodeJS.ProcessEnv) =>
      lib(`vh_render_plist "$1" "$2" /opt/app /opt/data "$3" "$4"`, env, [
        path.join(REPO_ROOT, "scripts/launchd", `${LABEL_PREFIX}.${job}.plist`),
        dest,
        domain,
        job,
      ]);

    it("renders gui plists exactly as the plain template substitution did", () => {
      fake = createFakeLaunchd();
      for (const job of ["web", "worker", "backup"]) {
        const dest = path.join(fake.root, `${job}.plist`);
        expect(render("gui", job, dest, fake.env).status).toBe(0);
        const template = fs.readFileSync(path.join(REPO_ROOT, "scripts/launchd", `${LABEL_PREFIX}.${job}.plist`), "utf8");
        expect(fs.readFileSync(dest, "utf8")).toBe(
          template.replaceAll("__APP_DIR__", "/opt/app").replaceAll("__DATA_DIR__", "/opt/data"),
        );
      }
    });

    it("renders system plists that run as the current user and always relaunch web and worker", () => {
      fake = createFakeLaunchd();
      const home = path.join(fake.root, "home");
      const user = os.userInfo().username;
      for (const job of ["web", "worker", "backup"]) {
        const dest = path.join(fake.root, `${job}.plist`);
        expect(render("system", job, dest, { ...fake.env, HOME: home }).status).toBe(0);
        const plist = plistJson(dest);
        expect(plist["Label"]).toBe(`${LABEL_PREFIX}.${job}`);
        expect(plist["UserName"]).toBe(user);
        expect(plist["GroupName"]).toBe(spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim());
        const env = plist["EnvironmentVariables"] as Record<string, string>;
        expect(env).toMatchObject({ HOME: home, USER: user, LOGNAME: user, VH_DATA_DIR: "/opt/data" });
        expect(fs.readFileSync(dest, "utf8")).toContain("<!DOCTYPE plist");
        if (job === "backup") {
          expect(plist["KeepAlive"]).toBeUndefined();
          expect(plist["StartCalendarInterval"]).toEqual({ Hour: 3, Minute: 30 });
        } else {
          expect(plist["KeepAlive"]).toBe(true);
          expect(plist["ProgramArguments"]).toEqual(["/bin/bash", `/opt/app/scripts/launchd/run-${job}.sh`]);
        }
      }
    });
  });

  it("install-macmini.sh --plists-only --domain system stages the daemons and never bootstraps", () => {
    fake = createFakeLaunchd({ extraEnv: ["HA_TOKEN="] });
    const home = path.join(fake.root, "home");
    fs.mkdirSync(home);
    const result = spawnSync("/bin/bash", [path.join(REPO_ROOT, "scripts/install-macmini.sh"), "--plists-only", "--domain", "system"], {
      cwd: REPO_ROOT,
      env: { ...fake.env, HOME: home },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const stage = path.join(fake.dataDir, "launchd-staged");
    expect(fs.statSync(stage).mode & 0o777).toBe(0o700);
    for (const job of ["web", "worker", "backup"]) {
      const label = `${LABEL_PREFIX}.${job}`;
      expect(plistJson(path.join(stage, `${label}.plist`))["UserName"]).toBe(os.userInfo().username);
      expect(result.stdout).toContain(`sudo install -o root -g wheel -m 600 ${path.join(stage, `${label}.plist`)} /Library/LaunchDaemons/${label}.plist`);
      expect(result.stdout).toContain(`sudo launchctl bootstrap system /Library/LaunchDaemons/${label}.plist`);
    }
    // Only read-only calls reached launchctl, and nothing was written under ~/Library.
    expect(fake.calls().every((call) => call.startsWith("print "))).toBe(true);
    expect(fs.existsSync(path.join(home, "Library"))).toBe(false);
  });

  it("a wrapper waits on the hold file and writes its pidfile only when it starts node", async () => {
    fake = createFakeLaunchd({ domain: "system" });
    fs.mkdirSync(path.join(fake.dataDir, "run"));
    fs.writeFileSync(path.join(fake.dataDir, "run", "hold"), "");
    fake.supervise("system", "worker");
    const f = fake;
    await f.waitFor(() => f.launchdPid("system", "worker") !== null);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(f.pidfile("worker")).toBeNull();
    const heldPid = f.launchdPid("system", "worker");
    expect(heldPid).not.toBeNull();

    fs.rmSync(path.join(f.dataDir, "run", "hold"));
    await f.waitFor(() => f.pidfile("worker") !== null);
    // exec keeps the pid: the process that waited is the one now running "node".
    expect(f.pidfile("worker")).toBe(heldPid);
    expect(f.alive(heldPid)).toBe(true);
    // What launchd would capture in StandardOutPath; the fake supervisor keeps it in its state dir.
    const text = fs.readFileSync(path.join(f.root, "state", `system_${LABEL_PREFIX}.worker.out`), "utf8");
    expect(text).toContain("worker: held by");
    expect(text).toContain("worker: hold released; starting");
  });

  it("hold, stop by pid, release: both services come back on new pids and web is healthy", async () => {
    fake = createFakeLaunchd({ domain: "system" });
    const f = fake;
    f.supervise("system", "web");
    f.supervise("system", "worker");
    await f.waitFor(() => f.pidfile("web") !== null && f.pidfile("worker") !== null);
    const before = { web: f.pidfile("web"), worker: f.pidfile("worker") };

    const hold = lib(`vh_hold_and_stop "$1" system worker web`, f.env, [f.dataDir]);
    expect(hold.status, hold.stderr).toBe(0);
    expect(f.alive(before.web)).toBe(false);
    expect(f.alive(before.worker)).toBe(false);
    expect(fs.existsSync(path.join(f.dataDir, "run", "hold"))).toBe(true);
    // launchd relaunched both wrappers; they wait instead of starting.
    await f.waitFor(() => f.launchdPid("system", "web") !== null && f.launchdPid("system", "worker") !== null);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(f.pidfile("web")).toBeNull();
    expect(f.pidfile("worker")).toBeNull();

    const release = lib(`vh_release_and_wait "$1" system "$2" web worker`, f.env, [f.dataDir, String(f.port)]);
    expect(release.status, `${release.stdout}\n${release.stderr}`).toBe(0);
    expect(release.stdout).toContain(`web: healthy on 127.0.0.1:${f.port}`);
    expect(fs.existsSync(path.join(f.dataDir, "run", "hold"))).toBe(false);
    for (const role of ["web", "worker"] as const) {
      const pid = f.pidfile(role);
      expect(pid).not.toBe(before[role]);
      expect(f.alive(pid)).toBe(true);
      expect(pid).toBe(f.launchdPid("system", role));
    }
  });

  it("release refuses when the daemons are not loaded, and keeps the hold", () => {
    fake = createFakeLaunchd({ domain: "system" });
    fs.mkdirSync(path.join(fake.dataDir, "run"));
    fs.writeFileSync(path.join(fake.dataDir, "run", "hold"), "");
    const result = lib(`vh_release_and_wait "$1" system 1 web worker`, fake.env, [fake.dataDir]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`system/${LABEL_PREFIX}.web is not loaded`);
    expect(fs.existsSync(path.join(fake.dataDir, "run", "hold"))).toBe(true);
  });

  it("services.sh restarts by pid in system mode and refuses while held", async () => {
    fake = createFakeLaunchd({ domain: "system" });
    const f = fake;
    f.supervise("system", "web");
    f.supervise("system", "worker");
    await f.waitFor(() => f.pidfile("web") !== null && f.pidfile("worker") !== null);
    const oldWorker = f.pidfile("worker");
    const oldWeb = f.pidfile("web");
    const services = path.join(REPO_ROOT, "scripts/services.sh");

    const restart = spawnSync("/bin/bash", [services, "restart", "worker"], { env: f.env, encoding: "utf8", timeout: 60_000 });
    expect(restart.status, restart.stderr).toBe(0);
    expect(f.pidfile("worker")).not.toBe(oldWorker);
    expect(f.alive(f.pidfile("worker"))).toBe(true);
    expect(f.pidfile("web")).toBe(oldWeb);

    const status = spawnSync("/bin/bash", [services, "status"], { env: f.env, encoding: "utf8" });
    expect(status.stdout).toContain("domain: system");
    expect(status.stdout).toContain(`system/${LABEL_PREFIX}.worker: state = running, pid = ${f.pidfile("worker")}`);

    fs.writeFileSync(path.join(f.dataDir, "run", "hold"), "");
    const refused = spawnSync("/bin/bash", [services, "restart", "web"], { env: f.env, encoding: "utf8", timeout: 60_000 });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("hold exists");
    expect(f.pidfile("web")).toBe(oldWeb);
  });

  it("services.sh uses kickstart in gui mode and refuses hold there", () => {
    fake = createFakeLaunchd();
    const services = path.join(REPO_ROOT, "scripts/services.sh");
    const restart = spawnSync("/bin/bash", [services, "restart", "worker"], { env: fake.env, encoding: "utf8" });
    expect(restart.status, restart.stderr).toBe(0);
    expect(fake.calls()).toContain(`kickstart -k gui/${process.getuid?.()}/${LABEL_PREFIX}.worker`);
    const hold = spawnSync("/bin/bash", [services, "hold"], { env: fake.env, encoding: "utf8" });
    expect(hold.status).toBe(64);
    expect(fs.existsSync(path.join(fake.dataDir, "run", "hold"))).toBe(false);
  });
});
