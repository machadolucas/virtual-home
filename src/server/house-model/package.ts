/**
 * Installed house-model packages on disk.
 *
 * Layout (all under `loadEnv().modelDir`):
 *
 *   <modelDir>/current.json                 { "modelId": "...", "fingerprint": "..." }
 *   <modelDir>/<fingerprint>/model.json
 *   <modelDir>/<fingerprint>/manifest.schema.json
 *   <modelDir>/<fingerprint>/assets/*.glb
 *   <modelDir>/<fingerprint>/package.lock.json
 *
 * The package is **immutable input**: nothing here ever writes inside `<fingerprint>/` after the
 * install rename. The fingerprint is content-addressed, so a package swap changes every asset URL
 * and needs no cache purge.
 */
import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadEnv } from "@/env";
import { crossCheck, hasErrors, type Diagnostic } from "@/house/model/crossref";
import { buildManifestIndex, type ManifestIndex } from "@/house/model/manifestIndex";
import { formatZodIssues, safeParseManifest } from "@/house/model/schema";
import type { Manifest } from "@/house/model/types";

export const MANIFEST_FILE = "model.json";
export const SCHEMA_FILE = "manifest.schema.json";
export const LOCK_FILE = "package.lock.json";
export const CURRENT_FILE = "current.json";
export const ASSETS_DIR = "assets";

export class ModelPackageError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ModelPackageError";
  }
}

export interface PackageFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface PackageLock {
  fingerprint: string;
  modelId: string;
  generated?: string;
  installedAt: string;
  files: PackageFileEntry[];
}

export interface CurrentPointer {
  modelId: string;
  fingerprint: string;
}

export interface CurrentPackage {
  modelId: string;
  fingerprint: string;
  dir: string;
  manifest: Manifest;
  diagnostics: Diagnostic[];
  /** assetId → absolute file path (the allow-list; nothing else is servable). */
  assetFiles: Map<string, string>;
  lock: PackageLock | null;
}

// ---------------------------------------------------------------------------
// path safety
// ---------------------------------------------------------------------------

/**
 * The only file names the asset route may ever resolve to. Rejects traversal, separators, NUL,
 * absolute paths, dotfiles and anything that is not a `.glb`.
 */
export function safeAssetRelPath(rel: string): string {
  if (typeof rel !== "string" || rel.length === 0) throw new ModelPackageError("empty path", "unsafe_path");
  if (rel.includes("\0")) throw new ModelPackageError("NUL in path", "unsafe_path");
  if (rel !== rel.normalize("NFC")) throw new ModelPackageError("non-normalised path", "unsafe_path");
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel))
    throw new ModelPackageError("absolute path", "unsafe_path");
  const parts = rel.split("/");
  if (parts.length !== 2 || parts[0] !== ASSETS_DIR)
    throw new ModelPackageError(`expected assets/<name>.glb, got ${rel}`, "unsafe_path");
  const name = parts[1] as string;
  if (name === "" || name === "." || name === "..")
    throw new ModelPackageError("invalid file name", "unsafe_path");
  if (name.startsWith(".")) throw new ModelPackageError("dotfile", "unsafe_path");
  if (/[/\\]/.test(name) || name.includes("\0"))
    throw new ModelPackageError("separator in file name", "unsafe_path");
  if (!/^[A-Za-z0-9._-]+\.glb$/.test(name))
    throw new ModelPackageError(`not an allowed .glb name: ${name}`, "unsafe_path");
  return `${ASSETS_DIR}/${name}`;
}

/**
 * Resolve `rel` under `baseDir`, asserting the result stays inside and that no component is a
 * symlink (`lstat`, so the link itself is inspected rather than its target).
 */
export async function safeJoin(baseDir: string, rel: string): Promise<string> {
  const safeRel = safeAssetRelPath(rel);
  const base = path.resolve(baseDir);
  const abs = path.resolve(base, safeRel);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (abs !== base && !abs.startsWith(withSep))
    throw new ModelPackageError(`resolved outside the package: ${rel}`, "unsafe_path");

  let cursor = base;
  for (const segment of safeRel.split("/")) {
    cursor = path.join(cursor, segment);
    const st = await fs.lstat(cursor).catch(() => null);
    if (!st) throw new ModelPackageError(`missing ${rel}`, "not_found");
    if (st.isSymbolicLink())
      throw new ModelPackageError(`symlink in package path: ${rel}`, "unsafe_path");
  }
  return abs;
}

