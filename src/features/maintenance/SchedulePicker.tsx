"use client";
/**
 * The schedule chooser, with plain-language explanations and a live preview of the next three due
 * dates.
 *
 * This control exists because the *difference between the kinds* is the hardest idea in the app
 * (§2.3), and it has to be legible before the plan is saved:
 *
 *  - "every 6 months after it was last done" drifts on purpose;
 *  - "every April and October" never drifts;
 *  - a seasonal window is a period, and missing it does not close the task.
 *
 * The preview is computed on the **server** (`previewSchedule`), by the same `computeNextDue` the
 * scheduler uses and in the household time zone. A preview computed in the browser's zone would
 * quietly be a different answer.
 */
import { useEffect, useMemo, useState } from "react";
import { CalendarRange, Info } from "lucide-react";
import { Badge, Checkbox, Field, Input, RadioGroup, Select, Spinner } from "@/ui";
import type { RecurrenceUnit } from "@/domain/recurrence";
import { previewSchedule } from "@/server/actions/maintenance/plans";
import { formatDate } from "./dueDate";
import {
  SCHEDULE_EXPLANATIONS,
  explanationFor,
  toRecurrenceRule,
  type ScheduleFormKind,
  type ScheduleFormState,
  type SchedulePreview,
} from "./schedule";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const UNITS: { value: RecurrenceUnit; label: string }[] = [
  { value: "day", label: "days" },
  { value: "week", label: "weeks" },
  { value: "month", label: "months" },
  { value: "year", label: "years" },
];

export interface SchedulePickerProps {
  value: ScheduleFormState;
  onChange: (next: ScheduleFormState) => void;
  /** The plan's anchor, so the preview can start from the right place. */
  anchorDate: string | null;
}

