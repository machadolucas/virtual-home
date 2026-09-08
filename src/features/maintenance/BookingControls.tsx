"use client";
/**
 * Changing or cancelling a booking that has already been recorded.
 *
 * The counterpart to `BookDialog`, and the reason it exists: appointments move. Without this the
 * only booking a task could ever have was the first one somebody typed — the "Book a professional"
 * action hides itself once `service_booking_id` is set, so a wrong date or a provider who never
 * turned up had no way back out.
 *
 * The wording carries the same rule as booking itself (§3.2, binding policy 3): **none of these
 * statuses completes the task.** "Attended" says a person came; only a recorded completion says
 * the work was done. Cancelling clears the decorator, so the task leaves the waiting group and
 * "Book a professional" comes back.
 */
import { useState } from "react";
import { CalendarCog } from "lucide-react";
import { Button, Dialog, Field, Input, Select } from "@/ui";
import type { BookingStatus } from "@/db/schema/maintenance";
import { updateBooking } from "@/server/actions/maintenance/bookings";
import { messageFor, useAction } from "./useAction";

const STATUS_OPTIONS: { value: BookingStatus; label: string; hint: string }[] = [
  { value: "requested", label: "Asked, not confirmed", hint: "The request is out; nothing agreed." },
  { value: "confirmed", label: "Confirmed", hint: "They have agreed to come." },
  { value: "rescheduled", label: "Rescheduled", hint: "Moved to a different date." },
  {
    value: "attended",
    label: "They came",
    hint: "Still not a completion — record what was done separately.",
  },
  { value: "no_show", label: "They did not come", hint: "Kept on the record rather than deleted." },
  {
    value: "cancelled",
    label: "Cancelled",
    hint: "Clears the appointment from this task and offers booking again.",
  },
];

export interface BookingControlsProps {
  occurrenceId: string;
  bookingId: string;
  status: BookingStatus;
  scheduledLocalDate: string | null;
  windowNote: string | null;
  reference: string | null;
}

export function BookingControls({
  occurrenceId,
  bookingId,
  status,
  scheduledLocalDate,
  windowNote,
  reference,
}: BookingControlsProps) {
  const [open, setOpen] = useState(false);
  const [nextStatus, setNextStatus] = useState<BookingStatus>(status);
  const [date, setDate] = useState(scheduledLocalDate ?? "");
  const [note, setNote] = useState(windowNote ?? "");
  const [ref, setRef] = useState(reference ?? "");

  const { run, pending, failure, requestKey } = useAction(updateBooking, {
    success: "Booking updated. The task still needs a recorded completion.",
    onDone: () => setOpen(false),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      trigger={
        <Button variant="secondary" size="sm" icon={<CalendarCog aria-hidden="true" />}>
          Change or cancel the booking
        </Button>
      }
      title="Change or cancel the booking"
      description="Updates the appointment only. The due date, the reminders and the history are untouched — and none of these statuses records the work as done."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Leave it as it is
          </Button>
          <Button
            variant={nextStatus === "cancelled" ? "danger" : "primary"}
            loading={pending}
            onClick={() =>
              void run({
                bookingId,
                occurrenceId,
                status: nextStatus,
                // `null` clears the field, so an emptied box means "no date agreed" rather than
                // silently keeping the one that is being changed away from.
                scheduledDate: date === "" ? null : date,
                windowNote: note.trim() === "" ? null : note.trim(),
                reference: ref.trim() === "" ? null : ref.trim(),
                idempotencyKey: requestKey,
              })
            }
          >
            {nextStatus === "cancelled" ? "Cancel the booking" : "Save the booking"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Where this booking stands" required>
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={nextStatus}
              onValueChange={(value) => setNextStatus(value as BookingStatus)}
              options={STATUS_OPTIONS}
            />
          )}
        </Field>

        {/* No `min`, unlike the booking dialog: this form is also how a past appointment is
            marked as attended or a no-show, and that date is behind us by definition. */}
        <Field label="Date" help="Leave empty if there is no agreed date.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              type="date"
              value={date}
              aria-describedby={describedBy}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </Field>

        <Field label="Window as they described it" help="“Between 8 and 12” is a real answer.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              value={note}
              aria-describedby={describedBy}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>

        <Field label="Their booking reference">
          {({ id }) => (
            <Input id={id} value={ref} onChange={(event) => setRef(event.target.value)} />
          )}
        </Field>

        {nextStatus === "cancelled" ? (
          <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
            The appointment stays on the record as cancelled — nothing is deleted. This task drops
            out of the waiting group and can be booked again.
          </p>
        ) : null}

        {failure !== null ? (
          <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
            {messageFor(failure)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
