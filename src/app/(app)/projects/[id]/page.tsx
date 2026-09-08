import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import {
  PROJECT_KIND_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  costVariance,
  formatCents,
  showInHouseHref,
} from "@/features/projects/labels";
import { requireSessionPage } from "@/server/auth/session";
import { linkCandidates, readProject } from "@/server/queries/infrastructure/projects";
import { Badge, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { ProjectForm, type ProjectFormValues } from "../ProjectForm";
import { DeleteProject } from "./DeleteProject";
import { ProjectFiles } from "./ProjectFiles";
import { ProjectLinks } from "./ProjectLinks";

export async function generateMetadata({
  params,
}: PageProps<"/projects/[id]">): Promise<Metadata> {
  const { id } = await params;
  const detail = readProject(getDb().db, id);
  return { title: detail?.project.name ?? "Project" };
}

/**
 * One project: what it was, what it cost, the before and after, what it touched, and what was
 * actually completed as part of it.
 *
 * The timeline is the honest part. It lists **linked completions** and nothing else — no
 * occurrences that merely fall inside the date range, no "probably done" entries (CLAUDE.md rule
 * 6). A voided completion stays on it, marked as voided, because hiding a correction hides the
 * correction.
 */
export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  await requireSessionPage(`/projects/${id}`);

  const { db } = getDb();
  const detail = readProject(db, id);
  if (!detail) notFound();

  const p = detail.project;
  const currency = p.currency ?? "EUR";
  const variance = costVariance(p.budgetCents, p.actualCostCents);
  const initial: ProjectFormValues = {
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    startedOn: p.startedOn ?? "",
    endedOn: p.endedOn ?? "",
    budget: p.budgetCents === null ? "" : (p.budgetCents / 100).toFixed(2),
    actualCost: p.actualCostCents === null ? "" : (p.actualCostCents / 100).toFixed(2),
    summary: p.summary ?? "",
    notes: p.notes ?? "",
  };

  return (
    <PageScroll>
      <PageHeader
        eyebrow={
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
        }
        title={p.name}
        description={p.summary ?? undefined}
        actions={
          <>
            <Link
              href={showInHouseHref(p.id, detail.routeIds)}
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              Show in house
            </Link>
            <DeleteProject projectId={p.id} name={p.name} />
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <Badge tone={PROJECT_STATUS_TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Badge>
          <span>{PROJECT_KIND_LABEL[p.kind]}</span>
          {p.startedOn ? <span>· started {p.startedOn}</span> : null}
          {p.endedOn ? <span>· ended {p.endedOn}</span> : null}
          <span className="tabular-nums">
            · budget {formatCents(p.budgetCents, currency)} · actual{" "}
            {formatCents(p.actualCostCents, currency)}
          </span>
          {variance ? (
            <span className="tabular-nums">
              · {formatCents(variance.deltaCents, currency)}{" "}
              {variance.overspend ? "over" : "under"}
            </span>
          ) : null}
        </div>
      </PageHeader>

      <Panel
        title="Timeline"
        subtitle="Built only from completions linked to this project — never inferred from its dates."
      >
        {detail.timeline.length === 0 ? (
          <p className="text-sm text-ink-2">
            Nothing completed has been linked yet. Link a completed task below and it appears here.
          </p>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {detail.timeline.map((entry) => (
              <li key={entry.completionId} className="flex items-baseline gap-3 py-2">
                <time className="w-24 shrink-0 tabular-nums text-xs text-ink-3">
                  {entry.completedLocalDate}
                </time>
                <div className="min-w-0">
                  <p className="text-sm">
                    {entry.title}
                    {entry.voided ? (
                      <>
                        {" "}
                        <Badge tone="overdue">Voided</Badge>
                      </>
                    ) : entry.outcome !== "done" ? (
                      <>
                        {" "}
                        <Badge tone="neutral">{entry.outcome}</Badge>
                      </>
                    ) : null}
                  </p>
                  {entry.notes ? <p className="text-xs text-ink-2">{entry.notes}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <ProjectLinks
        projectId={p.id}
        links={detail.links}
        candidates={linkCandidates(db)}
      />

      <ProjectFiles projectId={p.id} attachments={detail.attachments} />

      <ProjectForm initial={initial} submitLabel="Save changes" />

      {p.notes ? (
        <Panel title="Notes">
          <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">{p.notes}</p>
        </Panel>
      ) : null}
    </PageScroll>
  );
}
