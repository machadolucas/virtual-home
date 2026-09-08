import { Panel } from "@/ui";
import type { OccurrenceEventKind } from "@/db/schema/maintenance";
import { formatDate, formatInstant } from "@/features/maintenance/dueDate";
import type { HouseholdMember } from "@/server/queries/maintenance/context";
import type { HistoryEntry, TaskEvent } from "@/server/queries/maintenance/task";
import { formatQty } from "@/features/maintenance/materials";

/**
 * Wording for the typed domain timeline (`occurrence_event`).
 *
 * The distinctions here are the whole point of having a typed event table: a snooze reads as a
 * reminder move, a skip reads as "closed without doing it", a booking reads as an appointment, and
 * only `completed` reads as work having happened.
 */
const EVENT_TEXT: Record<OccurrenceEventKind, string> = {
  created: "Task created",
  became_due: "Became due",
  completed: "Recorded as done",
  completion_voided: "Completion voided",
  postponed: "Due date moved",
  snoozed: "Reminder snoozed",
  skipped: "Closed without doing it",
  cancelled: "Cancelled",
  blocked: "Marked as waiting",
  unblocked: "No longer waiting",
  booked: "Professional booked",
  booking_cancelled: "Booking cancelled",
  reopened: "Reopened",
  notified: "Reminder sent",
  condition_recovered: "Reading recovered — still open",
  materials_reconciled: "Stock reconciled",
};

export function Timeline({
  events,
  members,
  tz,
}: {
  events: readonly TaskEvent[];
  members: readonly HouseholdMember[];
  tz: string;
}) {
  if (events.length === 0) {
    return (
      <Panel title="What has happened to this task">
        <p className="text-sm text-ink-3">
          Nothing has been recorded against this task yet — not even its creation event, which means
          it predates the timeline or was written directly.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="What has happened to this task" flush>
      <ol>
        {events.map((event) => (
          <li key={event.id} className="border-b border-line px-4 py-2.5 last:border-b-0">
            <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium text-ink">{EVENT_TEXT[event.kind]}</span>
              <span className="vh-tnum text-xs text-ink-3">{formatInstant(event.atMs, tz)}</span>
              <span className="text-xs text-ink-3">{actorText(event, members)}</span>
            </p>
            {event.fromDueDate !== null && event.toDueDate !== null ? (
              <p className="vh-tnum text-xs text-ink-2">
                {formatDate(event.fromDueDate)} → {formatDate(event.toDueDate)}
              </p>
            ) : null}
            {event.reason !== null ? (
              <p className="text-xs text-ink-2">{event.reason}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function actorText(event: TaskEvent, members: readonly HouseholdMember[]): string {
  if (event.actorKind === "worker") return "by the background service";
  if (event.actorKind === "ha") return "from Home Assistant";
  if (event.actorKind === "system") return "by the system";
  const name = members.find((member) => member.id === event.actorUserId)?.name;
  return name === undefined ? "" : `by ${name}`;
}

/**
 * The history of this plan (or, for ad-hoc work, this asset).
 *
 * Voided completions are shown as voided rather than hidden, and skips are shown as skips — the
 * two things that must never be mistaken for a completion.
 */
export function PlanHistory({
  entries,
  members,
  tz,
}: {
  entries: readonly HistoryEntry[];
  members: readonly HouseholdMember[];
  tz: string;
}) {
  if (entries.length === 0) {
    return (
      <Panel title="Earlier work on this">
        <p className="text-sm text-ink-3">
          Nothing recorded yet. A starting point set during setup is a scheduling anchor, not a
          completion, so it deliberately does not appear here.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Earlier work on this" flush footer={`${entries.length} entries, newest first`}>
      <ol>
        {entries.map((entry) => (
          <li
            key={entry.kind === "completion" ? entry.completion.id : entry.occurrenceId}
            className="border-b border-line px-4 py-3 last:border-b-0"
          >
            {entry.kind === "completion" ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span
                    className={
                      entry.completion.voidedAtMs === null
                        ? "font-medium text-ink"
                        : "font-medium text-ink-3 line-through"
                    }
                  >
                    Done {formatDate(entry.date)}
                  </span>
                  <span className="text-xs text-ink-3">
                    {entry.completion.performedByProviderName ??
                      members.find((m) => m.id === entry.completion.performedByUserId)?.name ??
                      "unknown"}
                  </span>
                  {entry.completion.isReplacement ? (
                    <span className="text-xs text-ink-2">unit replaced</span>
                  ) : null}
                </p>
                {entry.completion.voidedAtMs !== null ? (
                  <p className="text-xs text-overdue">
                    Voided {formatInstant(entry.completion.voidedAtMs, tz)}
                    {entry.completion.voidReason === null
                      ? ""
                      : ` — ${entry.completion.voidReason}`}
                  </p>
                ) : null}
                {entry.completion.materials.length > 0 ? (
                  <p className="vh-tnum mt-0.5 text-xs text-ink-3">
                    {entry.completion.materials
                      .map((line) => `${line.partName} ${formatQty(line.actualQtyMilli, line.unit)}`)
                      .join(" · ")}
                  </p>
                ) : null}
                {entry.completion.notes !== null ? (
                  <p className="mt-0.5 text-xs text-ink-2">{entry.completion.notes}</p>
                ) : null}
              </>
            ) : (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium text-ink-2">
                    {entry.status === "cancelled" ? "Cancelled" : "Skipped"}
                  </span>
                  <span className="vh-tnum text-xs text-ink-3">
                    was due {formatDate(entry.dueDate)}
                  </span>
                </p>
                <p className="text-xs text-ink-3">
                  {entry.reason ?? "No reason recorded"} — no work was recorded.
                </p>
              </>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
