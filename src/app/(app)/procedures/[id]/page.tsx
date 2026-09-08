import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { formatInstant, formatMinutes } from "@/features/maintenance/dueDate";
import { formatQty } from "@/features/maintenance/materials";
import { ProcedureEditor } from "@/features/maintenance/ProcedureEditor";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import { searchParts } from "@/server/queries/maintenance/plans";
import { loadProcedureDetail } from "@/server/queries/maintenance/procedures";

export const metadata: Metadata = { title: "Procedure" };

/**
 * One procedure: its version history, the version currently being shown, and — when that version
 * is the draft — the editor.
 *
 * `?version=<id>` shows an older version read-only, which is how you check what a task from two
 * years ago actually said.
 */
export default async function ProcedurePage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const search = await props.searchParams;
  const requestedVersion = typeof search.version === "string" ? search.version : undefined;

  const session = await requireSessionPage(`/procedures/${id}`);
  const { db, tz } = maintenanceContext(session.user.id);

  const detail = loadProcedureDetail(db, id, requestedVersion);
  if (detail === null) notFound();

  const members = loadMembers(db);
  const shown = detail.shown;
  const draft = detail.versions.find((version) => version.status === "draft") ?? null;

  return (
    <PageScroll>
      <PageHeader
        eyebrow={
          <Link href="/procedures" className="hover:underline">
            Procedures
          </Link>
        }
        title={detail.title}
        description={detail.summary ?? undefined}
        actions={
          shown === null ? null : detail.editable ? (
            <Badge tone="due">Editing draft v{shown.version}</Badge>
          ) : (
            <Badge tone={shown.versionId === detail.currentVersionId ? "ok" : "unknown"}>
              v{shown.version} {shown.versionId === detail.currentVersionId ? "in force" : "superseded"}
            </Badge>
          )
        }
      />

      <Panel title="Versions" flush subtitle="Publishing freezes a version; nothing is ever deleted.">
        <ul>
          {detail.versions.map((version) => (
            <li
              key={version.id}
              className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span className="flex flex-wrap items-baseline gap-2 text-sm">
                <Link
                  href={`/procedures/${detail.id}?version=${version.id}`}
                  className="vh-tnum text-ink hover:text-accent-text hover:underline"
                >
                  v{version.version}
                </Link>
                <Badge
                  tone={
                    version.status === "draft"
                      ? "due"
                      : version.id === detail.currentVersionId
                        ? "ok"
                        : "unknown"
                  }
                  size="sm"
                >
                  {version.status === "draft"
                    ? "Draft"
                    : version.id === detail.currentVersionId
                      ? "In force"
                      : "Superseded"}
                </Badge>
                {version.changeNote !== null ? (
                  <span className="text-xs text-ink-2">{version.changeNote}</span>
                ) : null}
              </span>
              <span className="vh-tnum text-xs text-ink-3">
                {version.publishedAtMs === null
                  ? `created ${formatInstant(version.createdAtMs, tz)}`
                  : `published ${formatInstant(version.publishedAtMs, tz)}${
                      members.find((member) => member.id === version.publishedBy)?.name === undefined
                        ? ""
                        : ` by ${members.find((member) => member.id === version.publishedBy)?.name}`
                    }`}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      {shown === null ? (
        <Panel title="No version to show">
          <p className="text-sm text-ink-2">
            This procedure has no versions, which should not happen — it was created without its
            first draft.
          </p>
        </Panel>
      ) : detail.editable ? (
        <ProcedureEditor
          procedureId={detail.id}
          editable
          isFirstDraft={shown.version === 1}
          hasDraft={draft !== null}
          parts={searchParts(db, "", 200)}
          initial={{
            title: detail.title,
            summary: detail.summary ?? "",
            defaultEffortMinutes:
              detail.defaultEffortMinutes === null ? "" : String(detail.defaultEffortMinutes),
            prerequisites: shown.prerequisites ?? "",
            safetyNotes: shown.safetyNotes ?? "",
            steps: shown.steps.map((step) => ({
              title: step.title,
              bodyMd: step.bodyMd ?? "",
              expectedMinutes: step.expectedMinutes === null ? "" : String(step.expectedMinutes),
              isOptional: step.isOptional,
              warning: step.warning ?? "",
              checklist: step.checklist.map((item) => ({
                text: item.text,
                requiresValue: item.requiresValue,
                unit: item.unit,
              })),
            })),
            looseChecklist: shown.looseChecklist.map((item) => ({
              text: item.text,
              requiresValue: item.requiresValue,
              unit: item.unit,
            })),
            tools: shown.tools.map((tool) => ({
              name: tool.name,
              isRequired: tool.isRequired,
              notes: tool.notes ?? "",
            })),
            materials: detail.shownMaterials.map((line) => ({
              partId: line.partId,
              qtyMilli: line.expectedQtyMilli,
              isRequired: line.isRequired,
            })),
            references: shown.references.map((reference) => ({
              kind: reference.kind,
              label: reference.label,
              url: reference.url ?? "",
              manualName: reference.manualName ?? "",
              pageFrom: reference.pageFrom === null ? "" : String(reference.pageFrom),
              pageTo: reference.pageTo === null ? "" : String(reference.pageTo),
            })),
            equipmentNotes: shown.equipmentNotes.map((note) => ({
              assetId: note.assetId ?? "",
              assetModelName: note.assetModelName ?? "",
              note: note.note,
            })),
          }}
        />
      ) : (
        <>
          <ProcedureEditor
            procedureId={detail.id}
            editable={false}
            isFirstDraft={false}
            hasDraft={draft !== null}
            parts={[]}
            initial={EMPTY_EDITOR_VALUES}
          />

          <Panel title={`Version ${shown.version}`} subtitle="Read-only: a published version is frozen.">
            <div className="flex flex-col gap-4 text-sm">
              {shown.safetyNotes !== null ? (
                <section>
                  <h3 className="font-semibold text-ink">Safety</h3>
                  <p className="mt-1 whitespace-pre-wrap text-ink-2">{shown.safetyNotes}</p>
                </section>
              ) : null}
              {shown.prerequisites !== null ? (
                <section>
                  <h3 className="font-semibold text-ink">Before you start</h3>
                  <p className="mt-1 whitespace-pre-wrap text-ink-2">{shown.prerequisites}</p>
                </section>
              ) : null}
              {shown.tools.length > 0 ? (
                <section>
                  <h3 className="font-semibold text-ink">Tools</h3>
                  <p className="mt-1 text-ink-2">
                    {shown.tools
                      .map((tool) => `${tool.name}${tool.isRequired ? "" : " (optional)"}`)
                      .join(", ")}
                  </p>
                </section>
              ) : null}
              {detail.shownMaterials.length > 0 ? (
                <section>
                  <h3 className="font-semibold text-ink">Materials</h3>
                  <ul className="vh-tnum mt-1 text-ink-2">
                    {detail.shownMaterials.map((line) => (
                      <li key={line.partId}>
                        {line.partName}: {formatQty(line.expectedQtyMilli, line.unit)}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section>
                <h3 className="font-semibold text-ink">Steps</h3>
                {shown.steps.length === 0 ? (
                  <p className="mt-1 text-ink-3">This version has no steps.</p>
                ) : (
                  <ol className="mt-2 flex flex-col gap-3">
                    {shown.steps.map((step, index) => (
                      <li key={step.id}>
                        <p className="font-medium text-ink">
                          <span className="vh-tnum mr-2 text-ink-3">{index + 1}</span>
                          {step.title}
                          {step.isOptional ? (
                            <span className="ml-2 text-xs text-ink-3">optional</span>
                          ) : null}
                          {formatMinutes(step.expectedMinutes) === null ? null : (
                            <span className="ml-2 text-xs text-ink-3">
                              {formatMinutes(step.expectedMinutes)}
                            </span>
                          )}
                        </p>
                        {step.warning !== null ? (
                          <p className="mt-0.5 text-xs text-due">{step.warning}</p>
                        ) : null}
                        {step.bodyMd !== null ? (
                          <p className="mt-0.5 whitespace-pre-wrap text-ink-2">{step.bodyMd}</p>
                        ) : null}
                        {step.checklist.length > 0 ? (
                          <ul className="mt-1 list-disc pl-5 text-ink-2">
                            {step.checklist.map((item) => (
                              <li key={item.id}>
                                {item.text}
                                {item.requiresValue === null
                                  ? ""
                                  : ` — records a ${item.requiresValue}${item.unit === null ? "" : ` in ${item.unit}`}`}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              {shown.looseChecklist.length > 0 ? (
                <section>
                  <h3 className="font-semibold text-ink">Final checks</h3>
                  <ul className="mt-1 list-disc pl-5 text-ink-2">
                    {shown.looseChecklist.map((item) => (
                      <li key={item.id}>{item.text}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {shown.references.length > 0 ? (
                <section>
                  <h3 className="font-semibold text-ink">References</h3>
                  <ul className="mt-1 text-ink-2">
                    {shown.references.map((reference) => (
                      <li key={reference.id}>
                        {reference.label}
                        {reference.manualName === null ? "" : ` — ${reference.manualName}`}
                        {reference.pageFrom === null
                          ? ""
                          : `, p. ${reference.pageFrom}${reference.pageTo === null ? "" : `–${reference.pageTo}`}`}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </Panel>

          {requestedVersion !== undefined ? (
            <p>
              <Link
                href={`/procedures/${detail.id}`}
                className={buttonClasses({ variant: "ghost", size: "sm" })}
              >
                Back to the current version
              </Link>
            </p>
          ) : null}
        </>
      )}
    </PageScroll>
  );
}

const EMPTY_EDITOR_VALUES = {
  title: "",
  summary: "",
  defaultEffortMinutes: "",
  prerequisites: "",
  safetyNotes: "",
  steps: [],
  looseChecklist: [],
  tools: [],
  materials: [],
  references: [],
  equipmentNotes: [],
};
