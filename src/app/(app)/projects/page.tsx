import type { Metadata } from "next";
import Link from "next/link";
import { Hammer } from "lucide-react";
import { getDb } from "@/db/client";
import {
  PROJECT_KIND_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TONE,
  costVariance,
  formatCents,
} from "@/features/projects/labels";
import { requireSessionPage } from "@/server/auth/session";
import { listProjects } from "@/server/queries/infrastructure/projects";
import { Badge, EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";

export const metadata: Metadata = { title: "Projects" };

/**
 * The list of renovations, repairs, installations and inspections.
 *
 * A project is a container for facts that already exist elsewhere — the completions that were
 * recorded, the routes that were drawn, the equipment that was installed. It never invents work
 * (CLAUDE.md rule 6), which is why this list shows link counts rather than a progress bar: the
 * honest measure of a project here is how much of it has actually been written down.
 */
export default async function ProjectsPage() {
  await requireSessionPage("/projects");
  const projects = listProjects(getDb().db);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="House"
        title="Projects"
        description="Renovations, repairs and installations, each holding the photos, documents and links that explain why the house is the way it is."
        actions={
          <Link href="/projects/new" className={buttonClasses({ variant: "primary" })}>
            New project
          </Link>
        }
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={<Hammer />}
          title="No projects yet"
          description="A project ties together the work of one renovation: what was planned, what it cost, the before and after photos, and every pipe, cable and appliance it touched."
          bullets={[
            "Budget and actual cost side by side, in euros, so an overrun is a number and not a feeling.",
            "Before and after photos, plus receipts and inspection reports as documents.",
            "Links to the equipment, rooms and infrastructure routes the project changed.",
            "A timeline built only from completions someone linked here — never inferred from dates.",
          ]}
          actions={
            <Link href="/projects/new" className={buttonClasses({ variant: "primary" })}>
              New project
            </Link>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {projects.map((p) => {
            const variance = costVariance(p.budgetCents, p.actualCostCents);
            return (
              <li key={p.id}>
                <Panel
                  title={
                    <Link href={`/projects/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  }
                  subtitle={
                    <span>
                      {PROJECT_KIND_LABEL[p.kind]}
                      {p.startedOn ? ` · from ${p.startedOn}` : ""}
                      {p.endedOn ? ` to ${p.endedOn}` : ""}
                    </span>
                  }
                  actions={
                    <Badge tone={PROJECT_STATUS_TONE[p.status]}>
                      {PROJECT_STATUS_LABEL[p.status]}
                    </Badge>
                  }
                  footer={
                    <span>
                      {p.linkCount} {p.linkCount === 1 ? "link" : "links"} · {p.photoCount}{" "}
                      {p.photoCount === 1 ? "file" : "files"}
                    </span>
                  }
                >
                  {p.summary ? <p className="text-sm leading-6 text-ink-2">{p.summary}</p> : null}
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-ink-3">Budget</dt>
                      <dd className="tabular-nums">{formatCents(p.budgetCents, p.currency ?? "EUR")}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-ink-3">Actual</dt>
                      <dd className="tabular-nums">
                        {formatCents(p.actualCostCents, p.currency ?? "EUR")}
                      </dd>
                    </div>
                    {variance ? (
                      <div>
                        <dt className="text-xs text-ink-3">
                          {variance.overspend ? "Over budget" : "Under budget"}
                        </dt>
                        <dd className="tabular-nums">
                          {formatCents(variance.deltaCents, p.currency ?? "EUR")}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </Panel>
              </li>
            );
          })}
        </ul>
      )}
    </PageScroll>
  );
}