/** Synchronous name-only validation, for the manifest allow-list built at load. */
export function assetRelPathOrNull(rel: string): string | null {
  try {
    return safeAssetRelPath(rel);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// fingerprint
// ---------------------------------------------------------------------------

async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve());
  });
  return h.digest("hex");
}

/** The files that make up a package's identity, relative and sorted. */
export async function packageFileList(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const f of [MANIFEST_FILE, SCHEMA_FILE]) {
    const st = await fs.stat(path.join(dir, f)).catch(() => null);
    if (st?.isFile()) files.push(f);
  }
  const entries = await fs.readdir(path.join(dir, ASSETS_DIR)).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.endsWith(".glb")) continue;
    if (!assetRelPathOrNull(`${ASSETS_DIR}/${name}`)) continue;
    files.push(`${ASSETS_DIR}/${name}`);
  }
  return files.sort();
}

export async function hashPackageFiles(dir: string): Promise<PackageFileEntry[]> {
  const rels = await packageFileList(dir);
  const out: PackageFileEntry[] = [];
  for (const rel of rels) {
    const abs = path.join(dir, rel);
    const st = await fs.stat(abs);
    out.push({ path: rel, bytes: st.size, sha256: await sha256File(abs) });
  }
  return out;
}

/**
 * sha256 over the sorted list of `"<relpath>:<bytes>:<sha256>"` lines, truncated to 16 hex chars.
 * Stable across machines and across a copy; changes if any byte of any packaged file changes.
 */
export async function computeFingerprint(dir: string): Promise<string> {
  const entries = await hashPackageFiles(dir);
  if (entries.length === 0)
    throw new ModelPackageError(`no package files in ${dir}`, "empty_package");
  return fingerprintFromEntries(entries);
}

