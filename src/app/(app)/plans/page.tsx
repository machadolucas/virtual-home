import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardList, HardHat, Plus } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Avatar, Badge, EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { describeDue, formatDate } from "@/features/maintenance/dueDate";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import { loadPlans } from "@/server/queries/maintenance/plans";

export const metadata: Metadata = { title: "Maintenance plans" };

/**
 * Every recurring obligation in the house, with its next date and its rule spelled out in words.
 *
 * The rule text comes from the domain's own `describeRule`, so the list cannot describe a schedule
 * differently from the way the scheduler applies it.
 */
export default async function PlansPage() {
  const session = await requireSessionPage("/plans");
  const { db, today } = maintenanceContext(session.user.id);
  const plans = loadPlans(db);
  const members = loadMembers(db);

  const needsSetup = plans.filter((plan) => plan.needsSetup);
  const scheduled = plans.filter((plan) => !plan.needsSetup);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Household"
        title="Maintenance plans"
        description="What the house needs doing, how often, and where the next date comes from. Plans generate one open task at a time."
        actions={
          <Link href="/plans/new" className={buttonClasses({ variant: "primary", size: "sm" })}>
            <Plus aria-hidden="true" className="size-4" />
            New plan
          </Link>
        }
      />

      {plans.length === 0 ? (
        <EmptyState
          icon={<ClipboardList />}
          title="No plans yet"
          description="A plan says what needs doing, to what, and how often. Everything on Today comes either from a plan or from a Home Assistant condition rule."
          bullets={[
            "A schedule in plain language: “every 6 months after it was last done”, “every April and October”, “between 1 May and 30 June”.",
            "A starting point recorded honestly — including “I do not know”, which pauses the plan rather than inventing a date.",
            "The parts each task needs, pre-filled on the completion form and counted against stock.",
            "Who it belongs to: one member or both.",
          ]}
          actions={
            <Link href="/plans/new" className={buttonClasses({ variant: "primary" })}>
              Create the first plan
            </Link>
          }
          note="Plans are edited here; the tasks they generate are worked on from Today."
        />
      ) : null}

      {needsSetup.length > 0 ? (
        <Panel
          title="Waiting for a starting point"
          subtitle="Saved with “ask me later”. Nothing is generated until the question is answered — the app will not guess a date, because a guessed date becomes fake history."
          flush
        >
          <ul>
            {needsSetup.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <Link href={`/plans/${plan.id}`} className="text-sm font-medium text-ink hover:underline">
                    {plan.title}
                  </Link>
                  <p className="text-xs text-ink-3">
                    {plan.ruleText}
                    {plan.target === null ? "" : ` · ${plan.target.name}`}
                  </p>
                </div>
                <Link
                  href={`/plans/${plan.id}`}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Answer it
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {scheduled.length > 0 ? (
        <Panel title="Scheduled" flush footer={`${scheduled.length} plans`}>
          <ul>
            {scheduled.map((plan) => {
              const assignees =
                plan.assignmentMode === "shared"
                  ? members
                  : members.filter((member) => member.id === plan.assigneeUserId);
              return (
                <li key={plan.id} className="border-b border-line px-4 py-3 last:border-b-0">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Link
                          href={`/plans/${plan.id}`}
                          className="text-sm font-medium text-ink hover:underline"
                        >
                          {plan.title}
                        </Link>
                        {plan.status === "paused" ? (
                          <Badge tone="unknown" size="sm">
                            Paused
                          </Badge>
                        ) : null}
                        {plan.requiresProfessional ? (
                          <Badge tone="neutral" icon={<HardHat aria-hidden="true" />} size="sm">
                            Professional
                          </Badge>
                        ) : null}
                        {plan.priority !== "normal" ? (
                          <Badge tone={plan.priority === "low" ? "neutral" : "due"} icon={null} size="sm">
                            {plan.priority}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {plan.ruleText}
                        {plan.target === null ? "" : ` · ${plan.target.name}`}
                        {plan.procedureTitle === null ? "" : ` · ${plan.procedureTitle}`}
                      </p>
                      <p className="vh-tnum mt-1 text-xs">
                        {plan.openOccurrence === null ? (
                          <span className="text-ink-3">
                            {plan.status === "paused"
                              ? "No task open while paused."
                              : "No task open right now."}
                          </span>
                        ) : (
                          <Link
                            href={`/tasks/${plan.openOccurrence.id}`}
                            className="text-accent-text hover:underline"
                          >
                            Next: {formatDate(plan.openOccurrence.dueDate)} —{" "}
                            {describeDue(plan.openOccurrence.dueDate, today)}
                          </Link>
                        )}
                        {plan.lastCompletedOn === null ? (
                          <span className="ml-2 text-ink-3">no completion recorded yet</span>
                        ) : (
                          <span className="ml-2 text-ink-3">
                            last done {formatDate(plan.lastCompletedOn)}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {assignees.map((member) => (
                        <Avatar
                          key={member.id}
                          name={member.name}
                          color={member.displayColor}
                          size="sm"
                          labelled
                        />
                      ))}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}
    </PageScroll>
  );
}
