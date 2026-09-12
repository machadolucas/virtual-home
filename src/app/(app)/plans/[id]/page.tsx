import type { Route } from "next";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, Panel, StatusBadge, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { describeDue, formatDate, formatInstant } from "@/features/maintenance/dueDate";
import { formatQty } from "@/features/maintenance/materials";
import { PlanForm } from "@/features/maintenance/PlanForm";
import { formKindOf, formStateFromRule } from "@/features/maintenance/schedule";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import {
  loadPlanDetail,
  loadProcedureOptions,
  loadProviders,
  searchParts,
} from "@/server/queries/maintenance/plans";
import { searchTargets } from "@/server/queries/maintenance/targets";

export const metadata: Metadata = { title: "Plan" };

const STATUS_LABEL = {
  pending: "Scheduled",
  due: "Due",
  completed: "Done",
  skipped: "Skipped",
  cancelled: "Cancelled",
} as const;

/**
 * One plan: what it is, where its next date comes from, every occurrence it has produced, and the
 * form to change it.
 *
 * The occurrence list is the plan's real record. A skipped occurrence appears as skipped and a
 * cancelled one as cancelled; only a completed one carries a completion, which is the distinction
 * the whole schema exists to keep (CLAUDE.md rule 6).
 */
export default async function PlanPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await requireSessionPage(`/plans/${id}`);
  const { db, today, tz } = maintenanceContext(session.user.id);

  const plan = loadPlanDetail(db, id);
  if (plan === null) notFound();

  const members = loadMembers(db);
  const formKind = plan.rule === null ? null : formKindOf(plan.rule);
  const editable = plan.status !== "cancelled" && formKind !== null;

  return (
    <PageScroll>
      <PageHeader
        eyebrow={
          <Link href="/plans" className="hover:underline">
            Maintenance plans
          </Link>
        }
        title={plan.title}
        description={plan.description ?? plan.ruleText}
        actions={
          plan.status === "cancelled" ? (
            <Badge tone="unknown">Cancelled</Badge>
          ) : plan.status === "paused" ? (
            <Badge tone="unknown">Paused</Badge>
          ) : null
        }
      />

      <Panel title="Where the next date comes from">
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Rule</dt>
            <dd className="mt-0.5 text-ink">{plan.ruleText}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Starting point</dt>
            <dd className="vh-tnum mt-0.5 text-ink">
              {plan.scheduleAnchorDate === null
                ? "Not set"
                : formatDate(plan.scheduleAnchorDate)}
            </dd>
            <dd className="text-xs text-ink-3">{anchorWording(plan.scheduleAnchorSource)}</dd>
            {plan.scheduleAnchorNote !== null ? (
              <dd className="text-xs text-ink-2">“{plan.scheduleAnchorNote}”</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Open task</dt>
            <dd className="vh-tnum mt-0.5">
              {plan.openOccurrence === null ? (
                <span className="text-ink-3">
                  {plan.needsSetup
                    ? "None — the plan is waiting for a starting point."
                    : plan.status === "active"
                      ? "None right now."
                      : "None while paused."}
                </span>
              ) : (
                <Link
                  href={`/tasks/${plan.openOccurrence.id}`}
                  className="text-accent-text hover:underline"
                >
                  {formatDate(plan.openOccurrence.dueDate)} —{" "}
                  {describeDue(plan.openOccurrence.dueDate, today)}
                </Link>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Last recorded completion</dt>
            <dd className="vh-tnum mt-0.5 text-ink">
              {plan.lastCompletedOn === null ? (
                <span className="text-ink-3">
                  None. A starting point from setup is not a completion.
                </span>
              ) : (
                formatDate(plan.lastCompletedOn)
              )}
            </dd>
          </div>
          {plan.target !== null ? (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Attached to</dt>
              <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-ink">
                {plan.target.name}
                {plan.target.context !== null ? (
                  <span className="text-xs text-ink-3">{plan.target.context}</span>
                ) : null}
                <Link
                  href={(plan.target.locateHref) as Route}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Locate in house
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>

        {plan.status === "cancelled" ? (
          <p className="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
            Cancelled
            {plan.cancelledAtMs === null ? "" : ` ${formatInstant(plan.cancelledAtMs, tz)}`}
            {plan.cancelReason === null ? "" : ` — ${plan.cancelReason}`}. Its recorded history is
            kept below.
          </p>
        ) : null}
      </Panel>

      {plan.materials.length > 0 ? (
        <Panel title="Parts this plan requires" flush>
          <ul>
            {plan.materials.map((line) => (
              <li
                key={line.partId}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <span className="text-sm text-ink">
                  {line.partName}
                  {line.isRequired ? "" : " (optional)"}
                </span>
                <span className="vh-tnum text-sm text-ink-2">
                  {formatQty(line.expectedQtyMilli, line.unit)} ·{" "}
                  {formatQty(line.availableMilli, line.unit)} in stock
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Every task this plan has produced"
        flush
        footer={
          plan.occurrences.length === 0
            ? "Nothing generated yet."
            : `${plan.occurrences.length} tasks, newest due date first`
        }
      >
        {plan.occurrences.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-3">
            No tasks yet. One is generated as soon as the plan is active and has a starting point.
          </p>
        ) : (
          <ul>
            {plan.occurrences.map((occurrence) => (
              <li
                key={occurrence.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <span className="vh-tnum flex flex-wrap items-baseline gap-2 text-sm">
                  <Link
                    href={`/tasks/${occurrence.id}`}
                    className="text-ink hover:text-accent-text hover:underline"
                  >
                    {formatDate(occurrence.dueDate)}
                  </Link>
                  {occurrence.originalDueDate !== occurrence.dueDate ? (
                    <span className="text-xs text-ink-3">
                      originally {formatDate(occurrence.originalDueDate)}
                    </span>
                  ) : null}
                  {occurrence.blockedReason !== null ? (
                    <span className="text-xs text-blocked">waiting: {occurrence.blockedReason}</span>
                  ) : null}
                  {occurrence.closeReason !== null ? (
                    <span className="text-xs text-ink-3">{occurrence.closeReason}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2 text-xs">
                  {occurrence.status === "completed" ? (
                    <StatusBadge kind="ok" size="sm" />
                  ) : occurrence.status === "skipped" || occurrence.status === "cancelled" ? (
                    <Badge tone="unknown" size="sm">
                      {STATUS_LABEL[occurrence.status]}
                    </Badge>
                  ) : (
                    <Badge tone="due" size="sm">
                      {STATUS_LABEL[occurrence.status]}
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {editable && formKind !== null && plan.rule !== null ? (
        <>
          <h2 className="mt-2 text-sm font-semibold uppercase tracking-[0.06em] text-ink-3">
            Edit this plan
          </h2>
          <p className="-mt-3 text-sm text-ink-3">
            Changes take effect on the next task. The open task keeps the schedule, materials and
            instructions it was generated with, so nobody’s work changes under them.
          </p>
          <PlanForm
            mode="edit"
            planId={plan.id}
            initial={{
              target:
                plan.assetId !== null
                  ? `asset:${plan.assetId}`
                  : plan.systemId !== null
                    ? `system:${plan.systemId}`
                    : plan.locationId !== null
                      ? `location:${plan.locationId}`
                      : "",
              title: plan.title,
              description: plan.description ?? "",
              procedureId: plan.procedureId ?? "__none__",
              schedule: formStateFromRule(plan.rule),
              assignmentMode: plan.assignmentMode,
              assigneeUserId: plan.assigneeUserId ?? "",
              priority: plan.priority,
              estimatedMinutes:
                plan.estimatedMinutes === null ? "" : String(plan.estimatedMinutes),
              requiresProfessional: plan.requiresProfessional,
              defaultProviderId: plan.defaultProviderId ?? "__none__",
              materials: plan.materials.map((line) => ({
                partId: line.partId,
                qtyMilli: line.expectedQtyMilli,
                isRequired: line.isRequired,
              })),
              status: plan.status === "paused" ? "paused" : "active",
            }}
            targets={searchTargets(db, "", 200)}
            procedures={loadProcedureOptions(db)}
            parts={searchParts(db, "", 200)}
            providers={loadProviders(db).map((provider) => ({
              value: provider.id,
              label: provider.name,
              hint: provider.trade ?? undefined,
            }))}
            members={members.map((member) => ({ id: member.id, name: member.name }))}
            today={today}
            anchorDate={plan.scheduleAnchorDate}
            askSetup={plan.needsSetup}
            canCancel
          />
        </>
      ) : plan.rule === null ? (
        <Panel title="This plan cannot be edited here">
          <p className="text-sm text-ink-2">
            Its stored schedule could not be read, so the form is not offered rather than risking
            overwriting it with a guess.
          </p>
        </Panel>
      ) : formKind === null ? (
        <Panel title="Condition-driven plan">
          <p className="text-sm text-ink-2">
            This plan is driven by a Home Assistant condition rule rather than a calendar, so its
            schedule is edited with the rule under Settings → Home Assistant.
          </p>
        </Panel>
      ) : null}
    </PageScroll>
  );
}

function anchorWording(source: string): string {
  switch (source) {
    case "completion":
      return "The last recorded completion.";
    case "baseline_exact":
      return "A starting point recorded at setup — not a logged completion.";
    case "baseline_approx":
      return "An approximate starting point recorded at setup — not a logged completion, and exact overdue counts are suppressed.";
    case "user_chosen":
      return "A start date chosen at setup.";
    case "skipped_due_date":
      return "The due date of a task that was skipped — no work was recorded.";
    case "install_date":
      return "The equipment's installation date.";
    default:
      return "No starting point recorded, so nothing is generated.";
  }
}
