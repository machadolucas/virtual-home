import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Download, ScrollText } from "lucide-react";
import { requireSessionPage } from "@/server/auth/session";
import { Badge, EmptyState, Panel, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { formatDate, formatInstant, formatMinutes } from "@/features/maintenance/dueDate";
import { formatQty } from "@/features/maintenance/materials";
import { HistoryFilters } from "@/features/maintenance/HistoryFilters";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import {
  loadHistory,
  loadHistoryTargets,
  parseHistoryFilters,
  type HistoryRow,
} from "@/server/queries/maintenance/history";

export const metadata: Metadata = { title: "History" };

const TYPE_BADGE: Record<HistoryRow["type"], { label: string; tone: "ok" | "unknown" | "blocked" | "overdue" }> = {
  completions: { label: "Completed", tone: "ok" },
  voided: { label: "Voided", tone: "overdue" },
  skipped: { label: "Skipped", tone: "unknown" },
  cancelled: { label: "Cancelled", tone: "unknown" },
  bookings: { label: "Booking", tone: "blocked" },
};

/**
 * What was actually done — and, just as importantly, what was *not*.
 *
 * Skips, cancellations and voided completions are rows in the same table as completions, labelled
 * for what they are. That is the whole point: a schedule anchor from setup is not a completion, a
 * booking is not a completion, and a voided completion is a visible correction rather than a
 * deletion (CLAUDE.md rule 6, §5.4).
 */
export default async function HistoryPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await props.searchParams;
  const session = await requireSessionPage("/history");
  const { db, today, tz } = maintenanceContext(session.user.id);

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
    else if (value !== undefined) params.set(key, value);
  }
  const filters = parseHistoryFilters(params);
  const rows = loadHistory(db, filters);
  const targets = loadHistoryTargets(db);
  const members = loadMembers(db);

  return (
    <PageScroll>
      <PageHeader
        eyebrow="Household"
        title="History"
        description="Everything recorded: completions with who, when and what was used — plus the tasks that were skipped, the plans that were cancelled, the bookings that were made, and the completions that were later voided."
        actions={
          <>
            <a
              href="/api/exports/maintenance?format=json"
              className={buttonClasses({ variant: "secondary", size: "sm" })}
            >
              <Download aria-hidden="true" className="size-4" />
              Export JSON
            </a>
            <a
              href="/api/exports/maintenance?format=csv&dataset=completions"
              className={buttonClasses({ variant: "ghost", size: "sm" })}
            >
              Completions CSV
            </a>
          </>
        }
      />

      <HistoryFilters
        targets={targets}
        from={filters.from}
        to={filters.to}
        target={filters.target}
        types={filters.types}
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title={
            targets.length === 0 ? "Nothing recorded yet" : "Nothing matches these filters"
          }
          description={
            targets.length === 0
              ? "The log fills up as tasks are completed, skipped or booked. A starting point set during setup is a scheduling anchor, not a completion, so it deliberately never appears here."
              : "Widen the date range, or turn on more of the row types above."
          }
          bullets={
            targets.length === 0
              ? [
                  "Every completion with who did it, when, the equipment, the parts used and any photo.",
                  "Skipped tasks with their reason — never dressed up as completions.",
                  "Professional bookings, distinguished from the work itself.",
                  "Voided completions, kept visible with the reason they were voided.",
                ]
              : undefined
          }
          note="Rows are written by the task page. This page never creates them."
        />
      ) : (
        <Panel
          title="Recorded"
          flush
          footer={`${rows.length} entries${rows.length === 300 ? " (showing the most recent 300)" : ""}`}
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] border-collapse text-sm">
              <caption className="sr-only">Recorded maintenance history</caption>
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.06em] text-ink-3">
                  <th scope="col" className="px-4 py-2 font-semibold">
                    What
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Date
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Who
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-semibold md:table-cell">
                    Target
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-semibold md:table-cell">
                    Materials
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const badge = TYPE_BADGE[row.type];
                  return (
                    <tr key={`${row.type}-${row.id}`} className="border-b border-line last:border-b-0">
                      <td className="px-4 py-2.5 align-top">
                        <div className="flex flex-col gap-1">
                          <Badge tone={badge.tone} size="sm">
                            {badge.label}
                          </Badge>
                          {row.occurrenceId === null ? (
                            <span className="text-ink">{row.title}</span>
                          ) : (
                            <Link
                              href={`/tasks/${row.occurrenceId}`}
                              className="text-ink hover:text-accent-text hover:underline"
                            >
                              {row.title}
                            </Link>
                          )}
                          {row.isReplacement ? (
                            <span className="text-xs text-ink-3">the unit was replaced</span>
                          ) : null}
                          {row.bookingStatus !== null ? (
                            <span className="text-xs text-ink-3">
                              {row.bookingStatus} — a booking is not a completion
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="vh-tnum px-4 py-2.5 align-top text-ink-2">
                        {row.date === "" ? (
                          <span className="text-ink-3">no date agreed</span>
                        ) : (
                          formatDate(row.date)
                        )}
                        {row.voidedAtMs !== null ? (
                          <span className="block text-xs text-overdue">
                            voided {formatInstant(row.voidedAtMs, tz)}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5 align-top text-ink-2">
                        {row.actorProviderName ??
                          members.find((member) => member.id === row.actorUserId)?.name ??
                          "—"}
                        {row.recordedByUserId !== null &&
                        row.recordedByUserId !== row.actorUserId ? (
                          <span className="block text-xs text-ink-3">
                            logged by{" "}
                            {members.find((member) => member.id === row.recordedByUserId)?.name ??
                              "another member"}
                          </span>
                        ) : null}
                        {formatMinutes(row.effortMinutes) === null ? null : (
                          <span className="vh-tnum block text-xs text-ink-3">
                            {formatMinutes(row.effortMinutes)}
                          </span>
                        )}
                      </td>
                      <td className="hidden px-4 py-2.5 align-top text-ink-2 md:table-cell">
                        {row.target === null ? (
                          "—"
                        ) : (
                          <>
                            {row.target.name}
                            {row.target.context === null ? null : (
                              <span className="block text-xs text-ink-3">{row.target.context}</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="vh-tnum hidden px-4 py-2.5 align-top text-ink-2 md:table-cell">
                        {row.materials.length === 0
                          ? "—"
                          : row.materials.map((line) => (
                              <span key={line.partName} className="block">
                                {line.partName} {formatQty(line.actualQtyMilli, line.unit)}
                                {line.shortfallMilli > 0
                                  ? ` (${line.resolution.replace(/_/g, " ")})`
                                  : ""}
                              </span>
                            ))}
                      </td>
                      <td className="px-4 py-2.5 align-top text-ink-2">
                        {row.voidReason !== null ? (
                          <span className="block text-overdue">{row.voidReason}</span>
                        ) : null}
                        {row.reason !== null ? <span className="block">{row.reason}</span> : null}
                        {row.notes !== null ? <span className="block">{row.notes}</span> : null}
                        {row.photoIds.length > 0 ? (
                          <span className="mt-1 flex flex-wrap gap-1">
                            {row.photoIds.map((photoId) => (
                              <a
                                key={photoId}
                                href={`/api/attachments/${photoId}`}
                                className="block overflow-hidden rounded-xs border border-line focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                <Image
                                  src={`/api/attachments/${photoId}`}
                                  alt="Photo attached to this entry"
                                  width={48}
                                  height={48}
                                  unoptimized
                                  className="size-12 object-cover"
                                />
                              </a>
                            ))}
                          </span>
                        ) : null}
                        {row.voidReason === null &&
                        row.reason === null &&
                        row.notes === null &&
                        row.photoIds.length === 0
                          ? "—"
                          : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <p className="text-xs text-ink-3">
        Exports are the whole record, not this filtered view — the filters here are for reading, and
        an export that silently omitted rows would be a worse file to keep. Each one carries the
        household time zone and the model revision with its coordinate system, so a file opened
        years from now is still interpretable. Today is {formatDate(today)}.
      </p>
    </PageScroll>
  );
}
