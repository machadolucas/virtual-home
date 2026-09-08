"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { getDb, writeTx } from "@/db/client";
import { nowMs } from "@/db/ids";
import { loadEnv } from "@/env";
import { writeAudit } from "@/domain/inventory";
import { action } from "@/server/api/action";
import { HttpError } from "@/server/api/handler";
import { mapDomainErrors } from "@/server/actions/inventory/errors";
import {
  ModelPackageError,
  getCurrentPackage,
  installPackage,
  invalidatePackageCache,
  validatePackageDir, manifestIndexOf } from "@/server/house-model/package";
import {
  abandonReconciliation,
  applyReconciliation,
  syncLocations,
  decideReconciliationItem,
  reconciliationSummary,
  registerRevision,
} from "@/server/house-model/revision";
import { userContext } from "@/server/queries/settings/household";
import { installPackageInput } from "./schemas";
import { decideReconciliationItemInput, reconciliationActionInput } from "./modelSchemas";

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

  const handle = getDb();
  writeTx(handle.db, (tx) => {
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

  // Record the revision so colours, placements, routes and annotations can be stamped and, when
  // the semantic ids have moved, reconciled. Same call `pnpm vh-admin model-import` makes.
  invalidatePackageCache();
  const current = await getCurrentPackage();
  const registration =
    current === null ? null : registerRevision(handle, current, session.user.id);

  revalidatePath("/settings/model");
  revalidatePath("/house");
  return {
    fingerprint: result.fingerprint,
    modelId: result.modelId,
    alreadyInstalled: result.alreadyInstalled,
    diagnostics: result.diagnostics,
    revision:
      registration === null
        ? null
        : {
            status: registration.status,
            revisionId: registration.revisionId,
            reconciliationId: registration.reconciliationId ?? null,
            itemCount: registration.itemCount,
            aliasCarried: registration.aliasCarried,
          },
  };
});

/* -------------------------------------------------------------------------------------------------
 * Reconciliation
 *
 * Three deliberately separate actions. A decision is cheap and revisable; applying is the one
 * irreversible step, and it refuses (`undecided_items`) until every row has an answer — which is
 * why the UI can only enable "Apply" once `applicable` is true rather than hoping for the best.
 * ---------------------------------------------------------------------------------------------- */

/** Record (or change) one item's decision. Writes nothing to the runtime tables. */
export const decideModelReconciliationItem = action(decideReconciliationItemInput, async (input, session) => {
  const handle = getDb();
  const result = mapDomainErrors(() =>
    decideReconciliationItem(handle, {
      itemId: input.itemId,
      decision: input.decision,
      newNodeId: input.newNodeId ?? null,
      actorUserId: session.user.id,
      ...(input.note === undefined ? {} : { note: input.note }),
    }),
  );
  revalidatePath("/settings/model");
  return result;
});

/** What "Apply" is about to do, for the confirmation dialog. Read-only. */
export const readModelReconciliationSummary = action(
  reconciliationActionInput.omit({ idempotencyKey: true }),
  async (input) => {
    const { db } = getDb();
    return mapDomainErrors(() => reconciliationSummary(db, input.reconciliationId));
  },
);

/** The irreversible step: one transaction, every decision, and the current pointer moves. */
export const applyModelReconciliation = action(reconciliationActionInput, async (input, session) => {
  const handle = getDb();
  const result = mapDomainErrors(() =>
    applyReconciliation(handle, {
      reconciliationId: input.reconciliationId,
      actorUserId: session.user.id,
    }),
  );
  // The new revision is current now: mirror its rooms/floors into the location tree.
  const current = await getCurrentPackage();
  if (current) {
    const index = manifestIndexOf(current);
    writeTx(handle.db, (tx) => syncLocations(tx, result.toRevisionId, index, session.user.id, nowMs()));
  }
  revalidatePath("/settings/model");
  revalidatePath("/house");
  revalidatePath("/equipment");
  return result;
});

/** Walk away: the new revision stays `imported` and the affected rows stay flagged. */
export const abandonModelReconciliation = action(reconciliationActionInput, async (input, session) => {
  const handle = getDb();
  const result = mapDomainErrors(() =>
    abandonReconciliation(handle, {
      reconciliationId: input.reconciliationId,
      actorUserId: session.user.id,
    }),
  );
  revalidatePath("/settings/model");
  return result;
});
