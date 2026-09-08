"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { loadEnv } from "@/env";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { HttpError } from "@/server/api/handler";
import {
  ModelPackageError,
  installPackage,
  validatePackageDir,
} from "@/server/house-model/package";
import { userContext } from "@/server/queries/settings/household";
import { installPackageInput } from "./schemas";

/**
 * Installing a house-model package from `model-incoming`.
 *
 * The package is immutable input (CLAUDE.md rule 7): `installPackage` validates it, copies it to
 * `<modelDir>/<fingerprint>/` and moves `current.json`. It never edits geometry and never rewrites
 * a row that points at the previous fingerprint — a changed fingerprint may open a reconciliation
 * instead, which a human then works through.
 *
 * The directory *name* is the input, never a path: it is joined onto `modelIncomingDir` here, so
 * there is no way to aim the installer at an arbitrary directory on the machine.
 */

function incomingPath(directoryName: string): string {
  const base = loadEnv().modelIncomingDir;
  const abs = path.resolve(base, directoryName);
  const withSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (!abs.startsWith(withSep)) {
    throw new HttpError(400, "unsafe_path", "that is not a directory inside model-incoming");
  }
  return abs;
}

/** Dry run: report what the package says and what is wrong with it, changing nothing. */
export const validateIncomingPackage = action(
  installPackageInput.omit({ idempotencyKey: true }),
  async (input) => {
    const dir = incomingPath(input.directoryName);
    try {
      const { manifest, diagnostics } = await validatePackageDir(dir);
      return {
        ok: true as const,
        modelId: manifest.modelId,
        schemaVersion: manifest.schemaVersion,
        generated: manifest.generated ?? null,
        assetCount: manifest.assets.length,
        diagnostics,
      };
    } catch (err) {
      if (err instanceof ModelPackageError) {
        throw new HttpError(422, err.code, err.message);
      }
      throw err;
    }
  },
);

export const installModelPackage = action(installPackageInput, async (input, session) => {
  const dir = incomingPath(input.directoryName);
  let result;
  try {
    result = await installPackage(dir);
  } catch (err) {
    if (err instanceof ModelPackageError) {
      throw new HttpError(422, err.code, err.message);
    }
    throw err;
  }

  const { db } = getDb();
  writeTx(db, (tx) => {
    const ctx = userContext(session, tx);
    writeAudit(tx, ctx, {
      entityTable: "model_revision",
      entityId: result.fingerprint,
      action: result.alreadyInstalled ? "reinstalled" : "created",
      summary:
        `model package ${result.modelId} fingerprint ${result.fingerprint.slice(0, 12)} ` +
        (result.alreadyInstalled
          ? "was already installed; current.json now points at it"
          : "installed and made current"),
    });
  });

  revalidatePath("/settings/model");
  revalidatePath("/house");
  return {
    fingerprint: result.fingerprint,
    modelId: result.modelId,
    alreadyInstalled: result.alreadyInstalled,
    diagnostics: result.diagnostics,
  };
});
