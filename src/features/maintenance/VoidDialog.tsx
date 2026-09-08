"use client";
/**
 * Void a completion.
 *
 * Nothing is deleted (§5.4): the completion row and its material lines stay, every stock movement
 * is reversed by a mirror row, the task reopens, and the plan's anchor reverts to the previous
 * real completion. History then reads "completed 12 Jun, voided 14 Jun by Lucas (wrong task)".
 *
 * If the follow-up task this completion generated has already been worked on, the server refuses
 * (`successor_touched`) instead of quietly cancelling work someone is standing in front of.
 */
import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Button, Dialog, Field, Textarea } from "@/ui";
import { voidTaskCompletion } from "@/server/actions/maintenance/complete";
import { messageFor, newRequestKey, useAction } from "./useAction";
import { formatDate } from "./dueDate";

export interface VoidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  completionId: string;
  occurrenceId: string;
  completedLocalDate: string;
  /** Set when the completion generated a follow-up task, so the dialog can say so up front. */
  successorDueDate: string | null;
}

export function VoidDialog({
  open,
  onOpenChange,
  completionId,
  occurrenceId,
  completedLocalDate,
  successorDueDate,
}: VoidDialogProps) {
  const [reason, setReason] = useState("");
  const [requestId] = useState(newRequestKey);
  const { run, pending, failure } = useAction(voidTaskCompletion, {
    success: "Completion voided. The task is open again.",
    onDone: () => onOpenChange(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Void this completion"
      description="Undoes the record without erasing it. The stock that was consumed is put back with a matching correction, this task opens again, and the schedule goes back to the previous real completion."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={pending}
            disabled={reason.trim() === ""}
            icon={<Undo2 aria-hidden="true" />}
            onClick={() =>
              void run({
                completionId,
                occurrenceId,
                reason: reason.trim(),
                requestId,
              })
            }
          >
            Void the completion
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-2">
          Recorded as done on {formatDate(completedLocalDate)}.
          {successorDueDate !== null ? (
            <>
              {" "}
              The follow-up task due {formatDate(successorDueDate)} will be cancelled — unless
              somebody has already started it, in which case this will be refused and you should
              handle that task first.
            </>
          ) : null}
        </p>
        <Field
          label="Why"
          required
          help="Shown next to the voided entry in History, permanently."
        >
          {({ id, describedBy, invalid, errorId }) => (
            <Textarea
              id={id}
              rows={2}
              value={reason}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-errormessage={errorId}
              placeholder="Logged against the wrong unit"
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        {failure !== null ? (
          <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
            {messageFor(failure)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** The button plus its confirm dialog, for a server component to drop in. */
export function VoidCompletionButton(props: Omit<VoidDialogProps, "open" | "onOpenChange">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" size="sm" icon={<Undo2 aria-hidden="true" />} onClick={() => setOpen(true)}>
        Void this completion
      </Button>
      {open ? <VoidDialog {...props} open onOpenChange={setOpen} /> : null}
    </>
  );
}
