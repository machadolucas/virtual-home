/**
 * The backup/restore round trip (`docs/design-notes/auth-security-operations.md` §10.3).
 *
 * This is the only test that proves the household could actually get its data back. It runs the
 * **real** `scripts/backup.sh` and `scripts/restore.sh` as subprocesses against a throwaway
 * `VH_DATA_DIR`, because the interesting failures live in the shell, not in TypeScript: a
 * `tar --zstd` that exits 0 while barely compressing, a `sed` that stops redacting the secret, a
 * restore that silently clobbers live data.
 *
 * What is asserted:
 *  - the archive and its `.sha256` exist, the checksum matches, and the archive is readable;
 *  - the archive is meaningfully smaller than the payload it came from (< 0.6) — the regression
 *    guard for the measured 33× `tar --zstd` trap;
 *  - `vh.env.redacted` carries `<REDACTED>` and not the secret values;
 *  - restoring into an empty directory reproduces row counts, every attachment byte-for-byte
 *    (sha256), an `ok` integrity check, an empty `foreign_key_check`, and a manifest whose schema
 *    hash is the live migration hash;
 *  - a restore over an existing database refuses to run without `--force`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabase, writeTx, type DbHandle } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newId, nowMs } from "@/db/ids";
import { attachment } from "@/db/schema";
import { seedUser } from "../helpers/db";

const REPO_ROOT = path.resolve(__dirname, "../..");
const BACKUP_SH = path.join(REPO_ROOT, "scripts/backup.sh");
const RESTORE_SH = path.join(REPO_ROOT, "scripts/restore.sh");

/** The scripts shell out to these; without them there is nothing meaningful to test. */
const REQUIRED_TOOLS = ["zstd", "sqlite3", "tar", "rsync", "shasum"] as const;

