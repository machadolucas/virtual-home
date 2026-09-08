import "server-only";
import { asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { maintenancePlan } from "@/db/schema/maintenance";
import { procedure, procedureVersion } from "@/db/schema/procedures";
import { loadFrozenProcedure, loadProcedureMaterials, type FrozenProcedure } from "./task";
import type { MaterialLine } from "@/features/maintenance/materials";

export interface ProcedureListRow {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  defaultEffortMinutes: number | null;
  currentVersionId: string | null;
  currentVersion: number | null;
  publishedAtMs: number | null;
  /** A draft exists and is being edited. */
  draftVersionId: string | null;
  draftVersion: number | null;
  /** How many active plans point at this procedure — deleting is never offered, this explains why. */
  planCount: number;
  archivedAtMs: number | null;
}

export function loadProcedures(db: Db, includeArchived = false): ProcedureListRow[] {
  const rows = db
    .select({
      id: procedure.id,
      title: procedure.title,
      slug: procedure.slug,
      summary: procedure.summary,
      defaultEffortMinutes: procedure.defaultEffortMinutes,
      currentVersionId: procedure.currentVersionId,
      archivedAtMs: procedure.archivedAtMs,
    })
    .from(procedure)
    .where(includeArchived ? undefined : isNull(procedure.archivedAtMs))
    .orderBy(asc(procedure.title))
    .all();

  const versions = db
    .select({
      id: procedureVersion.id,
      procedureId: procedureVersion.procedureId,
      version: procedureVersion.version,
      status: procedureVersion.status,
      publishedAtMs: procedureVersion.publishedAtMs,
    })
    .from(procedureVersion)
    .all();

  const plans = db
    .select({ procedureId: maintenancePlan.procedureId, status: maintenancePlan.status })
    .from(maintenancePlan)
    .all();

  return rows.map((row) => {
    const mine = versions.filter((version) => version.procedureId === row.id);
    const current = mine.find((version) => version.id === row.currentVersionId) ?? null;
    const draft = mine.find((version) => version.status === "draft") ?? null;
    return {
      ...row,
      currentVersion: current?.version ?? null,
      publishedAtMs: current?.publishedAtMs ?? null,
      draftVersionId: draft?.id ?? null,
      draftVersion: draft?.version ?? null,
      planCount: plans.filter(
        (plan) => plan.procedureId === row.id && plan.status !== "cancelled",
      ).length,
    };
  });
}

export interface ProcedureVersionSummary {
  id: string;
  version: number;
  status: "draft" | "published" | "superseded";
  publishedAtMs: number | null;
  publishedBy: string | null;
  changeNote: string | null;
  createdAtMs: number;
}

export interface ProcedureDetail {
  id: string;
  title: string;
  slug: string;
  summary: string | null;
  defaultEffortMinutes: number | null;
  currentVersionId: string | null;
  archivedAtMs: number | null;
  /** Every version, newest first, for the history panel. */
  versions: ProcedureVersionSummary[];
  /** The version being shown: the draft when there is one, otherwise the published one. */
  shown: FrozenProcedure | null;
  shownMaterials: MaterialLine[];
  /** `true` when `shown` is the editable draft. Published versions are read-only. */
  editable: boolean;
  planCount: number;
}

export function loadProcedureDetail(
  db: Db,
  procedureId: string,
  versionId?: string,
): ProcedureDetail | null {
  const row = db.select().from(procedure).where(eq(procedure.id, procedureId)).get();
  if (!row) return null;

  const versions = db
    .select({
      id: procedureVersion.id,
      version: procedureVersion.version,
      status: procedureVersion.status,
      publishedAtMs: procedureVersion.publishedAtMs,
      publishedBy: procedureVersion.publishedBy,
      changeNote: procedureVersion.changeNote,
      createdAtMs: procedureVersion.createdAtMs,
    })
    .from(procedureVersion)
    .where(eq(procedureVersion.procedureId, procedureId))
    .orderBy(desc(procedureVersion.version))
    .all();

  const draft = versions.find((version) => version.status === "draft") ?? null;
  const chosenId =
    versionId ?? draft?.id ?? row.currentVersionId ?? versions[0]?.id ?? null;
  const chosen = versions.find((version) => version.id === chosenId) ?? null;

  const planCount = db
    .select({ id: maintenancePlan.id, procedureId: maintenancePlan.procedureId, status: maintenancePlan.status })
    .from(maintenancePlan)
    .where(eq(maintenancePlan.procedureId, procedureId))
    .all()
    .filter((plan) => plan.status !== "cancelled").length;

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    summary: row.summary,
    defaultEffortMinutes: row.defaultEffortMinutes,
    currentVersionId: row.currentVersionId,
    archivedAtMs: row.archivedAtMs,
    versions,
    shown: loadFrozenProcedure(db, chosenId),
    shownMaterials: chosenId === null ? [] : loadProcedureMaterials(db, chosenId),
    editable: chosen?.status === "draft",
    planCount,
  };
}
