/**
 * Server-side package handling: fingerprint stability, path-traversal safety and install.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `server-only` is a build-time guard for the Next bundler; under Vitest its client entry throws.
vi.mock("server-only", () => ({}));

import { loadEnv, parseEnv, setEnvForTests } from "@/env";
import {
  assetPath,
  computeFingerprint,
  fingerprintFromEntries,
  getCurrentPackage,
  installPackage,
  invalidatePackageCache,
  ModelPackageError,
  packageStatus,
  readManifest,
  safeAssetRelPath,
  safeJoin,
} from "@/server/house-model/package";
import { FIXTURE_DIR } from "./glb";

function withDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-model-"));
  setEnvForTests(
    parseEnv(
      {
        NODE_ENV: "test",
        VH_DATA_DIR: dir,
        VH_BASE_URL: "http://localhost:3010",
        BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
        LOG_LEVEL: "fatal",
      },
      "test",
    ),
  );
  invalidatePackageCache();
  return dir;
}

let dataDir = "";

beforeEach(() => {
  dataDir = withDataDir();
});

afterEach(() => {
  invalidatePackageCache();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("computeFingerprint", () => {
  it("is stable across repeated runs and across a byte-identical copy", async () => {
    const a = await computeFingerprint(FIXTURE_DIR);
    const b = await computeFingerprint(FIXTURE_DIR);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);

    const copy = path.join(dataDir, "copy");
    fs.cpSync(FIXTURE_DIR, copy, { recursive: true });
    expect(await computeFingerprint(copy)).toBe(a);
  });

  it("changes when any packaged byte changes, and comes back when it is restored", async () => {
    const copy = path.join(dataDir, "copy");
    fs.cpSync(FIXTURE_DIR, copy, { recursive: true });
    const before = await computeFingerprint(copy);
    const manifestFile = path.join(copy, "model.json");
    const original = fs.readFileSync(manifestFile);
    fs.writeFileSync(manifestFile, original.toString().replace("Fixture house", "Fixture houze"));
    expect(await computeFingerprint(copy)).not.toBe(before);
    fs.writeFileSync(manifestFile, original);
    expect(await computeFingerprint(copy)).toBe(before);
  });

  it("changes when an asset is added or removed", async () => {
    const copy = path.join(dataDir, "copy");
    fs.cpSync(FIXTURE_DIR, copy, { recursive: true });
    const before = await computeFingerprint(copy);
    const extra = path.join(copy, "assets", "extra.glb");
    fs.writeFileSync(extra, Buffer.from([1, 2, 3, 4]));
    expect(await computeFingerprint(copy)).not.toBe(before);
    fs.rmSync(extra);
    expect(await computeFingerprint(copy)).toBe(before);
  });

  it("does not depend on directory listing order", () => {
    const entries = [
      { path: "assets/b.glb", bytes: 2, sha256: "bb" },
      { path: "model.json", bytes: 1, sha256: "aa" },
      { path: "assets/a.glb", bytes: 3, sha256: "cc" },
    ];
    const forward = fingerprintFromEntries(entries);
    const backward = fingerprintFromEntries([...entries].reverse());
    expect(forward).toBe(backward);
  });

  it("rejects an empty directory", async () => {
    const empty = path.join(dataDir, "empty");
    fs.mkdirSync(empty, { recursive: true });
    await expect(computeFingerprint(empty)).rejects.toBeInstanceOf(ModelPackageError);
  });
});

describe("safeAssetRelPath", () => {
  it("accepts a plain assets/<name>.glb", () => {
    expect(safeAssetRelPath("assets/house-ground.glb")).toBe("assets/house-ground.glb");
    expect(safeAssetRelPath("assets/a_b.1-2.glb")).toBe("assets/a_b.1-2.glb");
  });

  it.each([
    ["", "empty"],
    ["assets/../model.json", "parent traversal"],
    ["../assets/x.glb", "leading traversal"],
    ["assets/..%2fmodel.json", "encoded traversal"],
    ["/etc/passwd", "absolute"],
    ["/assets/x.glb", "absolute assets"],
    ["C:/assets/x.glb", "windows drive"],
    ["assets/sub/x.glb", "nested"],
    ["assets/x.glb\0.png", "NUL"],
    ["assets\\x.glb", "backslash separator"],
    ["assets/.hidden.glb", "dotfile"],
    ["assets/x.gltf", "wrong extension"],
    ["assets/x.glb.exe", "double extension"],
    ["model.json", "not under assets"],
    ["assets/", "no file name"],
    ["assets/.", "dot"],
    ["assets/..", "dotdot"],
    ["ASSETS/x.glb", "wrong directory case"],
  ])("rejects %s (%s)", (input) => {
    expect(() => safeAssetRelPath(input)).toThrow(ModelPackageError);
  });
});

describe("safeJoin", () => {
  let pkgDir = "";
  beforeEach(() => {
    pkgDir = path.join(dataDir, "pkg");
    fs.mkdirSync(path.join(pkgDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "assets", "ok.glb"), "x");
    fs.writeFileSync(path.join(dataDir, "outside.glb"), "secret");
  });

  it("resolves a real file inside the package", async () => {
    await expect(safeJoin(pkgDir, "assets/ok.glb")).resolves.toBe(
      path.join(pkgDir, "assets", "ok.glb"),
    );
  });

  it("refuses traversal even when the target exists", async () => {
    await expect(safeJoin(pkgDir, "assets/../../outside.glb")).rejects.toBeInstanceOf(
      ModelPackageError,
    );
  });

  it("refuses a symlinked file", async () => {
    fs.symlinkSync(path.join(dataDir, "outside.glb"), path.join(pkgDir, "assets", "link.glb"));
    await expect(safeJoin(pkgDir, "assets/link.glb")).rejects.toThrow(/symlink/);
  });

  it("refuses a symlinked assets directory", async () => {
    const other = path.join(dataDir, "other");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "ok.glb"), "x");
    const linked = path.join(dataDir, "linked-pkg");
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(other, path.join(linked, "assets"));
    await expect(safeJoin(linked, "assets/ok.glb")).rejects.toThrow(/symlink/);
  });

  it("reports a missing file as not_found, not as unsafe", async () => {
    await expect(safeJoin(pkgDir, "assets/nope.glb")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("installPackage / getCurrentPackage", () => {
  it("installs into <modelDir>/<fingerprint>, writes a lock and points current.json at it", async () => {
    const result = await installPackage(FIXTURE_DIR);
    expect(result.modelId).toBe("fixture-house");
    expect(result.fingerprint).toBe(await computeFingerprint(FIXTURE_DIR));
    expect(result.dir).toBe(path.join(loadEnv().modelDir, result.fingerprint));

    const lock = JSON.parse(
      fs.readFileSync(path.join(result.dir, "package.lock.json"), "utf8"),
    ) as { fingerprint: string; files: Array<{ path: string; sha256: string }> };
    expect(lock.fingerprint).toBe(result.fingerprint);
    expect(lock.files.length).toBe(7); // model.json + manifest.schema.json + 5 assets
    for (const f of lock.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);

    const pointer = JSON.parse(
      fs.readFileSync(path.join(loadEnv().modelDir, "current.json"), "utf8"),
    ) as { modelId: string; fingerprint: string };
    expect(pointer).toEqual({ modelId: "fixture-house", fingerprint: result.fingerprint });

    // the installed copy has the same fingerprint as the source
    expect(await computeFingerprint(result.dir)).toBe(result.fingerprint);
  });

  it("is idempotent", async () => {
    const first = await installPackage(FIXTURE_DIR);
    const second = await installPackage(FIXTURE_DIR);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.alreadyInstalled).toBe(true);
  });

  it("leaves no temp directory behind", async () => {
    await installPackage(FIXTURE_DIR);
    const left = fs.readdirSync(loadEnv().modelDir).filter((n) => n.startsWith(".tmp-"));
    expect(left).toEqual([]);
  });

  it("serves the manifest and the asset allow-list after install", async () => {
    const { fingerprint } = await installPackage(FIXTURE_DIR);
    const pkg = await getCurrentPackage();
    expect(pkg?.fingerprint).toBe(fingerprint);
    expect(pkg?.modelId).toBe("fixture-house");
    expect([...(pkg?.assetFiles.keys() ?? [])].sort()).toEqual([
      "fixture-lower",
      "fixture-roof",
      "fixture-scan",
      "fixture-terrain",
      "fixture-upper",
    ]);
    expect((await readManifest())?.surfaces.length).toBe(30);
    await expect(assetPath("fixture-lower")).resolves.toContain(
      path.join(fingerprint, "assets", "fixture-lower.glb"),
    );
    await expect(assetPath("../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
    await expect(assetPath("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports the setup state when nothing is installed", async () => {
    const status = await packageStatus();
    expect(status.installed).toBe(false);
    expect(status.assets).toEqual([]);
    expect(await getCurrentPackage()).toBeNull();
  });

  it("reports per-asset presence and the package's own issues", async () => {
    await installPackage(FIXTURE_DIR);
    const status = await packageStatus();
    expect(status.installed).toBe(true);
    expect(status.schemaVersion).toBe("1.0");
    expect(status.assets.every((a) => a.present)).toBe(true);
    expect(status.assets.every((a) => (a.bytes ?? 0) > 0)).toBe(true);
    expect(status.issues.map((i) => i.id)).toEqual(["iss-fx-01", "iss-fx-02"]);
    expect(status.diagnostics.some((d) => d.severity === "error")).toBe(false);
  });

  it("flags a missing default asset once it disappears from an installed package", async () => {
    const result = await installPackage(FIXTURE_DIR);
    fs.rmSync(path.join(result.dir, "assets", "fixture-upper.glb"));
    invalidatePackageCache();
    const status = await packageStatus();
    expect(status.assets.find((a) => a.id === "fixture-upper")?.present).toBe(false);
    expect(status.diagnostics.some((d) => d.code === "E_ASSET_MISSING")).toBe(true);
  });

  it("refuses to install a package whose manifest fails validation", async () => {
    const broken = path.join(dataDir, "broken");
    fs.cpSync(FIXTURE_DIR, broken, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(broken, "model.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete manifest.rooms;
    fs.writeFileSync(path.join(broken, "model.json"), JSON.stringify(manifest));
    await expect(installPackage(broken)).rejects.toMatchObject({ code: "manifest_invalid" });
  });

  it("refuses to install a package with a dangling reference", async () => {
    const broken = path.join(dataDir, "dangling");
    fs.cpSync(FIXTURE_DIR, broken, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(broken, "model.json"), "utf8")) as {
      rooms: Array<{ floorId: string }>;
    };
    manifest.rooms[0]!.floorId = "f-nope";
    fs.writeFileSync(path.join(broken, "model.json"), JSON.stringify(manifest));
    await expect(installPackage(broken)).rejects.toMatchObject({ code: "invalid_package" });
  });

  it("re-reads current.json after a swap", async () => {
    const first = await installPackage(FIXTURE_DIR);
    const variant = path.join(dataDir, "variant");
    fs.cpSync(FIXTURE_DIR, variant, { recursive: true });
    const file = path.join(variant, "model.json");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Fixture house", "Fixture home"));
    const second = await installPackage(variant);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    const pkg = await getCurrentPackage();
    expect(pkg?.fingerprint).toBe(second.fingerprint);
    expect(pkg?.manifest.name).toBe("Fixture home");
  });
});