export function fingerprintFromEntries(entries: readonly PackageFileEntry[]): string {
  const lines = entries.map((e) => `${e.path}:${e.bytes}:${e.sha256}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  manifest: Manifest;
  diagnostics: Diagnostic[];
}

/** zod + cross-references + on-disk asset presence. Throws only on an unusable package. */
export async function validatePackageDir(dir: string): Promise<ValidationResult> {
  const raw = await fs.readFile(path.join(dir, MANIFEST_FILE), "utf8").catch(() => {
    throw new ModelPackageError(`${MANIFEST_FILE} is missing in ${dir}`, "manifest_missing");
  });
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ModelPackageError(`${MANIFEST_FILE} is not valid JSON`, "manifest_invalid_json", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const parsed = safeParseManifest(json);
  if (!parsed.success)
    throw new ModelPackageError("manifest failed schema validation", "manifest_invalid", {
      issues: formatZodIssues(parsed.error),
    });

  const manifest = parsed.data;
  const diagnostics = crossCheck(manifest);

  for (const a of manifest.assets) {
    const rel = assetRelPathOrNull(a.path);
    if (!rel) {
      diagnostics.push({
        severity: "error",
        code: "E_ASSET_PATH",
        message: `asset ${a.id} has an unsafe path ${a.path}`,
        ids: [a.id],
      });
      continue;
    }
    const st = await fs.stat(path.join(dir, rel)).catch(() => null);
    if (!st?.isFile())
      diagnostics.push({
        severity: a.loadByDefault ? "error" : "warning",
        code: "E_ASSET_MISSING",
        message: `asset file ${a.path} is missing`,
        ids: [a.id],
      });
  }

  const known = new Set(manifest.assets.map((a) => a.path));
  for (const rel of await packageFileList(dir)) {
    if (rel.startsWith(`${ASSETS_DIR}/`) && !known.has(rel))
      diagnostics.push({
        severity: "warning",
        code: "W_EXTRA_ASSET_FILE",
        message: `${rel} is present on disk but not listed in the manifest; it is not servable`,
      });
  }

  return { manifest, diagnostics };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface InstallResult {
  fingerprint: string;
  dir: string;
  modelId: string;
  alreadyInstalled: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Validate `srcDir`, then copy it into `<modelDir>/<fingerprint>/` and point `current.json` at it.
 *
 * The copy goes to a sibling temp directory and is `rename`d into place, so a crash mid-copy can
 * never leave a half-written package that `current.json` names.
 */
export async function installPackage(srcDir: string): Promise<InstallResult> {
  const { manifest, diagnostics } = await validatePackageDir(srcDir);
  if (hasErrors(diagnostics))
    throw new ModelPackageError("package has validation errors; refusing to install", "invalid_package", {
      diagnostics: diagnostics.filter((d) => d.severity === "error"),
    });

  const entries = await hashPackageFiles(srcDir);
  const fingerprint = fingerprintFromEntries(entries);
  const modelDir = loadEnv().modelDir;
  const target = path.join(modelDir, fingerprint);
  await fs.mkdir(modelDir, { recursive: true });

  const existing = await fs.stat(path.join(target, MANIFEST_FILE)).catch(() => null);
  let alreadyInstalled = false;
  if (existing?.isFile()) {
    alreadyInstalled = true;
  } else {
    const tmp = path.join(modelDir, `.tmp-${fingerprint}-${process.pid}-${Date.now()}`);
    await fs.rm(tmp, { recursive: true, force: true });
    await fs.mkdir(path.join(tmp, ASSETS_DIR), { recursive: true });
    for (const e of entries) {
      await fs.copyFile(path.join(srcDir, e.path), path.join(tmp, e.path));
    }
    const lock: PackageLock = {
      fingerprint,
      modelId: manifest.modelId,
      generated: manifest.generated,
      installedAt: new Date().toISOString(),
      files: entries,
    };
    await fs.writeFile(path.join(tmp, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n", "utf8");
    try {
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { recursive: true, force: true });
      // A concurrent install of the same fingerprint is benign: the content is identical.
      const now = await fs.stat(path.join(target, MANIFEST_FILE)).catch(() => null);
      if (!now?.isFile()) throw err;
      alreadyInstalled = true;
    }
  }

  await writeCurrentPointer({ modelId: manifest.modelId, fingerprint });
  invalidatePackageCache();
  return { fingerprint, dir: target, modelId: manifest.modelId, alreadyInstalled, diagnostics };
}

async function writeCurrentPointer(pointer: CurrentPointer): Promise<void> {
  const modelDir = loadEnv().modelDir;
  const file = path.join(modelDir, CURRENT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(pointer, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// current package (cached)
// ---------------------------------------------------------------------------

interface CacheEntry {
  pkg: CurrentPackage;
  pointerMtimeMs: number;
  pointerSize: number;
  checkedAt: number;
}

let cache: CacheEntry | null = null;
const RECHECK_MS = 10_000;

export function invalidatePackageCache(): void {
  cache = null;
  indexCache.clear();
}

/**
 * The pure `ManifestIndex` for the installed package, cached by fingerprint.
 *
 * Route handlers need the id maps and the room footprints (to resolve which room a placement's
 * coordinates fall in). Building it walks every room's footprint, so it is memoised rather than
 * rebuilt per request; only one package is ever current, so the cache holds at most one entry.
 */
const indexCache = new Map<string, ManifestIndex>();

export function manifestIndexOf(pkg: CurrentPackage): ManifestIndex {
  const hit = indexCache.get(pkg.fingerprint);
  if (hit) return hit;
  const index = buildManifestIndex(pkg.manifest);
  indexCache.clear();
  indexCache.set(pkg.fingerprint, index);
  return index;
}

async function readCurrentPointer(): Promise<{ pointer: CurrentPointer; mtimeMs: number; size: number } | null> {
  const file = path.join(loadEnv().modelDir, CURRENT_FILE);
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  const raw = await fs.readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ModelPackageError(`${CURRENT_FILE} is not valid JSON`, "current_invalid");
  }
  const o = json as Partial<CurrentPointer>;
  if (typeof o?.modelId !== "string" || typeof o?.fingerprint !== "string")
    throw new ModelPackageError(`${CURRENT_FILE} must be { modelId, fingerprint }`, "current_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(o.modelId) || !/^[0-9a-f]{8,64}$/.test(o.fingerprint))
    throw new ModelPackageError(`${CURRENT_FILE} holds an invalid id or fingerprint`, "current_invalid");
  return { pointer: { modelId: o.modelId, fingerprint: o.fingerprint }, mtimeMs: st.mtimeMs, size: st.size };
}

/**
 * The active package, or `null` when nothing is installed (the setup state, not an error).
 * Cached in module scope; a `stat`-only re-check of `current.json` runs at most every 10 s.
 */
export async function getCurrentPackage(): Promise<CurrentPackage | null> {
  const now = Date.now();
  if (cache && now - cache.checkedAt < RECHECK_MS) return cache.pkg;

  const current = await readCurrentPointer();
  if (!current) {
    cache = null;
    return null;
  }
  if (cache && cache.pointerMtimeMs === current.mtimeMs && cache.pointerSize === current.size) {
    cache.checkedAt = now;
    return cache.pkg;
  }

  const dir = path.join(loadEnv().modelDir, current.pointer.fingerprint);
  const { manifest, diagnostics } = await validatePackageDir(dir);
  if (manifest.modelId !== current.pointer.modelId)
    throw new ModelPackageError(
      `${CURRENT_FILE} names ${current.pointer.modelId} but the package is ${manifest.modelId}`,
      "current_mismatch",
    );

  const assetFiles = new Map<string, string>();
  for (const a of manifest.assets) {
    const rel = assetRelPathOrNull(a.path);
    if (rel) assetFiles.set(a.id, path.join(dir, rel));
  }

  const lock = await fs
    .readFile(path.join(dir, LOCK_FILE), "utf8")
    .then((t) => JSON.parse(t) as PackageLock)
    .catch(() => null);

  const pkg: CurrentPackage = {
    modelId: manifest.modelId,
    fingerprint: current.pointer.fingerprint,
    dir,
    manifest,
    diagnostics,
    assetFiles,
    lock,
  };
  cache = {
    pkg,
    pointerMtimeMs: current.mtimeMs,
    pointerSize: current.size,
    checkedAt: now,
  };
  return pkg;
}

/** Throwing variant for route handlers that cannot proceed without a package. */
export async function requireCurrentPackage(): Promise<CurrentPackage> {
  const pkg = await getCurrentPackage();
  if (!pkg) throw new ModelPackageError("no model package is installed", "no_package");
  return pkg;
}

export async function readManifest(): Promise<Manifest | null> {
  return (await getCurrentPackage())?.manifest ?? null;
}

/**
 * Absolute path of an asset's GLB. The asset id must appear in the manifest (allow-list) and the
 * resolved path must pass `safeJoin`. User input never reaches `path.join` directly.
 */
export async function assetPath(assetId: string): Promise<string> {
  const pkg = await requireCurrentPackage();
  const asset = pkg.manifest.assets.find((a) => a.id === assetId);
  if (!asset) throw new ModelPackageError(`unknown asset ${assetId}`, "not_found");
  return safeJoin(pkg.dir, asset.path);
}

export interface AssetStatus {
  id: string;
  path: string;
  kind: string;
  loadByDefault: boolean;
  present: boolean;
  bytes: number | null;
  sha256?: string;
}

export interface PackageStatus {
  installed: boolean;
  modelId: string | null;
  fingerprint: string | null;
  generated: string | null;
  schemaVersion: string | null;
  name: string | null;
  assets: AssetStatus[];
  diagnostics: Diagnostic[];
  issues: Manifest["issues"];
}

export const EMPTY_STATUS: PackageStatus = {
  installed: false,
  modelId: null,
  fingerprint: null,
  generated: null,
  schemaVersion: null,
  name: null,
  assets: [],
  diagnostics: [],
  issues: [],
};

/** Discovery hop: hands the client the current fingerprint plus server-side asset presence. */
export async function packageStatus(): Promise<PackageStatus> {
  const pkg = await getCurrentPackage().catch((err) => {
    if (err instanceof ModelPackageError)
      return {
        error: err,
      } as const;
    throw err;
  });
  if (pkg && "error" in pkg)
    return {
      ...EMPTY_STATUS,
      diagnostics: [
        {
          severity: "error",
          code: pkg.error.code.toUpperCase(),
          message: pkg.error.message,
        },
      ],
    };
  if (!pkg) return EMPTY_STATUS;

  const lockByPath = new Map((pkg.lock?.files ?? []).map((f) => [f.path, f]));
  const assets: AssetStatus[] = [];
  for (const a of pkg.manifest.assets) {
    const rel = assetRelPathOrNull(a.path);
    const abs = rel ? path.join(pkg.dir, rel) : null;
    const st = abs ? await fs.stat(abs).catch(() => null) : null;
    assets.push({
      id: a.id,
      path: a.path,
      kind: a.kind,
      loadByDefault: a.loadByDefault,
      present: !!st?.isFile(),
      bytes: st?.isFile() ? st.size : null,
      sha256: lockByPath.get(a.path)?.sha256,
    });
  }

  return {
    installed: true,
    modelId: pkg.modelId,
    fingerprint: pkg.fingerprint,
    generated: pkg.manifest.generated ?? null,
    schemaVersion: pkg.manifest.schemaVersion,
    name: pkg.manifest.name ?? null,
    assets,
    diagnostics: pkg.diagnostics,
    issues: pkg.manifest.issues,
  };
}
