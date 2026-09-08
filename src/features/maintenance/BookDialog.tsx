"use client";
/**
 * Booking a professional.
 *
 * The dialog exists as much to say what a booking is *not* as to create one: it does not complete
 * the task, it does not move the due date, and a provider turning up is still not a completion.
 * "Also move the due date to the appointment" is a separate checkbox, because that is a different
 * decision with different consequences for the reminders.
 */
import { useState } from "react";
import { CalendarPlus, Phone } from "lucide-react";
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from "@/ui";
import { bookProfessional, createProvider } from "@/server/actions/maintenance/bookings";
import { messageFor, newRequestKey, useAction } from "./useAction";
import { formatDate } from "./dueDate";

export interface BookDialogProvider {
  id: string;
  name: string;
  trade: string | null;
  phone: string | null;
}

export interface BookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  dueDate: string;
  today: string;
  providers: readonly BookDialogProvider[];
  defaultProviderId: string | null;
}

const NEW_PROVIDER = "__new__";

export function BookDialog({
  open,
  onOpenChange,
  occurrenceId,
  dueDate,
  today,
  providers,
  defaultProviderId,
}: BookDialogProps) {
  const [providerId, setProviderId] = useState(
    defaultProviderId ?? providers[0]?.id ?? NEW_PROVIDER,
  );
  const [newName, setNewName] = useState("");
  const [newTrade, setNewTrade] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [windowNote, setWindowNote] = useState("");
  const [reference, setReference] = useState("");
  const [contactNote, setContactNote] = useState("");
  const [alsoPostpone, setAlsoPostpone] = useState(false);
  const [key] = useState(newRequestKey);

  const provider = useAction(createProvider, { refresh: false });
  const booking = useAction(bookProfessional, {
    success: "Booking recorded. The task is still open until the work is logged.",
    onDone: () => onOpenChange(false),
  });

  async function submit(): Promise<void> {
    let chosen = providerId;
    if (chosen === NEW_PROVIDER) {
      const created = await provider.run({
        name: newName.trim(),
        trade: newTrade.trim() === "" ? null : newTrade.trim(),
        phone: newPhone.trim() === "" ? null : newPhone.trim(),
        idempotencyKey: `${key}-provider`,
      });
      if (created === null) return;
      chosen = created.providerId;
    }
    await booking.run({
      occurrenceId,
      providerId: chosen,
      scheduledDate: date === "" ? undefined : date,
      startTime: startTime === "" ? undefined : startTime,
      endTime: endTime === "" ? undefined : endTime,
      windowNote: windowNote.trim() === "" ? null : windowNote.trim(),
      reference: reference.trim() === "" ? null : reference.trim(),
      contactNote: contactNote.trim() === "" ? null : contactNote.trim(),
      alsoPostponeToAppointment: alsoPostpone && date !== "",
      idempotencyKey: key,
    });
  }

  const creatingProvider = providerId === NEW_PROVIDER;
  const canSubmit = creatingProvider ? newName.trim() !== "" : providerId !== "";
  const failure = booking.failure ?? provider.failure;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Book a professional"
      description="Records who is coming and when. It does not record the work as done and it does not move the due date — the task stays open until somebody logs what was actually done."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={booking.pending || provider.pending}
            disabled={!canSubmit}
            icon={<CalendarPlus aria-hidden="true" />}
            onClick={() => void submit()}
          >
            Record the booking
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Provider" required>
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={providerId}
              onValueChange={setProviderId}
              options={[
                ...providers.map((row) => ({
                  value: row.id,
                  label: row.name,
                  hint: [row.trade, row.phone].filter(Boolean).join(" · ") || undefined,
                })),
                { value: NEW_PROVIDER, label: "Add a new provider…" },
              ]}
            />
          )}
        </Field>

        {creatingProvider ? (
          <div className="grid gap-3 rounded-md border border-line bg-surface-2 px-3 py-3 sm:grid-cols-3">
            <Field label="Name" required>
              {({ id }) => (
                <Input id={id} value={newName} onChange={(event) => setNewName(event.target.value)} />
              )}
            </Field>
            <Field label="Trade" help="Plumbing, chimney, HVAC…">
              {({ id }) => (
                <Input id={id} value={newTrade} onChange={(event) => setNewTrade(event.target.value)} />
              )}
            </Field>
            <Field label="Phone">
              {({ id }) => (
                <Input
                  id={id}
                  type="tel"
                  icon={<Phone aria-hidden="true" />}
                  value={newPhone}
                  onChange={(event) => setNewPhone(event.target.value)}
                />
              )}
            </Field>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" help="Leave empty if it is not agreed yet.">
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
          <Field label="From">
            {({ id }) => (
              <Input
                id={id}
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            )}
          </Field>
          <Field label="To">
            {({ id }) => (
              <Input
                id={id}
                type="time"
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="Window as they described it" help="“Between 8 and 12” is a real answer.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              value={windowNote}
              aria-describedby={describedBy}
              onChange={(event) => setWindowNote(event.target.value)}
            />
          )}
        </Field>

        <Field label="Their booking reference">
          {({ id }) => (
            <Input id={id} value={reference} onChange={(event) => setReference(event.target.value)} />
          )}
        </Field>

        <Field label="Note">
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              value={contactNote}
              placeholder="Spoke to Anna; they will call the morning before."
              onChange={(event) => setContactNote(event.target.value)}
            />
          )}
        </Field>

        <Checkbox
          checked={alsoPostpone}
          disabled={date === ""}
          onCheckedChange={(value) => setAlsoPostpone(value === true)}
          label={
            date === ""
              ? "Also move the due date to the appointment (pick a date first)"
              : `Also move the due date to ${formatDate(date)}`
          }
          hint={`Currently due ${formatDate(dueDate)}. Without this, the task stays due on its own date and keeps reminding — which is usually what you want, because the appointment can be cancelled.`}
        />

        {failure !== null ? (
          <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
            {messageFor(failure)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
