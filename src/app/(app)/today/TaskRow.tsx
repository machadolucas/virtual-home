import Link from "next/link";
import { BatteryLow, HardHat, MapPin } from "lucide-react";
import { Avatar, Badge, StatusDot } from "@/ui";
import { addDaysLocal, type LocalDate } from "@/domain/time";
import {
  describeDue,
  describeWindow,
  formatDate,
  formatInstant,
  formatMinutes,
  occurrenceStatusKind,
} from "@/features/maintenance/dueDate";
import { TaskQuickActions } from "@/features/maintenance/TaskActions";
import type { TaskRow as TaskRowData } from "@/server/queries/maintenance/today";
import type { HouseholdMember } from "@/server/queries/maintenance/context";

const PRIORITY_LABEL = {
  urgent: "Urgent",
  high: "High",
  normal: null,
  low: "Low",
} as const;

export interface TaskRowProps {
  task: TaskRowData;
  today: LocalDate;
  tz: string;
  members: readonly HouseholdMember[];
  viewerId: string;
  maxPostponeDays: number;
  /** Rows in "Upcoming" get quieter chrome and no quick actions. */
  compact?: boolean;
}

/**
 * One task, on Today.
 *
 * The row carries five things and no more: what it is, what it is attached to, when it is due (in
 * both relative and absolute wording, because "in 12 days" and "20 Sep" answer different
 * questions), who owns it, and the two actions that do not require a decision.
 */
export function TaskRow({
  task,
  today,
  tz,
  members,
  viewerId,
  maxPostponeDays,
  compact = false,
}: TaskRowProps) {
  const kind = occurrenceStatusKind(task, today);
  const assignees =
    task.assignmentMode === "shared"
      ? members
      : members.filter((member) => member.id === task.assigneeUserId);
  const window = describeWindow(task.windowStartDate, task.windowEndDate, today);
  const priority = PRIORITY_LABEL[task.priority];
  const canSnooze =
    task.assignmentMode === "shared" || task.assigneeUserId === viewerId || task.assigneeUserId === null;

  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <StatusDot kind={kind} label={null} className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <Link
              href={`/tasks/${task.id}`}
              className="text-sm font-medium text-ink hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {task.title}
            </Link>
            {priority !== null ? (
              <Badge tone={task.priority === "low" ? "neutral" : "due"} icon={null} size="sm">
                {priority}
              </Badge>
            ) : null}
            {task.source === "condition" ? (
              <Badge tone="blocked" icon={<BatteryLow aria-hidden="true" />} size="sm">
                Condition alert
              </Badge>
            ) : null}
            {task.requiresProfessional ? (
              <Badge tone="neutral" icon={<HardHat aria-hidden="true" />} size="sm">
                Professional
              </Badge>
            ) : null}
          </div>

          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-3">
            {task.target === null ? (
              <span>No target recorded</span>
            ) : (
              <>
                <span className="text-ink-2">{task.target.name}</span>
                {task.target.context !== null ? <span>{task.target.context}</span> : null}
                {task.target.locatable ? (
                  <Link
                    href={task.target.locateHref}
                    className="inline-flex items-center gap-1 text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <MapPin aria-hidden="true" className="size-3" />
                    Locate
                  </Link>
                ) : null}
              </>
            )}
          </p>

          <p className="vh-tnum mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
            <span className={kind === "overdue" ? "font-medium text-overdue" : "text-ink-2"}>
              {describeDue(task.dueDate, today, { approximate: task.approximateAnchor })}
            </span>
            <span className="text-ink-3">{formatDate(task.dueDate)}</span>
            {task.originalDueDate !== task.dueDate ? (
              <span className="text-ink-3">originally {formatDate(task.originalDueDate)}</span>
            ) : null}
            {formatMinutes(task.estimatedMinutes) !== null ? (
              <span className="text-ink-3">{formatMinutes(task.estimatedMinutes)}</span>
            ) : null}
          </p>

          {window !== null ? (
            <p className="mt-1 text-xs text-ink-3">
              Window {window.label}
              {window.closed ? " — the window has closed; completing it late still counts." : ""}
            </p>
          ) : null}

          {task.blockedReason !== null ? (
            <p className="mt-1 text-xs text-blocked">Waiting: {task.blockedReason}</p>
          ) : null}

          {task.booking !== null ? (
            <p className="mt-1 text-xs text-blocked">
              {task.booking.providerName} booked
              {task.booking.scheduledLocalDate === null
                ? " (date not agreed)"
                : ` for ${formatDate(task.booking.scheduledLocalDate)}`}
              {task.booking.windowNote === null ? "" : `, ${task.booking.windowNote}`} — a booking is
              not a completion.
            </p>
          ) : null}

          {task.condition !== null ? (
            <p className="vh-tnum mt-1 text-xs text-ink-3">
              {task.condition.latestValid && task.condition.latestValue !== null
                ? `Latest reading ${task.condition.latestValue} %`
                : "No usable reading"}
              {task.condition.thresholdPct === null
                ? ""
                : ` · threshold ${task.condition.thresholdPct} %`}
              {task.condition.stale ? " · reading is stale" : ""}
              {task.condition.recovered ? " · reading recovered, still open" : ""}
            </p>
          ) : null}

          {task.missedSeriesDates.length > 0 ? (
            <p className="mt-1 text-xs text-ink-3">
              {task.missedSeriesDates.length} scheduled{" "}
              {task.missedSeriesDates.length === 1 ? "date" : "dates"} passed while this stayed open
              ({task.missedSeriesDates.map((date) => formatDate(date)).join(", ")}). No work was
              recorded for them.
            </p>
          ) : null}

          {task.viewerSnoozedUntilMs !== null ? (
            <p className="mt-1 text-xs text-ink-3">
              Your reminder is snoozed until {formatInstant(task.viewerSnoozedUntilMs, tz)}.
            </p>
          ) : null}
        </div>

        {assignees.length > 0 ? (
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
        ) : null}
      </div>

      {compact ? null : (
        <div className="pl-8">
          <TaskQuickActions
            occurrenceId={task.id}
            dueDate={task.dueDate}
            originalDueDate={task.originalDueDate}
            today={today}
            limitDate={addDaysLocal(task.originalDueDate, maxPostponeDays)}
            canSnooze={canSnooze}
          />
        </div>
      )}
    </li>
  );
}
