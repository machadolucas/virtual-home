"use client";
/**
 * The transition dialogs, and the quick-action row Today uses.
 *
 * Each dialog says what the transition does *and does not* do, because that is the part people get
 * wrong: a snooze moves a reminder and nothing else, a postpone moves the due date but not the
 * plan's interval, a skip closes the task without ever writing a completion.
 */
import { useState } from "react";
import Link from "next/link";
import { AlarmClock, CalendarClock, RotateCcw, Undo2 } from "lucide-react";
import { Button, Dialog, Field, Input, RadioGroup, Select, Textarea, buttonClasses } from "@/ui";
import { addDaysLocal, compareLocalDate } from "@/domain/time";
import {
  blockTask,
  postponeTask,
  reassignTask,
  reopenTask,
  skipTask,
  snoozeTask,
  snoozeUntilTomorrow,
  unblockTask,
} from "@/server/actions/maintenance/occurrence";
import { messageFor, newRequestKey, useAction } from "./useAction";
import { describeDue, formatDate } from "./dueDate";

interface DialogControl {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline error line inside a dialog, so a failure is never only a toast. */
function FailureNote({ failure }: { failure: { error: string; details?: unknown } | null }) {
  if (failure === null) return null;
  return (
    <p className="mt-3 rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
      {messageFor(failure)}
    </p>
  );
}

export interface PostponeDialogProps extends DialogControl {
  occurrenceId: string;
  dueDate: string;
  originalDueDate: string;
  today: string;
  /** `original_due_date + max_postpone_days`, from the household settings. */
  limitDate: string;
}

/**
 * Move the due date. `original_due_date` is deliberately left as it was, so the row can keep
 * saying "originally due 1 April" — and the plan's interval is untouched.
 */
export function PostponeDialog({
  occurrenceId,
  dueDate,
  originalDueDate,
  today,
  limitDate,
  open,
  onOpenChange,
}: PostponeDialogProps) {
  const [date, setDate] = useState(() => addDaysLocal(dueDate, 7));
  const [reason, setReason] = useState("");
  const [key] = useState(newRequestKey);
  const { run, pending, failure } = useAction(postponeTask, {
    success: "Due date moved.",
    onDone: () => onOpenChange(false),
  });

  const tooEarly = compareLocalDate(date, today) < 0;
  const tooLate = compareLocalDate(date, limitDate) > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Postpone this task"
      description="Moves the due date only. The reminder series restarts at the new date; the plan's interval, the original due date and any recorded history stay exactly as they are."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={tooEarly || tooLate}
            onClick={() =>
              void run({
                occurrenceId,
                newDueDate: date,
                reason: reason.trim() === "" ? undefined : reason.trim(),
                idempotencyKey: key,
              })
            }
          >
            Postpone
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-2">
          Currently due {formatDate(dueDate)}
          {originalDueDate !== dueDate ? ` · originally due ${formatDate(originalDueDate)}` : ""}.
        </p>
        <Field
          label="New due date"
          required
          help={`Between today and ${formatDate(limitDate)} — a postpone may not run past the household limit measured from the original due date.`}
          error={
            tooEarly
              ? "A postpone cannot move the due date backwards."
              : tooLate
                ? `That is past ${formatDate(limitDate)}.`
                : undefined
          }
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              type="date"
              value={date}
              min={today}
              max={limitDate}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-errormessage={errorId}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </Field>
        <Field label="Why" help="Optional, but it is what makes the timeline readable later.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={2}
              value={reason}
              aria-describedby={describedBy}
              placeholder="Waiting for the scaffolding to come down"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <FailureNote failure={failure} />
      </div>
    </Dialog>
  );
}

export interface SnoozeDialogProps extends DialogControl {
  occurrenceId: string;
  today: string;
}

/**
 * Snooze **your** reminders. Per person by design: the other member's series is untouched, and
 * nothing about the task itself changes.
 */