export function SchedulePicker({ value, onChange, anchorDate }: SchedulePickerProps) {
  const ruleResult = useMemo(() => toRecurrenceRule(value), [value]);
  const [preview, setPreview] = useState<SchedulePreview | null>(null);
  const [loading, setLoading] = useState(false);

  const ruleJson = ruleResult.ok ? JSON.stringify(ruleResult.rule) : null;

  useEffect(() => {
    // An invalid rule has nothing to preview. The render branch below shows the validation message
    // instead, so the stale preview is never displayed and no state has to be cleared here — which
    // also keeps this effect free of a synchronous setState.
    if (ruleJson === null) return;
    let cancelled = false;
    // Debounced: typing "12" in the interval box should not fire two previews.
    const timer = setTimeout(() => {
      setLoading(true);
      void previewSchedule({
        rule: JSON.parse(ruleJson),
        anchorDate,
        count: 3,
      }).then((result) => {
        if (cancelled) return;
        setLoading(false);
        setPreview(result.ok ? result.data : null);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [ruleJson, anchorDate]);

  const explanation = explanationFor(value.kind);

  function patch(next: Partial<ScheduleFormState>): void {
    onChange({ ...value, ...next });
  }

  function toggleMonth(month: number): void {
    const has = value.months.includes(month);
    patch({
      months: has ? value.months.filter((m) => m !== month) : [...value.months, month].sort((a, b) => a - b),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-semibold text-ink">How often?</legend>
        <RadioGroup
          ariaLabel="Kind of schedule"
          value={value.kind}
          onValueChange={(next) => patch({ kind: next as ScheduleFormKind })}
          options={SCHEDULE_EXPLANATIONS.map((entry) => ({
            value: entry.kind,
            label: entry.label,
            hint: entry.plain,
          }))}
        />
      </fieldset>

      <div className="rounded-md border border-line bg-surface-2 px-3 py-2.5">
        <p className="flex items-start gap-2 text-sm text-ink-2">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <span>
            <span className="text-ink">{explanation.example}</span> {explanation.drift}
          </span>
        </p>
      </div>

      {value.kind === "interval_from_completion" || value.kind === "fixed_interval" ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Every" required>
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={String(value.every)}
                aria-describedby={describedBy}
                onChange={(event) => patch({ every: Number(event.target.value) })}
              />
            )}
          </Field>
          <Field label="Unit" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={value.unit}
                onValueChange={(next) => patch({ unit: next as RecurrenceUnit })}
                options={UNITS}
              />
            )}
          </Field>
          {value.kind === "fixed_interval" ? (
            <Field
              label="Measured from"
              required
              help="The interval is recomputed from this date every time, so a short month never drags the series earlier."
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="date"
                  value={value.anchorDate}
                  aria-describedby={describedBy}
                  onChange={(event) => patch({ anchorDate: event.target.value })}
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}

      {value.kind === "fixed_monthly" ? (
        <div className="flex flex-col gap-3">
          <fieldset>
            <legend className="text-sm font-medium text-ink">Which months?</legend>
            <div className="mt-2 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
              {MONTHS.map((label, index) => (
                <Checkbox
                  key={label}
                  checked={value.months.includes(index + 1)}
                  onCheckedChange={() => toggleMonth(index + 1)}
                  label={label}
                />
              ))}
            </div>
            {value.months.length === 0 ? (
              <p className="mt-1 text-xs text-overdue">Pick at least one month.</p>
            ) : null}
          </fieldset>
          <Field label="Day of the month" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={String(value.dayOfMonth)}
                onValueChange={(next) =>
                  patch({ dayOfMonth: next === "last" ? "last" : Number(next) })
                }
                options={[
                  ...Array.from({ length: 31 }, (_, i) => ({
                    value: String(i + 1),
                    label: `${i + 1}`,
                  })),
                  { value: "last", label: "Last day of the month" },
                ]}
              />
            )}
          </Field>
        </div>
      ) : null}

      {value.kind === "fixed_yearly" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Month" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={String(value.yearlyMonth)}
                onValueChange={(next) => patch({ yearlyMonth: Number(next) })}
                options={MONTHS.map((label, index) => ({
                  value: String(index + 1),
                  label,
                }))}
              />
            )}
          </Field>
          <Field
            label="Day"
            required
            help="A day that does not exist in every year (29 February) is rejected; use “last day” instead."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={String(value.yearlyDay)}
                onValueChange={(next) => patch({ yearlyDay: next === "last" ? "last" : Number(next) })}
                options={[
                  ...Array.from({ length: 31 }, (_, i) => ({
                    value: String(i + 1),
                    label: `${i + 1}`,
                  })),
                  { value: "last", label: "Last day of the month" },
                ]}
              />
            )}
          </Field>
        </div>
      ) : null}

      {value.kind === "seasonal_window" ? (
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Window opens (month)" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={String(value.windowStart.month)}
                  onValueChange={(next) =>
                    patch({ windowStart: { ...value.windowStart, month: Number(next) } })
                  }
                  options={MONTHS.map((label, index) => ({ value: String(index + 1), label }))}
                />
              )}
            </Field>
            <Field label="Day" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={String(value.windowStart.day)}
                  onValueChange={(next) =>
                    patch({
                      windowStart: {
                        ...value.windowStart,
                        day: next === "last" ? "last" : Number(next),
                      },
                    })
                  }
                  options={[
                    ...Array.from({ length: 31 }, (_, i) => ({
                      value: String(i + 1),
                      label: `${i + 1}`,
                    })),
                    { value: "last", label: "Last" },
                  ]}
                />
              )}
            </Field>
            <Field label="Window closes (month)" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={String(value.windowEnd.month)}
                  onValueChange={(next) =>
                    patch({ windowEnd: { ...value.windowEnd, month: Number(next) } })
                  }
                  options={MONTHS.map((label, index) => ({ value: String(index + 1), label }))}
                />
              )}
            </Field>
            <Field label="Day" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={String(value.windowEnd.day)}
                  onValueChange={(next) =>
                    patch({
                      windowEnd: {
                        ...value.windowEnd,
                        day: next === "last" ? "last" : Number(next),
                      },
                    })
                  }
                  options={[
                    ...Array.from({ length: 31 }, (_, i) => ({
                      value: String(i + 1),
                      label: `${i + 1}`,
                    })),
                    { value: "last", label: "Last" },
                  ]}
                />
              )}
            </Field>
          </div>
          <p className="text-xs text-ink-3">
            A window may run across New Year (15 November to 15 February); it then belongs to the
            year it starts in.
          </p>
          <Field label="When inside the window is it due?" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={value.dueOn}
                onValueChange={(next) => patch({ dueOn: next as ScheduleFormState["dueOn"] })}
                options={[
                  { value: "window_start", label: "As soon as the window opens" },
                  { value: "window_end", label: "By the time it closes" },
                  { value: "after_start_days", label: "A number of days after it opens" },
                ]}
              />
            )}
          </Field>
          {value.dueOn === "after_start_days" ? (
            <Field label="Days after it opens" required>
              {({ id }) => (
                <Input
                  id={id}
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={String(value.afterStartDays)}
                  onChange={(event) => patch({ afterStartDays: Number(event.target.value) })}
                />
              )}
            </Field>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-md border border-line bg-surface-2 px-3 py-3">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CalendarRange aria-hidden="true" className="size-4 text-ink-3" />
          Next three dates
          {loading ? <Spinner /> : null}
        </h4>
        {!ruleResult.ok ? (
          <p className="mt-1 text-sm text-ink-3">{ruleResult.error}</p>
        ) : preview === null ? (
          <p className="mt-1 text-sm text-ink-3">Working it out…</p>
        ) : preview.error !== null ? (
          <p className="mt-1 text-sm text-overdue">{preview.error}</p>
        ) : preview.entries.length === 0 ? (
          <p className="mt-1 text-sm text-ink-3">{preview.assumption}</p>
        ) : (
          <>
            <ol className="vh-tnum mt-2 flex flex-col gap-1 text-sm text-ink">
              {preview.entries.map((entry, index) => (
                <li key={`${entry.dueDate}-${index}`} className="flex flex-wrap items-baseline gap-2">
                  <span>{formatDate(entry.dueDate)}</span>
                  {entry.windowStartDate !== null && entry.windowEndDate !== null ? (
                    <span className="text-xs text-ink-3">
                      window {formatDate(entry.windowStartDate)} – {formatDate(entry.windowEndDate)}
                    </span>
                  ) : null}
                  {entry.missedSeriesDates.length > 0 ? (
                    <Badge tone="unknown" size="sm">
                      {entry.missedSeriesDates.length} earlier date
                      {entry.missedSeriesDates.length === 1 ? "" : "s"} rolled over
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-ink-3">
              {preview.ruleText}. {preview.assumption}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
