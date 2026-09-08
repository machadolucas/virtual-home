import "server-only";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { modelRevision } from "@/db/schema";
import { getCurrentPackage } from "@/server/house-model/package";
import { readHouseholdRow } from "./household";

/**
 * The export envelope of `docs/design-notes/domain-scheduling-inventory.md` §8.4.
 *
 * Its whole reason for existing: a coordinate is meaningless without its frame, and a semantic
 * `roomId` is meaningless without the model revision it came from. Every export carries both, so a
 * file read years later is still interpretable — and so a file from *before* a model swap is
 * distinguishable from one after it.
 */

export interface ExportModelContext {
  modelId: string | null;
  revisionId: string | null;
  schemaVersion: string | null;
  generatedAt: string | null;
  contentHash: string | null;
  /** From the installed package's manifest when available, else the revision row's JSON. */
  coordinateSystem: Record<string, unknown> | null;
  /** The installed package's content fingerprint, which is not the same as a revision id. */
  packageFingerprint: string | null;
}

export interface ExportEnvelope {
  exportedAt: string;
  app: { name: "virtual-home"; schemaVersion: number };
  household: { displayName: string; timezone: string; deliveryTime: string };
  model: ExportModelContext;
  /** Which dataset names this export carries. */
  datasetNames: string[];
}

/**
 * Bumped when an exported dataset's *shape* changes in a way a reader must notice. It is not the
 * migration count: a migration that adds an unexported column changes nothing for a consumer.
 */
export const EXPORT_SCHEMA_VERSION = 1;

export async function buildEnvelope(
  tx: Db,
  datasetNames: readonly string[],
  nowMs = Date.now(),
): Promise<ExportEnvelope> {
  const household = readHouseholdRow(tx);

  const revision =
    (household.currentModelRevisionId === null
      ? tx
          .select()
          .from(modelRevision)
          .where(eq(modelRevision.status, "current"))
          .orderBy(desc(modelRevision.importedAtMs))
          .get()
      : tx
          .select()
          .from(modelRevision)
          .where(eq(modelRevision.id, household.currentModelRevisionId))
          .get()) ?? null;

  // The installed package is the authority on the coordinate system; the revision row's copy is a
  // fallback for a database whose package directory is not mounted (a restored backup, say).
  const pkg = await getCurrentPackage().catch(() => null);

  let coordinateSystem: Record<string, unknown> | null = null;
  if (pkg !== null) {
    coordinateSystem = pkg.manifest.coordinateSystem as unknown as Record<string, unknown>;
  } else if (revision !== null) {
    try {
      const parsed: unknown = JSON.parse(revision.coordinateSystemJson);
      coordinateSystem =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      coordinateSystem = null;
    }
  }

  return {
    exportedAt: new Date(nowMs).toISOString(),
    app: { name: "virtual-home", schemaVersion: EXPORT_SCHEMA_VERSION },
    household: {
      displayName: household.displayName,
      timezone: household.timezone,
      deliveryTime: household.deliveryTime,
    },
    model: {
      modelId: revision?.modelId ?? pkg?.modelId ?? household.currentModelId,
      revisionId: revision?.id ?? null,
      schemaVersion: revision?.schemaVersion ?? pkg?.manifest.schemaVersion ?? null,
      generatedAt:
        revision === null ? (pkg?.manifest.generated ?? null) : new Date(revision.generatedAtMs).toISOString(),
      contentHash: revision?.contentHash ?? null,
      coordinateSystem,
      packageFingerprint: pkg?.fingerprint ?? null,
    },
    datasetNames: [...datasetNames],
  };
}

/** `virtual-home-inventory-2026-09-08.csv` — a name that says what and when without being opened. */
export function exportFilename(
  slug: string,
  format: "json" | "csv",
  dataset: string | null,
  nowMs = Date.now(),
): string {
  const date = new Date(nowMs).toISOString().slice(0, 10);
  const middle = dataset === null ? slug : `${slug}-${dataset}`;
  return `virtual-home-${middle}-${date}.${format}`;
}
