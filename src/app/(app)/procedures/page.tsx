import type { Metadata } from "next";
import Link from "next/link";
import { ScrollText } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { formatInstant, formatMinutes } from "@/features/maintenance/dueDate";
import { NewProcedureButton } from "@/features/maintenance/NewProcedureButton";
import { maintenanceContext } from "@/server/queries/maintenance/context";
import { loadProcedures } from "@/server/queries/maintenance/procedures";

export const metadata: Metadata = { title: "Procedures" };

/**
 * The written-down instructions.
 *
 * A procedure is versioned and, once published, frozen: tasks freeze the version they were
 * generated with, so rewriting a procedure never changes work already in progress or already
 * recorded.
 */
export default async function ProceduresPage() {
  const session = await requireSessionPage("/procedures");
  const { db, tz } = maintenanceContext(session.user.id);
  const procedures = loadProcedures(db);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Household"
        title="Procedures"
        description="How each job is actually done — steps, checks, tools, parts and the page in the manual. Attached to plans, and frozen onto every task as it is generated."
        actions={<NewProcedureButton />}
      />

      {procedures.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No procedures written yet"
          description="A plan works without one. A procedure is worth writing when the job has steps somebody will forget — which is most jobs, the second time."
          bullets={[
            "Numbered steps with instructions, an expected duration and per-step warnings.",
            "Checks that record a value: a pressure reading, a note, or a photo.",
            "The tools and parts the job needs, and the manual page it comes from.",
            "Versions: publishing freezes a version, and editing afterwards starts a new draft.",
          ]}
          note="Tasks show the version that was in force when they were generated, never the newest one."
        />
      ) : (
        <Panel title="All procedures" flush footer={`${procedures.length} procedures`}>
          <ul>
            {procedures.map((procedure) => (
              <li key={procedure.id} className="border-b border-line px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link
                        href={`/procedures/${procedure.id}`}
                        className="text-sm font-medium text-ink hover:underline"
                      >
                        {procedure.title}
                      </Link>
                      {procedure.currentVersion === null ? (
                        <Badge tone="unknown" size="sm">
                          Never published
                        </Badge>
                      ) : (
                        <Badge tone="ok" size="sm">
                          v{procedure.currentVersion} in force
                        </Badge>
                      )}
                      {procedure.draftVersionId !== null ? (
                        <Badge tone="due" size="sm">
                          Draft v{procedure.draftVersion}
                        </Badge>
                      ) : null}
                    </div>
                    {procedure.summary !== null ? (
                      <p className="mt-0.5 text-xs text-ink-2">{procedure.summary}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-ink-3">
                      {procedure.publishedAtMs === null
                        ? "No published version yet — plans using it generate tasks with no instructions."
                        : `Published ${formatInstant(procedure.publishedAtMs, tz)}`}
                      {formatMinutes(procedure.defaultEffortMinutes) === null
                        ? ""
                        : ` · usually ${formatMinutes(procedure.defaultEffortMinutes)}`}
                      {procedure.planCount === 0
                        ? " · not used by any plan"
                        : ` · used by ${procedure.planCount} ${procedure.planCount === 1 ? "plan" : "plans"}`}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </PageScroll>
  );
}