export function SnoozeDialog({ occurrenceId, today, open, onOpenChange }: SnoozeDialogProps) {
  const [preset, setPreset] = useState<"tomorrow" | "three_days" | "pick">("tomorrow");
  const [date, setDate] = useState(() => addDaysLocal(today, 7));
  const { run, pending, failure } = useAction(snoozeTask, {
    success: "Reminder snoozed.",
    onDone: () => onOpenChange(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Snooze the reminder"
      description="Moves your next reminder and nothing else: the due date, the schedule and the history all stay as they are. The other household member keeps their own reminders."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            onClick={() =>
              void run({
                occurrenceId,
                preset,
                until: preset === "pick" ? date : undefined,
              })
            }
          >
            Snooze
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          ariaLabel="Snooze until"
          value={preset}
          onValueChange={(value) => setPreset(value as typeof preset)}
          options={[
            { value: "tomorrow", label: "Until tomorrow" },
            { value: "three_days", label: "For three days" },
            { value: "pick", label: "Pick a date" },
          ]}
        />
        {preset === "pick" ? (
          <Field label="Snooze until" required>
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="date"
                value={date}
                min={today}
                aria-describedby={describedBy}
                onChange={(event) => setDate(event.target.value)}
              />
            )}
          </Field>
        ) : null}
        <FailureNote failure={failure} />
      </div>
    </Dialog>
  );
}

export interface SkipDialogProps extends DialogControl {
  occurrenceId: string;
  dueDate: string;
  /** Wording differs when the plan generates a successor from the skipped due date. */
  hasPlan: boolean;
}

