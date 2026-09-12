import fs from "node:fs";
import path from "node:path";

/** Stored paths are POSIX-relative. Reject aliases as well as traversal. */
export function integrityFilePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes("\\") || relative.includes("\0") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid file location.");
  }
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Storage must be a real directory, not a symbolic link.");
  const parts = relative.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error("Symbolic links cannot be moved or restored.");
    if (stat && index < parts.length - 1 && !stat.isDirectory()) throw new Error("A parent location is not a directory.");
  }
  return current;
}

export function ensureIntegrityDirectory(root: string, relative: string): string {
  const target = integrityFilePath(root, relative);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  integrityFilePath(root, `${relative}/check`);
  return target;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export interface StagedIntegrityFile {
  /** Only after the database journal commits. */
  finish: () => void;
  /** Database transaction failed; the untouched original remains available. */
  rollback: () => void;
}

/** Retain the original until the journal commits. A process crash cannot strand the only copy. */
export function stageRegularFile(source: string, destination: string): StagedIntegrityFile {
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Only regular files can be moved.");
  fs.linkSync(source, destination); // EEXIST, including dangling symlinks: never overwrite.
  const linked = fs.lstatSync(destination);
  const rollback = () => {
    const current = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!current) return;
    if (!sameFile(linked, current)) throw new Error("The staged location changed. No file was removed.");
    const original = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!original?.isFile() || !sameFile(before, original)) throw new Error("The original location changed. The staged copy was preserved for recovery.");
    fs.unlinkSync(destination);
  };
  try {
    if (!linked.isFile() || !sameFile(before, linked) || !sameFile(before, fs.lstatSync(source))) {
      throw new Error("The file changed while it was being moved. Refresh and retry.");
    }
  } catch (error) { rollback(); throw error; }
  return {
    rollback,
    finish: () => {
      const stored = fs.lstatSync(destination, { throwIfNoEntry: false });
      if (!stored?.isFile() || !sameFile(before, stored)) throw new Error("The saved copy changed. The original was preserved.");
      const current = fs.lstatSync(source, { throwIfNoEntry: false });
      if (!current) return;
      if (!current.isFile() || !sameFile(before, current)) {
        throw new Error("The file changed before cleanup. Both locations were preserved.");
      }
      fs.unlinkSync(source);
    },
  };
}

export function sameRegularFile(left: string, right: string): boolean {
  const a = fs.lstatSync(left, { throwIfNoEntry: false });
  const b = fs.lstatSync(right, { throwIfNoEntry: false });
  return Boolean(a?.isFile() && b?.isFile() && sameFile(a, b));
}

export function attachmentStoragePaths(row: { storagePath: string; hasWebCopy: boolean }): string[] {
  const dir = path.posix.dirname(row.storagePath);
  const base = path.posix.basename(row.storagePath, path.posix.extname(row.storagePath));
  return [row.storagePath, ...(row.hasWebCopy ? [path.posix.join(dir, `${base}.web.jpg`), path.posix.join(dir, `${base}.thumb.jpg`)] : [])];
}
