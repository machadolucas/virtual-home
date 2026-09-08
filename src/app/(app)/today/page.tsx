import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck, ClipboardList, ListChecks } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { groupToday, ownerBucketLabel } from "@/features/maintenance/grouping";
import { formatDate } from "@/features/maintenance/dueDate";
import { loadMembers, maintenanceContext, partnerOf } from "@/server/queries/maintenance/context";
import { loadMaintenanceHealth } from "@/server/queries/maintenance/status";
import { loadOpenTasks, loadPlansNeedingSetup } from "@/server/queries/maintenance/today";
import { HealthBanner } from "./HealthBanner";
import { TaskRow } from "./TaskRow";

export const metadata: Metadata = { title: "Today" };

/**
 * The one screen that answers "what needs doing?".
 *
 * Sections come from `groupToday` (a pure, tested function) rather than from inline filters, and
 * every count on this page is a count of real rows — there are no derived statistics, no
 * completion percentages and no streaks, because none of those would be honest with two people and
 * a house (`docs/ux.md` §5).
 */
export default async function TodayPage() {
  const session = await requireSessionPage("/today");
  const viewerId = session.user.id;

  const { db, settings, today, tz, nowMs } = maintenanceContext(viewerId);
  const members = loadMembers(db);
  const partner = partnerOf(members, viewerId);
  const tasks = loadOpenTasks(db, today, viewerId);
  const groups = groupToday(tasks, today, viewerId);
  const health = loadMaintenanceHealth(db, nowMs);
  const needsSetup = loadPlansNeedingSetup(db);

  const rowProps = {
    today,
    tz,
    members,
    viewerId,
    maxPostponeDays: settings.maxPostponeDays,
  };

  const attentionBuckets = [
    { bucket: "mine" as const, tasks: groups.needsAttention.mine },
    { bucket: "shared" as const, tasks: groups.needsAttention.shared },
    { bucket: "partner" as const, tasks: groups.needsAttention.partner },
  ].filter((group) => group.tasks.length > 0);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Household"
        title="Today"
        description={`${formatDate(today)}. Overdue and due-today work first, then what is coming, then what is waiting on something.`}
        actions={
          <>
            <Link href="/plans" className={buttonClasses({ variant: "secondary", size: "sm" })}>
              Plans
            </Link>
            <Link href="/procedures" className={buttonClasses({ variant: "ghost", size: "sm" })}>
              Procedures
            </Link>
          </>
        }
      />

      <HealthBanner health={health} tz={tz} />

      {groups.total === 0 ? (
        <EmptyState
          icon={<CalendarCheck />}
          title={
            tasks.length === 0
              ? "Nothing is scheduled in the next 30 days"
              : "Nothing needs doing right now"
          }
          description={
            tasks.length === 0
              ? "This page lists work generated from maintenance plans and from Home Assistant condition rules. Neither has produced anything inside the next 30 days."
              : "Everything open falls outside the next 30 days."
          }
          bullets={[
            "Overdue and due-today work, split into yours, shared, and the other member's.",
            "Anything due inside a week, so nothing arrives as a surprise.",
            "Tasks waiting on a part or on a booked professional, kept separate from work you can actually start.",
            "Battery and other condition alerts, with the reading that triggered them.",
          ]}
          actions={
            <Link href="/plans/new" className={buttonClasses({ variant: "primary" })}>
              Create a maintenance plan
            </Link>
          }
          note="Plans generate one open task at a time; the worker promotes a task to “due” at the household delivery time on its due date."
        />
      ) : null}

      {attentionBuckets.length > 0 ? (
        <Panel
          title="Needs attention"
          subtitle="Overdue or due today."
          flush
          footer={`${attentionBuckets.reduce((sum, group) => sum + group.tasks.length, 0)} open`}
        >
          {attentionBuckets.map((group) => (
            <section key={group.bucket}>
              <h3 className="border-b border-line bg-surface-2 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-3">
                {ownerBucketLabel(group.bucket, partner?.name ?? null)}
              </h3>
              <ul>
                {group.tasks.map((task) => (
                  <TaskRow key={task.id} task={task} {...rowProps} />
                ))}
              </ul>
            </section>
          ))}
        </Panel>
      ) : null}

      {groups.ready.length > 0 ? (
        <Panel title="Ready to do" subtitle="Due inside the next seven days, nothing in the way." flush>
          <ul>
            {groups.ready.map((task) => (
              <TaskRow key={task.id} task={task} {...rowProps} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {groups.condition.length > 0 ? (
        <Panel
          title="Condition alerts"
          subtitle="Raised by a Home Assistant reading crossing its threshold. A reading recovering is not proof that anything was fixed."
          flush
        >
          <ul>
            {groups.condition.map((task) => (
              <TaskRow key={task.id} task={task} {...rowProps} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {groups.blocked.length > 0 ? (
        <Panel
          title="Blocked / waiting"
          subtitle="Waiting on a part or on a professional. Reminders keep running, because waiting is not doing."
          flush
        >
          <ul>
            {groups.blocked.map((task) => (
              <TaskRow key={task.id} task={task} {...rowProps} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {groups.upcoming.length > 0 ? (
        <Panel
          title="Upcoming 30 days"
          subtitle="Nothing to do yet — just so it is not a surprise."
          flush
        >
          <ul>
            {groups.upcoming.map((task) => (
              <TaskRow key={task.id} task={task} {...rowProps} compact />
            ))}
          </ul>
        </Panel>
      ) : null}

      {needsSetup.length > 0 ? (
        <Panel
          title="Plans waiting for a starting point"
          subtitle="Saved with “ask me later”. They generate nothing until someone answers when the work was last done — the app will not guess, because a guess would become fake history."
          flush
        >
          <ul>
            {needsSetup.map((plan) => (
              <li
                key={plan.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{plan.title}</p>
                  <p className="text-xs text-ink-3">
                    {plan.target === null ? "No target" : plan.target.name}
                  </p>
                </div>
                <Link
                  href={`/plans/${plan.id}`}
                  className={buttonClasses({ variant: "secondary", size: "sm" })}
                >
                  Set the starting point
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <p className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
        <ListChecks aria-hidden="true" className="size-3.5" />
        <span>
          Work is generated one task at a time per plan. Completing a task is what moves the
          schedule; snoozing moves only a reminder.
        </span>
        <Link
          href="/history"
          className="inline-flex items-center gap-1 text-accent-text hover:underline"
        >
          <ClipboardList aria-hidden="true" className="size-3.5" />
          What was actually done
        </Link>
      </p>
    </PageScroll>
  );
}
