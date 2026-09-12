import type { Route } from "next";

import { AddToProject } from "@/features/projects/AddToProject";
import { DocumentLink } from "@/features/documents/DocumentViewer";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, FileText, HardHat, MapPin } from "lucide-react";
import { Avatar, Badge, Panel, StatusBadge, buttonClasses } from "@/ui";
import { PageHeader, PageScroll } from "@/ui/shell";
import { requireSessionPage } from "@/server/auth/session";
import { addDaysLocal, localTimeOf } from "@/domain/time";
import {
  describeDue,
  describeWindow,
  formatDate,
  formatInstant,
  formatMinutes,
  occurrenceStatusKind,
} from "@/features/maintenance/dueDate";
import { BookingControls } from "@/features/maintenance/BookingControls";
import { ConditionChoices } from "@/features/maintenance/ConditionChoices";
import { PhotoUploader } from "@/features/maintenance/PhotoUploader";
import { ProcedureRunner } from "@/features/maintenance/ProcedureRunner";
import { ReassignControl, ReopenButton } from "@/features/maintenance/TaskActions";
import { TaskActionBar } from "@/features/maintenance/TaskActionBar";
import { VoidCompletionButton } from "@/features/maintenance/VoidDialog";
import { formatQty } from "@/features/maintenance/materials";
import { loadMembers, maintenanceContext } from "@/server/queries/maintenance/context";
import { loadProviders } from "@/server/queries/maintenance/plans";
import { loadTaskDetail } from "@/server/queries/maintenance/task";
import { MaterialsPanel } from "./MaterialsPanel";
import { PlanHistory, Timeline } from "./Timeline";

export const metadata: Metadata = { title: "Task" };

/**
 * The task page — and on a phone, *the* screen: instructions, materials, photos, completion.
 *
 * Three things are deliberate about the layout:
 *  - the instructions come from the occurrence's frozen procedure version, never from the
 *    procedure's current one;
 *  - the actions live in a sticky bottom bar, because that is where a thumb is while the other
 *    hand is holding a filter;
 *  - "Complete…" opens a dialog. A task is never completed by a single tap, because a completion
 *    is a factual claim about who did what, when, with which parts.
 */
