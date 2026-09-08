/**
 * How `/today` is divided up. Pure, so the whole "which section does this row belong to" decision
 * is unit-tested rather than tangled into JSX.
 *
 * The five sections come straight from what the household actually asks:
 *  - **Needs attention** — overdue or due today, and not blocked. Split by who owns it.
 *  - **Ready to do** — due inside the next 7 days, not blocked.
 *  - **Blocked / waiting** — a supply is missing, or a professional is booked. Blocking wins over
 *    the due date, because doing the task is not currently possible (§3.2: blocking is a
 *    decorator, and a booking is *not* a completion).
 *  - **Condition alerts** — condition-sourced occurrences; they carry a battery reading, so they
 *    get their own section rather than being buried among calendar work.
 *  - **Upcoming 30 days** — everything else that is open and lands inside a month.
 *
 * A closed occurrence never appears in any of them; `sectionFor` returns `null`.
 */
import { compareLocalDate, daysBetweenLocal, type LocalDate } from "@/domain/time";
import type { Priority } from "@/db/schema/maintenance";

/** Days from today that "Ready to do" covers. */
export const READY_HORIZON_DAYS = 7;
/** Days from today that "Upcoming" covers. */
export const UPCOMING_HORIZON_DAYS = 30;

export type TodaySection =
  | "needs_attention"
  | "ready"
  | "blocked"
  | "condition"
  | "upcoming";

/** The fields the grouping reads. Deliberately structural, so queries can widen freely. */
export interface GroupableTask {
  id: string;
  status: "pending" | "due" | "completed" | "skipped" | "cancelled";
  source: "plan" | "manual" | "condition";
  dueDate: LocalDate;
  priority: Priority;
  blockedReason: string | null;
  serviceBookingId: string | null;
  assignmentMode: "user" | "shared";
  assigneeUserId: string | null;
}

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/**
 * `(priority DESC, due_date ASC)` — the sort §3.3 mandates. Ties break on id so two renders of the
 * same data never swap two rows.
 */
export function compareTasks(a: GroupableTask, b: GroupableTask): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  const byDue = compareLocalDate(a.dueDate, b.dueDate);
  if (byDue !== 0) return byDue;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Which section owns a task, or `null` when it is closed or further out than 30 days. */
export function sectionFor(task: GroupableTask, today: LocalDate): TodaySection | null {
  if (task.status !== "pending" && task.status !== "due") return null;

  const blocked = task.blockedReason !== null || task.serviceBookingId !== null;
  const offset = daysBetweenLocal(today, task.dueDate);

  // Condition work is its own section wherever it falls: the row needs the battery reading beside
  // it, and mixing it into the calendar list loses that.
  if (task.source === "condition") return "condition";
  if (blocked) return "blocked";
  if (offset <= 0) return "needs_attention";
  if (offset <= READY_HORIZON_DAYS) return "ready";
  if (offset <= UPCOMING_HORIZON_DAYS) return "upcoming";
  return null;
}

export type OwnerBucket = "mine" | "shared" | "partner";

/**
 * Who a task belongs to, from `viewerId`'s point of view. `shared` means both members: the app has
 * no roles, so "shared" is a real third state and not an absence of assignment.
 */
export function ownerBucket(task: GroupableTask, viewerId: string): OwnerBucket {
  if (task.assignmentMode === "shared" || task.assigneeUserId === null) return "shared";
  return task.assigneeUserId === viewerId ? "mine" : "partner";
}

export interface NeedsAttentionGroups<T> {
  mine: T[];
  shared: T[];
  partner: T[];
}

export interface TodayGroups<T> {
  needsAttention: NeedsAttentionGroups<T>;
  ready: T[];
  blocked: T[];
  condition: T[];
  upcoming: T[];
  /** Total open rows placed in any section — for honest "nothing to do" copy. */
  total: number;
}

/**
 * Split `tasks` into the five sections, each sorted by urgency. "Needs attention" is further split
 * into mine / shared / partner's, in that order.
 */
export function groupToday<T extends GroupableTask>(
  tasks: readonly T[],
  today: LocalDate,
  viewerId: string,
): TodayGroups<T> {
  const groups: TodayGroups<T> = {
    needsAttention: { mine: [], shared: [], partner: [] },
    ready: [],
    blocked: [],
    condition: [],
    upcoming: [],
    total: 0,
  };

  for (const task of tasks) {
    const section = sectionFor(task, today);
    if (section === null) continue;
    groups.total += 1;
    switch (section) {
      case "needs_attention":
        groups.needsAttention[ownerBucket(task, viewerId)].push(task);
        break;
      case "ready":
        groups.ready.push(task);
        break;
      case "blocked":
        groups.blocked.push(task);
        break;
      case "condition":
        groups.condition.push(task);
        break;
      case "upcoming":
        groups.upcoming.push(task);
        break;
    }
  }

  groups.needsAttention.mine.sort(compareTasks);
  groups.needsAttention.shared.sort(compareTasks);
  groups.needsAttention.partner.sort(compareTasks);
  groups.ready.sort(compareTasks);
  groups.blocked.sort(compareTasks);
  groups.condition.sort(compareTasks);
  groups.upcoming.sort(compareTasks);
  return groups;
}

/** Human label for a bucket, given the partner's display name (which may be unknown). */
export function ownerBucketLabel(bucket: OwnerBucket, partnerName: string | null): string {
  switch (bucket) {
    case "mine":
      return "Yours";
    case "shared":
      return "Shared";
    case "partner":
      return partnerName === null ? "Assigned to the other member" : `${partnerName}'s`;
  }
}