export function SkipDialog({ occurrenceId, dueDate, hasPlan, open, onOpenChange }: SkipDialogProps) {
  const [reason, setReason] = useState("");
  const [key] = useState(newRequestKey);
  const { run, pending, failure } = useAction(skipTask, {
    success: "Task skipped. No completion was recorded.",
    onDone: () => onOpenChange(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Skip this task"
      description={
        hasPlan
          ? "Closes this task without recording that any work happened, and schedules the next one from this due date. History will show a skip, never a completion."
          : "Closes this task without recording that any work happened. History will show a skip, never a completion."
      }
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={reason.trim() === ""}
            onClick={() =>
              void run({ occurrenceId, reason: reason.trim(), idempotencyKey: key })
            }
          >
            Skip without doing it
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-2">Due {formatDate(dueDate)}.</p>
        <Field
          label="Reason"
          required
          help="Required: a skip with no reason is indistinguishable from forgetting."
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              rows={2}
              value={reason}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-errormessage={errorId}
              placeholder="Filters were replaced by the ventilation company in August"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <FailureNote failure={failure} />
      </div>
    </Dialog>
  );
}

export interface BlockDialogProps extends DialogControl {
  occurrenceId: string;
}

export function BlockDialog({ occurrenceId, open, onOpenChange }: BlockDialogProps) {
  const [reason, setReason] = useState("");
  const [key] = useState(newRequestKey);
  const { run, pending, failure } = useAction(blockTask, {
    success: "Marked as blocked.",
    onDone: () => onOpenChange(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Mark as waiting"
      description="Records why the task cannot be done right now. The due date and the reminders keep running, because being blocked is not the same as being done — use Snooze as well if you do not want reminding meanwhile."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={reason.trim() === ""}
            onClick={() => void run({ occurrenceId, reason: reason.trim(), idempotencyKey: key })}
          >
            Mark as waiting
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="What is it waiting for?" required>
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              value={reason}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-errormessage={errorId}
              placeholder="Waiting for the F7 filters to arrive"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <FailureNote failure={failure} />
      </div>
    </Dialog>
  );
}

/** Clear the blocked decorator. Nothing else changes. */
export function UnblockButton({ occurrenceId }: { occurrenceId: string }) {
  const { run, pending } = useAction(unblockTask, { success: "No longer waiting." });
  return (
    <Button
      variant="secondary"
      loading={pending}
      icon={<Undo2 aria-hidden="true" />}
      onClick={() => void run({ occurrenceId })}
    >
      No longer waiting
    </Button>
  );
}

/** Reopen a skipped or cancelled task inside the reopen window. */
export function ReopenButton({ occurrenceId }: { occurrenceId: string }) {
  const { run, pending } = useAction(reopenTask, { success: "Task reopened." });
  return (
    <Button
      variant="secondary"
      loading={pending}
      icon={<RotateCcw aria-hidden="true" />}
      onClick={() => void run({ occurrenceId })}
    >
      Reopen
    </Button>
  );
}

export interface TaskQuickActionsProps {
  occurrenceId: string;
  dueDate: string;
  originalDueDate: string;
  today: string;
  limitDate: string;
  /** Hide "Snooze" when the viewer is not a recipient — there is no reminder of theirs to move. */
  canSnooze: boolean;
}

/**
 * The row-level actions on Today: open the task, snooze a day, or postpone.
 *
 * Completing is deliberately **not** here. A completion asks who did it, when, and what was used;
 * a one-tap "done" on a list is how fake history gets written.
 */
export function TaskQuickActions({
  occurrenceId,
  dueDate,
  originalDueDate,
  today,
  limitDate,
  canSnooze,
}: TaskQuickActionsProps) {
  const [postponeOpen, setPostponeOpen] = useState(false);
  const snooze = useAction(snoozeUntilTomorrow, { success: "Reminder snoozed until tomorrow." });

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Link href={`/tasks/${occurrenceId}`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
        Open
      </Link>
      {canSnooze ? (
        <Button
          variant="ghost"
          size="sm"
          loading={snooze.pending}
          icon={<AlarmClock aria-hidden="true" />}
          onClick={() => void snooze.run({ occurrenceId })}
        >
          Snooze 1 day
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        icon={<CalendarClock aria-hidden="true" />}
        onClick={() => setPostponeOpen(true)}
      >
        Postpone…
      </Button>
      {postponeOpen ? (
        <PostponeDialog
          occurrenceId={occurrenceId}
          dueDate={dueDate}
          originalDueDate={originalDueDate}
          today={today}
          limitDate={limitDate}
          open={postponeOpen}
          onOpenChange={setPostponeOpen}
        />
      ) : null}
    </div>
  );
}

/** Small helper the task header uses to phrase the due date consistently with Today. */
export function DueText({
  dueDate,
  today,
  approximate,
}: {
  dueDate: string;
  today: string;
  approximate: boolean;
}) {
  return <>{describeDue(dueDate, today, { approximate })}</>;
}

export interface WaitingForMaterialsButtonProps {
  occurrenceId: string;
  /** Names of the short parts, used to pre-fill the reason. */
  partNames: readonly string[];
}

/**
 * "I cannot do this, the parts are not here." One click writes the block with a reason that says
 * which parts — which is what turns a stalled task into a readable row under "Blocked / waiting"
 * instead of one that just looks forgotten.
 *
 * Reminders deliberately keep running (§3.2): blocking is not completing. Snooze separately if the
 * nagging is the problem.
 */
export function WaitingForMaterialsButton({
  occurrenceId,
  partNames,
}: WaitingForMaterialsButtonProps) {
  const [key] = useState(newRequestKey);
  const { run, pending } = useAction(blockTask, { success: "Marked as waiting for materials." });
  const reason =
    partNames.length === 0
      ? "Waiting for materials"
      : `Waiting for ${partNames.slice(0, 3).join(", ")}${partNames.length > 3 ? ` and ${partNames.length - 3} more` : ""}`;

  return (
    <Button
      variant="secondary"
      size="sm"
      loading={pending}
      onClick={() => void run({ occurrenceId, reason, idempotencyKey: key })}
    >
      Mark as waiting for materials
    </Button>
  );
}

export interface ReassignControlProps {
  occurrenceId: string;
  assignmentMode: "user" | "shared";
  assigneeUserId: string | null;
  members: readonly { id: string; name: string }[];
}

/**
 * Move this task between the two members, or make it shared.
 *
 * It changes *this task only*: an occurrence is a snapshot of the plan, so the plan's own
 * assignment is edited on the plan page. Reminders are re-derived, which quietly stops nagging
 * whoever is no longer on the hook.
 */
export function ReassignControl({
  occurrenceId,
  assignmentMode,
  assigneeUserId,
  members,
}: ReassignControlProps) {
  const value = assignmentMode === "shared" ? "shared" : `user:${assigneeUserId ?? ""}`;
  const { run, pending } = useAction(reassignTask, { success: "Reassigned." });

  return (
    <Select
      selectSize="sm"
      ariaLabel="Who this task is assigned to"
      value={value}
      disabled={pending}
      onValueChange={(next) =>
        void run(
          next === "shared"
            ? { occurrenceId, assignmentMode: "shared", assigneeUserId: null }
            : { occurrenceId, assignmentMode: "user", assigneeUserId: next.slice(5) },
        )
      }
      options={[
        { value: "shared", label: "Shared", hint: "Both members are reminded." },
        ...members.map((member) => ({ value: `user:${member.id}`, label: member.name })),
      ]}
    />
  );
}