function missingTools(): string[] {
  return REQUIRED_TOOLS.filter(
    (tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status !== 0,
  );
}

const missing = missingTools();

const ATTACHMENT_COUNT = 25;
const SECRET_VALUE = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff";
const HA_TOKEN_VALUE = "ha-long-lived-token-value-not-in-any-archive";

interface Payload {
  dataDir: string;
  /** `relative path under attachments/` → sha256 of the bytes. */
  attachmentHashes: Map<string, string>;
  quarantineHashes: Map<string,string>;
  rowCounts: { users: number; attachments: number };
  schemaHash: string;
}

let payload: Payload;
let restoreDir: string;
let archive: string;
let backupStdout: string;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every regular file under `root`, keyed by its path relative to `root` (POSIX separators). */
function hashTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.set(path.relative(root, abs).split(path.sep).join("/"), sha256(abs));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function run(
  script: string,
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [script, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * A data directory that looks like a used installation: two accounts, 25 attachment rows with
 * their files on disk, a model package, and a secrets file with real-looking values.
 *
 * The attachment bodies are deliberately compressible text — the compression assertion is about
 * whether the archive is *actually compressed*, and incompressible random bytes would make the
 * check vacuous.
 */
function buildPayload(): Payload {
  const dataDir = tempDir("vh-backup-src-");
  for (const sub of ["db", "attachments", "model", "quarantine", "tmp", "backups/daily", "backups/weekly", "secrets", "logs", "exports"]) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(
    path.join(dataDir, "secrets", "vh.env"),
    [
      "NODE_ENV=production",
      `VH_DATA_DIR=${dataDir}`,
      "VH_BASE_URL=https://home.example.net",
      `BETTER_AUTH_SECRET=${SECRET_VALUE}`,
      "HA_URL=http://192.0.2.10:8123",
      `HA_TOKEN=${HA_TOKEN_VALUE}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  // A model package: content-addressed directory plus the pointer the manifest inlines.
  const fingerprint = "0123456789abcdef";
  fs.mkdirSync(path.join(dataDir, "model", fingerprint), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "model", fingerprint, "model.json"),
    JSON.stringify({ schemaVersion: "1.0", modelId: "fixture-house" }, null, 2),
  );
  fs.writeFileSync(
    path.join(dataDir, "model", "current.json"),
    JSON.stringify({ modelId: "fixture-house", fingerprint }, null, 2) + "\n",
  );
  // Orphan recovery bytes are deliberately absent from attachment rows but remain valuable data.
  const quarantined=path.join(dataDir,"quarantine","fixture-recovery","2026","09","orphan-manual.pdf");
  fs.mkdirSync(path.dirname(quarantined),{recursive:true,mode:0o700});
  fs.writeFileSync(quarantined,Buffer.from("%PDF-1.7\nSynthetic quarantined recovery bytes\x00\xff\n%%EOF\n","latin1"),{mode:0o600});
  const quarantineHashes=hashTree(path.join(dataDir,"quarantine"));

  const handle: DbHandle = openDatabase(path.join(dataDir, "db", "app.db"));
  const attachmentHashes = new Map<string, string>();
  try {
    runMigrations(handle);
    const lucas = seedUser(handle, { username: "lucas", name: "Lucas" });
    seedUser(handle, { username: "marja", name: "Marja" });

    const at = nowMs();
    for (let i = 0; i < ATTACHMENT_COUNT; i++) {
      const id = newId();
      const rel = `2026/09/${id}.jpg`;
      const abs = path.join(dataDir, "attachments", rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // ~12 KiB of repeated text per file: unique bytes, highly compressible.
      fs.writeFileSync(abs, `attachment ${i} ${"lämmitys-ohjekirja ".repeat(600)}`, { mode: 0o600 });
      const digest = sha256(abs);
      attachmentHashes.set(rel, digest);

      writeTx(handle.db, (tx) =>
        tx
          .insert(attachment)
          .values({
            id,
            kind: "photo",
            mime: "image/jpeg",
            byteSize: fs.statSync(abs).size,
            sha256: digest,
            storagePath: rel,
            originalFilename: `kuva-${i}.jpg`,
            hasWebCopy: false,
            createdAtMs: at,
            createdBy: lucas.id,
            updatedAtMs: at,
            updatedBy: lucas.id,
          })
          .run(),
      );
    }

    const schemaHash = (
      handle.sqlite
        .prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
        .get() as { hash: string }
    ).hash;

    return {
      dataDir,
      attachmentHashes,
      quarantineHashes,
      rowCounts: { users: 2, attachments: ATTACHMENT_COUNT },
      schemaHash,
    };
  } finally {
    // Closing checkpoints the WAL. `sqlite3 .backup` is WAL-safe with live writers too; the point
    // here is a deterministic starting state, not a concurrency test.
    handle.close();
  }
}

/** Row counts straight out of a restored database file, via the same sqlite3 the scripts use. */
function countRows(dbPath: string): Record<string, number> {
  const result = spawnSync(
    "sqlite3",
    [
      dbPath,
      "SELECT 'users', count(*) FROM user UNION ALL SELECT 'attachments', count(*) FROM attachment UNION ALL SELECT 'sessions', count(*) FROM session;",
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const counts: Record<string, number> = {};
  for (const line of result.stdout.trim().split("\n")) {
    const [key, value] = line.split("|");
    if (key) counts[key] = Number(value);
  }
  return counts;
}

function pragma(dbPath: string, statement: string): string {
  const result = spawnSync("sqlite3", [dbPath, statement], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/** One file out of the archive, without unpacking the rest. */
function readFromArchive(pattern: string): string {
  const result = spawnSync("bash", ["-c", `zstd -dc "${archive}" | tar -xOf - "${pattern}"`], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe.skipIf(missing.length > 0)("backup and restore round trip", () => {
  beforeAll(() => {
    payload = buildPayload();
    restoreDir = tempDir("vh-backup-dst-");
    // An empty directory is the documented restore target, so remove the one mkdtemp made.
    fs.rmdirSync(restoreDir);

    const result = run(BACKUP_SH, ["--label", "manual", "--keep-forever"], {
      VH_DATA_DIR: payload.dataDir,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    backupStdout = result.stdout;

    const dailyDir = path.join(payload.dataDir, "backups", "daily");
    const archives = fs.readdirSync(dailyDir).filter((f) => f.endsWith(".tar.zst"));
    expect(archives).toHaveLength(1);
    archive = path.join(dailyDir, archives[0]!);
  }, 180_000);

  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("backup.sh", () => {
    it("writes an archive with a matching checksum file", () => {
      expect(fs.statSync(archive).isFile()).toBe(true);
      expect(fs.statSync(archive).mode & 0o777).toBe(0o600);
      const recorded = fs.readFileSync(`${archive}.sha256`, "utf8").trim();
      expect(recorded).toMatch(/^[0-9a-f]{64}$/);
      expect(recorded).toBe(sha256(archive));
    });

    it("produces an archive that unpacks, carrying the database and the manifest", () => {
      const listing = spawnSync("bash", ["-c", `zstd -dc "${archive}" | tar -tf -`], {
        encoding: "utf8",
      });
      expect(listing.status, listing.stderr).toBe(0);
      const entries = listing.stdout.trim().split("\n");
      expect(entries.some((e) => e.endsWith("/app.db"))).toBe(true);
      expect(entries.some((e) => e.endsWith("/manifest.json"))).toBe(true);
      expect(entries.some((e) => e.endsWith("/vh.env.redacted"))).toBe(true);
      // Files only: `tar -t` lists the directory entries too.
      expect(
        entries.filter((e) => e.includes("/attachments/2026/09/") && !e.endsWith("/")).length,
      ).toBe(ATTACHMENT_COUNT);
      // Secrets, logs and old backups are explicitly out of scope for the payload.
      expect(entries.some((e) => e.includes("/secrets/"))).toBe(false);
      expect(entries.some((e) => e.includes("/backups/"))).toBe(false);
    });

    it("actually compresses: the archive is under 60 % of the staged payload", () => {
      // `backup.sh` prints "backup ok: <path> (N bytes from M staged)". This is the guard for the
      // measured `tar --zstd` regression, which exits 0 and produces ~no compression.
      const match = /\((\d+) bytes from (\d+) staged\)/.exec(backupStdout);
      expect(match, backupStdout).not.toBeNull();
      const outBytes = Number(match![1]);
      const stagedBytes = Number(match![2]);
      expect(outBytes).toBe(fs.statSync(archive).size);
      expect(stagedBytes).toBeGreaterThan(0);
      expect(outBytes / stagedBytes).toBeLessThan(0.6);
    });

    it("redacts the secrets instead of shipping them", () => {
      const redacted = readFromArchive("*/vh.env.redacted");
      expect(redacted).toContain("BETTER_AUTH_SECRET=<REDACTED>");
      expect(redacted).toContain("HA_TOKEN=<REDACTED>");
      expect(redacted).not.toContain(SECRET_VALUE);
      expect(redacted).not.toContain(HA_TOKEN_VALUE);
      // Non-secret configuration is kept: it is what makes the restored install bootable.
      expect(redacted).toContain("VH_BASE_URL=https://home.example.net");

      // And nothing else in the archive leaks them either.
      const grep = spawnSync(
        "bash",
        ["-c", `zstd -dc "${archive}" | grep -c "${SECRET_VALUE}" || true`],
        { encoding: "utf8" },
      );
      expect(grep.stdout.trim()).toBe("0");
    });

    it("records the run in the database, so a missing backup is detectable", () => {
      const rows = spawnSync(
        "sqlite3",
        [
          path.join(payload.dataDir, "db", "app.db"),
          "SELECT label, ok, bytes FROM backup_run ORDER BY created_at_ms DESC LIMIT 1;",
        ],
        { encoding: "utf8" },
      );
      expect(rows.status, rows.stderr).toBe(0);
      expect(rows.stdout.trim()).toBe(`manual|1|${fs.statSync(archive).size}`);
    });

    it("leaves no staging directory behind", () => {
      expect(fs.readdirSync(path.join(payload.dataDir, "tmp"))).toEqual([]);
    });
  });

  describe("restore.sh", () => {
    let restoredDb: string;

    beforeAll(() => {
      const result = run(RESTORE_SH, [archive, "--target", restoreDir], {
        VH_DATA_DIR: payload.dataDir,
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("restore complete into");
      restoredDb = path.join(restoreDir, "db", "app.db");
    }, 180_000);

    it("restores a healthy database with the same rows", () => {
      expect(pragma(restoredDb, "PRAGMA integrity_check;")).toBe("ok");
      expect(pragma(restoredDb, "PRAGMA foreign_key_check;")).toBe("");
      const counts = countRows(restoredDb);
      expect(counts["users"]).toBe(payload.rowCounts.users);
      expect(counts["attachments"]).toBe(payload.rowCounts.attachments);
    });

    it("restores every attachment byte for byte", () => {
      const restored = hashTree(path.join(restoreDir, "attachments"));
      expect(restored.size).toBe(payload.attachmentHashes.size);
      for (const [rel, digest] of payload.attachmentHashes) {
        expect(restored.get(rel), rel).toBe(digest);
      }
    });
    it("preserves every quarantined recovery file byte for byte",()=>{
      const restored=hashTree(path.join(restoreDir,"quarantine"));
      expect(restored.size).toBe(payload.quarantineHashes.size);
      for(const [relative,digest]of payload.quarantineHashes)expect(restored.get(relative),relative).toBe(digest);
    });

    it("restores the model package and its pointer", () => {
      const pointer = JSON.parse(
        fs.readFileSync(path.join(restoreDir, "model", "current.json"), "utf8"),
      ) as { modelId: string; fingerprint: string };
      expect(pointer.modelId).toBe("fixture-house");
      expect(
        fs.existsSync(path.join(restoreDir, "model", pointer.fingerprint, "model.json")),
      ).toBe(true);
    });

    it("agrees with the live schema, so a restore cannot silently predate a migration", () => {
      const manifest = JSON.parse(readFromArchive("*/manifest.json")) as {
        schemaHash: string;
        rowCounts: { users: number; attachments: number };
        label: string;
      };
      expect(manifest.schemaHash).toBe(payload.schemaHash);
      expect(manifest.rowCounts).toEqual(payload.rowCounts);
      expect(manifest.label).toBe("manual");
      expect(pragma(restoredDb, "SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1;")).toBe(
        payload.schemaHash,
      );
    });

    it("writes the secrets file without secrets, and says so", () => {
      const env = fs.readFileSync(path.join(restoreDir, "secrets", "vh.env"), "utf8");
      expect(env).toContain("BETTER_AUTH_SECRET=<REDACTED>");
      expect(env).not.toContain(SECRET_VALUE);
      expect(fs.statSync(path.join(restoreDir, "secrets", "vh.env")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(restoreDir, "secrets")).mode & 0o777).toBe(0o700);
    });

    it("refuses to overwrite an existing database without --force", () => {
      const result = run(RESTORE_SH, [archive, "--target", restoreDir], {
        VH_DATA_DIR: payload.dataDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("FATAL");
      expect(result.stderr).toContain("--force");
    });

    it("refuses an archive whose checksum does not match", () => {
      const tampered = path.join(tempDir("vh-backup-bad-"), path.basename(archive));
      fs.copyFileSync(archive, tampered);
      fs.copyFileSync(`${archive}.sha256`, `${tampered}.sha256`);
      fs.appendFileSync(tampered, "corruption");
      const target = path.join(tempDir("vh-backup-dst2-"), "restore");

      const result = run(RESTORE_SH, [tampered, "--target", target], {
        VH_DATA_DIR: payload.dataDir,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
    });
  });
});

describe.skipIf(missing.length === 0)("backup and restore round trip", () => {
  it(`is skipped: missing ${missing.join(", ")}`, () => {
    // Visible rather than silent: the round trip is the only proof a backup is restorable, so a
    // machine that cannot run it must say so. `brew install zstd` is the usual fix.
    expect(missing.length).toBeGreaterThan(0);
  });
});
