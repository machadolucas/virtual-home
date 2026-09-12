"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, Input, Panel, Select, Switch } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import { updateHouseholdSettings } from "@/server/actions/settings/household";

export interface HouseholdDraft {
  displayName: string;
  timezone: string;
  deliveryTime: string;
  reminderIntervalDays: string;
  sendWindowStart: string;
  sendWindowEnd: string;
  catchupGapMinutes: string;
  catchupDigestThreshold: string;
  slotGraceMinutes: string;
  actionTtlDays: string;
  batteryThresholdPct: string;
  batteryClearPct: string;
  batterySustainMinutes: string;
  batteryClearSustainMinutes: string;
  batteryStaleHours: string;
  reorderHorizonDays: string;
  haBaseUrl: string;
  inventoryPushEnabled: boolean;
}

/**
 * The household settings form.
 *
 * Every field here changes what the worker does on its next tick — there is no deploy and no
 * restart. That is why each one carries a sentence explaining the consequence rather than just a
 * label: "catch-up digest threshold" means nothing on its own, and "more than this many reminders
 * arriving at once become one message instead" means everything.
 */
export function HouseholdForm({
  initial,
  timezones,
}: {
  initial: HouseholdDraft;
  timezones: readonly string[];
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);

  const call = useAction(updateHouseholdSettings, {
    successTitle: "Settings saved",
    successDescription: () => "The worker picks these up on its next tick — no restart needed.",
    onSuccess: () => router.refresh(),
  });

  const set = <K extends keyof HouseholdDraft>(key: K, value: HouseholdDraft[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const fieldError = (name: string): string | undefined => call.fieldErrors[name]?.[0];

  const submit = (): void => {
    call.run({
      displayName: form.displayName,
      timezone: form.timezone,
      deliveryTime: form.deliveryTime,
      reminderIntervalDays: int(form.reminderIntervalDays),
      sendWindowStart: form.sendWindowStart,
      sendWindowEnd: form.sendWindowEnd,
      catchupGapMinutes: int(form.catchupGapMinutes),
      catchupDigestThreshold: int(form.catchupDigestThreshold),
      slotGraceMinutes: int(form.slotGraceMinutes),
      actionTtlDays: int(form.actionTtlDays),
      batteryThresholdPct: int(form.batteryThresholdPct),
      batteryClearPct: int(form.batteryClearPct),
      batterySustainMinutes: int(form.batterySustainMinutes),
      batteryClearSustainMinutes: int(form.batteryClearSustainMinutes),
      batteryStaleHours: int(form.batteryStaleHours),
      reorderHorizonDays: int(form.reorderHorizonDays),
      haBaseUrl: form.haBaseUrl,
      inventoryPushEnabled: form.inventoryPushEnabled,
    });
  };

  return (
    <form data-unsaved
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Panel title="This household">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Display name"
            required
            help="What this installation calls itself."
            error={fieldError("displayName")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.displayName}
                onChange={(event) => set("displayName", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Time zone"
            required
            help="Every calendar date in the app is household-local, never a UTC day. Changing this changes what “today” means."
            error={fieldError("timezone")}
          >
            {({ id, describedBy, invalid }) => (
              <Select
                id={id}
                describedBy={describedBy}
                invalid={invalid}
                value={form.timezone}
                onValueChange={(value) => set("timezone", value)}
                options={timezones.map((zone) => ({ value: zone, label: zone }))}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="When reminders arrive"
        subtitle="The worker sends them; nothing is sent from the browser."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Delivery time"
            required
            help="The wall-clock time the day's reminders go out. It survives daylight saving, because it is stored as a time and not as an instant."
            error={fieldError("deliveryTime")}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={form.deliveryTime}
                onChange={(event) => set("deliveryTime", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Remind again every"
            required
            help="How long an unfinished task waits before it is mentioned again."
            error={fieldError("reminderIntervalDays")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.reminderIntervalDays}
                onChange={(event) => set("reminderIntervalDays", event.target.value)}
                trailing={<span className="text-xs text-ink-3">days</span>}
              />
            )}
          </Field>

          <Field
            label="Send window starts"
            required
            help="Nothing is delivered before this, even if it became due overnight."
            error={fieldError("sendWindowStart")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                type="time"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                value={form.sendWindowStart}
                onChange={(event) => set("sendWindowStart", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Send window ends"
            required
            help="A send that would land after this is held until the window opens again — not delivered at 03:00."
            error={fieldError("sendWindowEnd")}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                type="time"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                value={form.sendWindowEnd}
                onChange={(event) => set("sendWindowEnd", event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Late if more than"
            required
            help="A reminder slot delivered later than this counts as late rather than on time, which is what the history records."
            error={fieldError("slotGraceMinutes")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.slotGraceMinutes}
                onChange={(event) => set("slotGraceMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>

          <Field
            label="Outage if the worker is quiet for"
            required
            help="A gap this long in the worker's heartbeat means the reminders for that period were missed, and they are caught up rather than silently skipped."
            error={fieldError("catchupGapMinutes")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.catchupGapMinutes}
                onChange={(event) => set("catchupGapMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>

          <Field
            label="Bundle catch-ups above"
            required
            help="After an outage, more than this many reminders for one person become a single digest instead of a burst of notifications."
            error={fieldError("catchupDigestThreshold")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.catchupDigestThreshold}
                onChange={(event) => set("catchupDigestThreshold", event.target.value)}
                trailing={<span className="text-xs text-ink-3">reminders</span>}
              />
            )}
          </Field>

          <Field
            label="Accept notification buttons for"
            required
            help="How long a “Done” or “Snooze” button in a delivered notification stays valid. Older ones are ignored rather than acted on."
            error={fieldError("actionTtlDays")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.actionTtlDays}
                onChange={(event) => set("actionTtlDays", event.target.value)}
                trailing={<span className="text-xs text-ink-3">days</span>}
              />
            )}
          </Field>
        </div>

        <p className="mt-4 max-w-prose border-t border-line pt-4 text-sm leading-6 text-ink-2">
          The notification policy in one paragraph: reminders are generated for the tasks that are
          due, sent once per person per slot inside the send window, and repeated at the interval
          above until the task is completed or snoozed. A snooze moves the reminder and changes
          nothing else. Completing a task clears its reminders on every device, and that clear
          survives Home Assistant being down. We record that a send was <em>attempted</em>, never
          that it was delivered — no phone tells us the difference truthfully.
        </p>
        <p className="mt-2 max-w-prose text-xs leading-5 text-ink-3">
          09:00 is a provisional default, chosen because it is after breakfast and before the day
          fills up. Nothing depends on it; change it to whatever suits this household.
        </p>
      </Panel>

      <Panel
        title="Batteries"
        subtitle="When a reading turns into a task, and when it stops being believable."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Low below"
            required
            help="A battery at or under this is worth acting on."
            error={fieldError("batteryThresholdPct")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.batteryThresholdPct}
                onChange={(event) => set("batteryThresholdPct", event.target.value)}
                trailing={<span className="text-xs text-ink-3">%</span>}
              />
            )}
          </Field>

          <Field
            label="Clear above"
            required
            help="Must be above the low level. The gap between the two is what stops a battery sitting on the line from opening and closing a task forever."
            error={fieldError("batteryClearPct")}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                inputMode="numeric"
                value={form.batteryClearPct}
                onChange={(event) => set("batteryClearPct", event.target.value)}
                trailing={<span className="text-xs text-ink-3">%</span>}
              />
            )}
          </Field>

          <Field
            label="Low for at least"
            required
            help="How long it must stay low before a task is opened. A single dip while the radio transmits is not a flat battery."
            error={fieldError("batterySustainMinutes")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.batterySustainMinutes}
                onChange={(event) => set("batterySustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>

          <Field
            label="Recovered for at least"
            required
            help="How long it must stay above the clear level before the episode is closed."
            error={fieldError("batteryClearSustainMinutes")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.batteryClearSustainMinutes}
                onChange={(event) => set("batteryClearSustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>

          <Field
            label="Reading goes stale after"
            required
            help="Older than this and the app shows “last read 40 %” instead of “40 %”. It never shows 0 % for a reading it does not have."
            error={fieldError("batteryStaleHours")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.batteryStaleHours}
                onChange={(event) => set("batteryStaleHours", event.target.value)}
                trailing={<span className="text-xs text-ink-3">hours</span>}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Supplies">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Look ahead"
            required
            help="How far the shopping list looks for tasks that will consume something. Only tasks that already exist count — nothing is forecast."
            error={fieldError("reorderHorizonDays")}
          >
            {({ id, describedBy, invalid, errorId }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                aria-errormessage={errorId}
                inputMode="numeric"
                value={form.reorderHorizonDays}
                onChange={(event) => set("reorderHorizonDays", event.target.value)}
                trailing={<span className="text-xs text-ink-3">days</span>}
              />
            )}
          </Field>

          <div className="flex items-center">
            <Switch
              checked={form.inventoryPushEnabled}
              onCheckedChange={(checked) => set("inventoryPushEnabled", checked)}
              label="Push supply warnings to phones"
              hint="Off by default: “you are low on filters” is not worth a notification, and it is already on the Supplies page."
            />
          </div>
        </div>
      </Panel>

      <Panel
        title="Home Assistant address"
        subtitle="Only the address, for building links. The token lives in the server environment and is never entered here."
      >
        <Field
          label="Base URL"
          required
          help="Used to build “open in Home Assistant” links. The worker's own connection comes from HA_URL in the server environment."
          error={fieldError("haBaseUrl")}
        >
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="url"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={form.haBaseUrl}
              onChange={(event) => set("haBaseUrl", event.target.value)}
            />
          )}
        </Field>
      </Panel>

      {call.error === null ? null : (
        <p role="alert" className="text-sm font-medium text-overdue">
          {call.error} Nothing was changed.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={call.pending}>
          Save settings
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setForm(initial)}
          disabled={call.pending}
        >
          Undo my changes
        </Button>
        <span className="text-xs text-ink-3">
          Every change is attributed to you in the audit trail.
        </span>
      </div>
    </form>
  );
}

/** `""` becomes `NaN`, which zod rejects with a field error — better than silently sending 0. */
function int(raw: string): number {
  return Number.parseInt(raw, 10);
}