export default async function TaskPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await requireSessionPage(`/tasks/${id}`);
  const viewerId = session.user.id;

  const { db, settings, today, tz } = maintenanceContext(viewerId);
  const task = loadTaskDetail(db, id);
  if (task === null) notFound();

  const members = loadMembers(db);
  const providers = loadProviders(db);
  const kind = occurrenceStatusKind(task, today);
  const open = task.status === "pending" || task.status === "due";
  const window = describeWindow(task.windowStartDate, task.windowEndDate, today);
  const assignees =
    task.assignmentMode === "shared"
      ? members
      : members.filter((member) => member.id === task.assigneeUserId);
  const canSnooze =
    task.assignmentMode === "shared" ||
    task.assigneeUserId === viewerId ||
    task.assigneeUserId === null;

  const completeProps = {
    title: task.title,
    dueDate: task.dueDate,
    today,
    viewerId,
    members: members.map((member) => ({ id: member.id, name: member.name })),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      trade: provider.trade,
    })),
    materials: task.materials,
    estimatedMinutes: task.estimatedMinutes,
    assetName: task.target?.kind === "asset" ? task.target.name : null,
  };

  return (
    <PageScroll>
      <PageHeader
        eyebrow={
          task.plan === null ? (
            "Ad-hoc task"
          ) : (
            <Link href={`/plans/${task.plan.id}`} className="hover:underline">
              {task.plan.title}
            </Link>
          )
        }
        title={task.title}
        description={task.description ?? undefined}
        actions={<StatusBadge kind={kind} />}
      />

      <div className="flex justify-end"><AddToProject entityKind="occurrence" entityId={task.id} /></div>
      <Panel>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Due</dt>
            <dd className="vh-tnum mt-0.5 text-ink">
              {formatDate(task.dueDate)}
              <span className={kind === "overdue" ? "ml-2 text-overdue" : "ml-2 text-ink-3"}>
                {describeDue(task.dueDate, today, { approximate: task.approximateAnchor })}
              </span>
            </dd>
            {task.originalDueDate !== task.dueDate ? (
              <dd className="vh-tnum text-xs text-ink-3">
                Originally due {formatDate(task.originalDueDate)} — postponed, not rescheduled: the
                plan’s interval is unchanged.
              </dd>
            ) : null}
            {task.approximateAnchor ? (
              <dd className="text-xs text-ink-3">
                The schedule was started from an approximate date, so exact overdue counts are not
                shown.
              </dd>
            ) : null}
          </div>

          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Assigned to</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              {assignees.length === 0 ? (
                <span className="text-ink-3">Nobody</span>
              ) : (
                assignees.map((member) => (
                  <span key={member.id} className="flex items-center gap-1.5 text-ink">
                    <Avatar name={member.name} color={member.displayColor} size="xs" />
                    {member.name}
                  </span>
                ))
              )}
              {task.assignmentMode === "shared" ? (
                <Badge tone="neutral" icon={null} size="sm">
                  Shared
                </Badge>
              ) : null}
            </dd>
            {open ? (
              <dd className="mt-1.5">
                <ReassignControl
                  occurrenceId={task.id}
                  assignmentMode={task.assignmentMode}
                  assigneeUserId={task.assigneeUserId}
                  members={completeProps.members}
                />
                <span className="mt-1 block text-xs text-ink-3">
                  Changes this task only — the plan’s own assignment is edited on the plan page.
                </span>
              </dd>
            ) : null}
          </div>

          <div>
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Priority and effort</dt>
            <dd className="mt-0.5 text-ink">
              {task.priority === "normal" ? "Normal priority" : `${task.priority} priority`}
              {formatMinutes(task.estimatedMinutes) === null
                ? ""
                : ` · about ${formatMinutes(task.estimatedMinutes)}`}
            </dd>
          </div>

          <div className="sm:col-span-2 lg:col-span-2">
            <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">What it is attached to</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2 text-ink">
              {task.target === null ? (
                <span className="text-ink-3">No target recorded</span>
              ) : (
                <>
                  <span>{task.target.name}</span>
                  {task.target.context !== null ? (
                    <span className="text-xs text-ink-3">{task.target.context}</span>
                  ) : null}
                  <Link
                    href={(task.target.locateHref) as Route}
                    className={buttonClasses({ variant: "secondary", size: "sm" })}
                  >
                    <MapPin aria-hidden="true" className="size-3.5" />
                    Locate in house
                  </Link>
                  {task.target.locatable ? null : (
                    <span className="text-xs text-ink-3">
                      Not placed in the model yet, so the house view will not highlight it.
                    </span>
                  )}
                </>
              )}
            </dd>
          </div>

          {task.plan !== null ? (
            <div>
              <dt className="text-xs uppercase tracking-[0.06em] text-ink-3">Schedule</dt>
              <dd className="mt-0.5 text-ink">{task.plan.ruleText}</dd>
              <dd className="vh-tnum text-xs text-ink-3">
                {task.plan.scheduleAnchorDate === null
                  ? "No starting point recorded."
                  : `Measured from ${formatDate(task.plan.scheduleAnchorDate)} (${anchorWording(task.plan.scheduleAnchorSource)}).`}
              </dd>
            </div>
          ) : null}
        </dl>

        {task.blockedReason !== null ? (
          <p className="mt-4 rounded-md border border-blocked/45 bg-blocked-soft px-3 py-2 text-sm text-blocked">
            Waiting: {task.blockedReason}
            {task.blockedAtMs === null ? "" : ` (since ${formatInstant(task.blockedAtMs, tz)})`}.
            Reminders are still running — being blocked is not being done.
          </p>
        ) : null}

        {task.booking !== null ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-blocked/45 bg-blocked-soft px-3 py-2 text-sm text-blocked">
            <HardHat aria-hidden="true" className="size-4" />
            <span>
              <Link href={`/providers/${task.booking.providerId}`} className="underline">{task.booking.providerName}</Link> is booked
              {task.booking.scheduledLocalDate === null
                ? " (no date agreed yet)"
                : ` for ${formatDate(task.booking.scheduledLocalDate)}`}
              {task.booking.windowNote === null ? "" : `, ${task.booking.windowNote}`}
              {task.booking.reference === null ? "" : ` · ref ${task.booking.reference}`}. Booking is
              not completion: this task stays open until somebody records what was done.
            </span>
            {/* Appointments move, and the action bar hides "Book a professional" as soon as one
                exists — so without this control the first booking somebody typed was the only one
                the task could ever have. */}
            {open ? (
              <span className="ms-auto">
                <BookingControls
                  occurrenceId={task.id}
                  bookingId={task.booking.id}
                  providerId={task.booking.providerId}
                  providers={[...providers.map((p) => ({ value: p.id, label: p.name, hint: p.trade ?? undefined })), ...(task.booking.providerId && !providers.some((p) => p.id === task.booking?.providerId) ? [{ value: task.booking.providerId, label: task.booking.providerName, hint: "Archived · existing booking" }] : [])]}
                  startTime={task.booking.scheduledStartMs == null ? "" : localTimeOf(task.booking.scheduledStartMs, tz)}
                  endTime={task.booking.scheduledEndMs == null ? "" : localTimeOf(task.booking.scheduledEndMs, tz)}
                  contactNote={task.booking.contactNote}
                  status={task.booking.status}
                  scheduledLocalDate={task.booking.scheduledLocalDate}
                  windowNote={task.booking.windowNote}
                  reference={task.booking.reference}
                />
              </span>
            ) : null}
          </div>
        ) : null}

        {window !== null ? (
          <p className="mt-3 text-sm text-ink-2">
            This task belongs to a season: {window.label}.
            {window.closed
              ? " The window has closed. The task stays open, and completing it late still satisfies this year."
              : ""}
          </p>
        ) : null}

        {task.missedSeriesDates.length > 0 ? (
          <p className="mt-3 text-sm text-ink-2">
            {task.missedSeriesDates.length} scheduled{" "}
            {task.missedSeriesDates.length === 1 ? "date" : "dates"} passed while this stayed open:{" "}
            {task.missedSeriesDates.map((date) => formatDate(date)).join(", ")}. Nothing was recorded
            as done for them.
          </p>
        ) : null}
      </Panel>

      {task.condition !== null && task.condition.recovered && open ? (
        <ConditionChoices
          occurrenceId={task.id}
          openedValue={task.condition.openedValue}
          latestValue={task.condition.latestValue}
          latestValid={task.condition.latestValid}
          entityId={task.condition.entityId}
          complete={completeProps}
        />
      ) : null}

      {task.condition !== null && !task.condition.recovered ? (
        <Panel title="Why this task exists" subtitle={task.condition.ruleName}>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-ink-3">Reading when it opened</dt>
              <dd className="vh-tnum text-ink">
                {task.condition.openedValue === null
                  ? "Not recorded"
                  : `${task.condition.openedValue} %`}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Latest reading</dt>
              <dd className="vh-tnum text-ink">
                {task.condition.latestValid && task.condition.latestValue !== null
                  ? `${task.condition.latestValue} %`
                  : "No usable reading"}
                {task.condition.stale ? " (stale)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Threshold</dt>
              <dd className="vh-tnum text-ink">
                {task.condition.thresholdPct === null
                  ? "Household default"
                  : `${task.condition.thresholdPct} %`}
              </dd>
            </div>
          </dl>
          {task.condition.entityId !== null ? (
            <p className="mt-2 font-mono text-xs text-ink-3">{task.condition.entityId}</p>
          ) : null}
        </Panel>
      ) : null}

      {task.procedure !== null ? (
        <ProcedureRunner
          occurrenceId={task.id}
          procedureTitle={task.procedure.procedureTitle}
          version={task.procedure.version}
          versionStatus={task.procedure.status}
          prerequisites={task.procedure.prerequisites}
          safetyNotes={task.procedure.safetyNotes}
          steps={task.procedure.steps}
          looseChecklist={task.procedure.looseChecklist}
          tools={task.procedure.tools}
          progress={task.progress}
          readOnly={!open}
        />
      ) : (
        <Panel title="Instructions">
          <p className="text-sm text-ink-3">
            No procedure is attached to this task.
            {task.plan === null
              ? " Ad-hoc work often does not need one."
              : " Attach one to the plan if this is something worth writing down."}
          </p>
          {task.plan !== null ? (
            <div className="mt-3">
              <Link
                href={`/plans/${task.plan.id}`}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Edit the plan
              </Link>
            </div>
          ) : null}
        </Panel>
      )}

      {task.procedure !== null && task.procedure.references.length > 0 ? (
        <Panel title="References" flush>
          <ul>
            {task.procedure.references.map((reference) => (
              <li
                key={reference.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <span className="text-sm text-ink">
                  {reference.label}
                  {reference.manualName === null ? "" : ` — ${reference.manualName}`}
                  {reference.pageFrom === null
                    ? ""
                    : `, p. ${reference.pageFrom}${reference.pageTo === null ? "" : `–${reference.pageTo}`}`}
                </span>
                {reference.attachmentId !== null ? (
                  <DocumentLink document={{id:reference.attachmentId}}
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    <FileText aria-hidden="true" className="size-3.5" />
                    Open
                  </DocumentLink>
                ) : reference.url !== null ? (
                  <a
                    href={reference.url}
                    rel="noreferrer noopener"
                    target="_blank"
                    className={buttonClasses({ variant: "ghost", size: "sm" })}
                  >
                    <ExternalLink aria-hidden="true" className="size-3.5" />
                    Open link
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {task.procedure !== null && task.procedure.equipmentNotes.length > 0 ? (
        <Panel title="Notes about this equipment">
          <ul className="flex flex-col gap-2 text-sm text-ink-2">
            {task.procedure.equipmentNotes.map((note) => (
              <li key={note.id}>
                {note.assetModelName === null ? "" : `${note.assetModelName}: `}
                {note.note}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <MaterialsPanel
        occurrenceId={task.id}
        materials={task.materials}
        open={open}
        blocked={task.blockedReason !== null}
      />

      <PhotoUploader
        occurrenceId={task.id}
        scope={task.completionId === null ? "occurrence" : "completion"}
        entityId={task.completionId ?? task.id}
        photos={task.photos}
        readOnly={!open && task.completionId === null}
      />

      {task.liveCompletion !== null ? (
        <div id={`completion-${task.liveCompletion.id}`}><div className="flex justify-end"><AddToProject entityKind="completion" entityId={task.liveCompletion.id} /></div><Panel
          title={
            task.liveCompletion.voidedAtMs === null
              ? "Recorded as done"
              : "Recorded as done, then voided"
          }
          subtitle={
            task.liveCompletion.voidedAtMs === null
              ? undefined
              : "Kept on purpose: a void is a visible correction, not a deletion."
          }
          actions={
            task.liveCompletion.voidedAtMs === null ? (
              <VoidCompletionButton
                completionId={task.liveCompletion.id}
                occurrenceId={task.id}
                completedLocalDate={task.liveCompletion.completedLocalDate}
                successorDueDate={null}
              />
            ) : null
          }
        >
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-3">When</dt>
              <dd className="vh-tnum text-ink">
                {formatDate(task.liveCompletion.completedLocalDate)}
                {task.liveCompletion.precision === "exact"
                  ? ` · ${formatInstant(task.liveCompletion.completedAtMs, tz)}`
                  : task.liveCompletion.precision === "day"
                    ? " · that day"
                    : " · sometime that month"}
              </dd>
            </div>
            <div>
              <dt className="text-ink-3">Who</dt>
              <dd className="text-ink">
                {task.liveCompletion.performedByProviderName ??
                  members.find((m) => m.id === task.liveCompletion?.performedByUserId)?.name ??
                  "Not recorded"}
                {task.liveCompletion.recordedBy !== null &&
                task.liveCompletion.recordedBy !== task.liveCompletion.performedByUserId
                  ? ` · logged by ${members.find((m) => m.id === task.liveCompletion?.recordedBy)?.name ?? "another member"}`
                  : ""}
              </dd>
            </div>
            {task.liveCompletion.effortMinutes !== null ? (
              <div>
                <dt className="text-ink-3">Effort</dt>
                <dd className="vh-tnum text-ink">
                  {formatMinutes(task.liveCompletion.effortMinutes)}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-ink-3">Outcome</dt>
              <dd className="text-ink">
                {task.liveCompletion.outcome === "done"
                  ? "Done"
                  : task.liveCompletion.outcome === "done_with_issues"
                    ? "Done, with something to watch"
                    : "Partly done"}
                {task.liveCompletion.stockResolution === "none" ||
                task.liveCompletion.stockResolution === "sufficient"
                  ? ""
                  : ` · stock: ${task.liveCompletion.stockResolution.replace(/_/g, " ")}`}
              </dd>
            </div>
            {task.liveCompletion.voidedAtMs !== null ? (
              <div className="sm:col-span-2">
                <dt className="text-ink-3">Voided</dt>
                <dd className="text-overdue">
                  {formatInstant(task.liveCompletion.voidedAtMs, tz)}
                  {task.liveCompletion.voidReason === null
                    ? ""
                    : ` — ${task.liveCompletion.voidReason}`}
                </dd>
              </div>
            ) : null}
          </dl>

          {task.liveCompletion.materials.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-ink-2">
              {task.liveCompletion.materials.map((line) => (
                <li key={line.partId} className="vh-tnum">
                  {line.partName}: {formatQty(line.actualQtyMilli, line.unit)}
                  {line.expectedQtyMilli === null || line.expectedQtyMilli === line.actualQtyMilli
                    ? ""
                    : ` (expected ${formatQty(line.expectedQtyMilli, line.unit)})`}
                  {line.shortfallMilli > 0
                    ? ` · ${formatQty(line.shortfallMilli, line.unit)} short, ${line.resolution.replace(/_/g, " ")}`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}

          {task.liveCompletion.notes !== null ? (
            <p className="mt-3 whitespace-pre-wrap text-sm text-ink-2">
              {task.liveCompletion.notes}
            </p>
          ) : null}
        </Panel></div>
      ) : null}

      <Timeline events={task.events} members={members} tz={tz} />
      <PlanHistory entries={task.history} members={members} tz={tz} />

      {open ? (
        <TaskActionBar
          occurrenceId={task.id}
          title={task.title}
          dueDate={task.dueDate}
          originalDueDate={task.originalDueDate}
          today={today}
          limitDate={addDaysLocal(task.originalDueDate, settings.maxPostponeDays)}
          viewerId={viewerId}
          members={completeProps.members}
          providers={providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            trade: provider.trade,
            phone: provider.phone,
          }))}
          materials={task.materials}
          estimatedMinutes={task.estimatedMinutes}
          assetName={completeProps.assetName}
          isConditionTask={task.source === "condition"}
          hasPlan={task.planId !== null}
          blocked={task.blockedReason !== null}
          booked={task.serviceBookingId !== null}
          canSnooze={canSnooze}
          defaultProviderId={task.plan?.defaultProviderId ?? null}
          requiresProfessional={task.plan?.requiresProfessional ?? false}
        />
      ) : (
        <Panel
          title="This task is closed"
          subtitle={
            task.status === "completed"
              ? "It was recorded as done."
              : task.status === "skipped"
                ? "It was closed without the work being done."
                : "It was cancelled."
          }
        >
          <p className="text-sm text-ink-2">
            {task.closedAtMs === null
              ? "No closing time recorded."
              : `Closed ${formatInstant(task.closedAtMs, tz)}${task.closeReason === null ? "" : ` — ${task.closeReason}`}.`}
          </p>
          {task.status === "skipped" || task.status === "cancelled" ? (
            <div className="mt-3">
              <ReopenButton occurrenceId={task.id} />
              <p className="mt-2 text-xs text-ink-3">
                Reopening cancels the follow-up task, unless somebody has already started it — in
                which case it is refused rather than silently overwritten.
              </p>
            </div>
          ) : null}
        </Panel>
      )}
    </PageScroll>
  );
}

/** How a schedule anchor came to be, in words — never phrased as if it were a completion. */
function anchorWording(source: string): string {
  switch (source) {
    case "completion":
      return "from the last recorded completion";
    case "baseline_exact":
      return "a starting point recorded at setup, not a logged completion";
    case "baseline_approx":
      return "an approximate starting point recorded at setup, not a logged completion";
    case "user_chosen":
      return "a start date chosen at setup";
    case "skipped_due_date":
      return "the due date of a task that was skipped";
    case "install_date":
      return "the equipment's installation date";
    default:
      return "no starting point";
  }
}
