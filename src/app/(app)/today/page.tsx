import type { Route } from "next";
import { Relationships } from "./Relationships";
import { belongsToScope, inTodayQueue, TODAY_QUEUES, type TodayQueue } from "@/features/maintenance/todayFilters";
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
export default async function TodayPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  const session = await requireSessionPage("/today");
  const viewerId = session.user.id;

  const { db, settings, today, tz, nowMs } = maintenanceContext(viewerId);
  const members = loadMembers(db);
  const partner = partnerOf(members, viewerId);
  const tasks = loadOpenTasks(db, today, viewerId);
  const params = await searchParams ?? {};
  const rawQueue = typeof params.queue === "string" ? params.queue : "all";
  const queue: TodayQueue = TODAY_QUEUES.includes(rawQueue as TodayQueue) ? rawQueue as TodayQueue : "all";
  const mine = params.scope === "mine";
  const scoped = tasks.filter(task => belongsToScope(task, viewerId, mine));
  const groups = groupToday(scoped.filter(task => inTodayQueue(task, today, queue)), today, viewerId);
  const queueLabels = { all: "All work", attention: "Needs action", upcoming: "Upcoming", waiting: "Waiting" };
  const href = (nextQueue: TodayQueue, nextMine: boolean) => `/today?queue=${nextQueue}&scope=${nextMine ? "mine" : "all"}` as Route;
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
        description={`${formatDate(today)} · Your house, its records and the work ahead.`}
        actions={
          <>
            <Link href="/plans/new" className={buttonClasses({ variant: "primary", size: "sm" })}>
              Add work
            </Link>
            <Link href="/procedures" className={buttonClasses({ variant: "ghost", size: "sm" })}>
              Procedures
            </Link>
          </>
        }
      />

      <Relationships/>
      <HealthBanner health={health} tz={tz} />
      <section aria-label="Work filters" id="work" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="work-queue" className="text-lg font-semibold">Work queue</h2><nav aria-label="Whose work" className="flex gap-2">{[{ label: "Everyone", mine: false }, { label: "Mine and shared", mine: true }].map(item => <Link key={item.label} href={href(queue, item.mine)} aria-current={mine === item.mine ? "page" : undefined} className={buttonClasses({ variant: mine === item.mine ? "secondary" : "ghost", size: "sm" })}>{item.label}</Link>)}</nav></div>
        <nav aria-label="Work status" className="flex flex-wrap gap-2">{TODAY_QUEUES.map(item => <Link key={item} href={href(item, mine)} aria-current={queue === item ? "page" : undefined} className={buttonClasses({ variant: queue === item ? "secondary" : "ghost", size: "sm" })}>{queueLabels[item]} <span className="text-ink-3">{scoped.filter(task => inTodayQueue(task, today, item)).length}</span></Link>)}</nav>
      </section>

      {groups.total === 0 ? <EmptyState icon={<CalendarCheck/>} title="No work in this view" description={tasks.length === 0 ? "Nothing is scheduled in the next 30 days. Add work when you need it." : "Try another work filter or include everyone."} actions={tasks.length === 0 ? <Link href="/plans/new" className={buttonClasses({ variant: "primary" })}>Add work</Link> : <Link href="/today" className={buttonClasses({ variant: "secondary" })}>Show all work</Link>}/> : null}

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
          subtitle="Choose a starting date to begin scheduling work."
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
          Completed work stays in your history.
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
