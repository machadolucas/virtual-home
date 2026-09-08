"use client";
/**
 * The completion form — the one place work is recorded as done and stock leaves the shelf.
 *
 * Two things here are load-bearing rather than cosmetic:
 *
 *  1. **`requestId` is created once, when the dialog opens, and reused on every resubmit.** If the
 *     first attempt actually committed but the response was lost, the retry is an idempotent
 *     replay, not a second completion and a second deduction (§5.1 step 1).
 *  2. **Insufficient stock is not an error the form swallows.** The server refuses to guess (§5.3);
 *     the response comes back with a line-by-line list, every field the user typed is still here,
 *     and each short line gets the three honest choices. Submitting again carries the same
 *     `requestId`.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Check, PackageX } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  Input,
  RadioGroup,
  Select,
  Textarea,
} from "@/ui";
import type { ReplacementReason } from "@/db/schema/assets";
import { completeTask } from "@/server/actions/maintenance/complete";
import { messageFor, newRequestKey, useAction } from "./useAction";
import { formatDate } from "./dueDate";
import {
  diffMaterials,
  describeSource,
  formatQty,
  parseQty,
  prefillMaterials,
  qtyStep,
  resolutionsComplete,
  type MaterialDraft,
  type MaterialLine,
} from "./materials";

export interface CompleteDialogMember {
  id: string;
  name: string;
}

export interface CompleteDialogProvider {
  id: string;
  name: string;
  trade: string | null;
}

export interface CompleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  occurrenceId: string;
  title: string;
  dueDate: string;
  today: string;
  viewerId: string;
  members: readonly CompleteDialogMember[];
  providers: readonly CompleteDialogProvider[];
  materials: readonly MaterialLine[];
  estimatedMinutes: number | null;
  /** The unit being serviced, when there is one — enables the replacement section. */
  assetName: string | null;
  /** A condition (battery) task: the completion is what records the replacement. */
  isConditionTask: boolean;
}

/** The three honest options for a short line, in the order §5.3 lists them. */
const SHORT_OPTIONS = [
  {
    value: "adjust_up",
    label: "Adjust stock up",
    hint: "The shelf had more than the ledger said. Records a correction, then consumes what you used.",
  },
  {
    value: "consume_available",
    label: "Consume what's there",
    hint: "Take the balance to zero and record that less was used than planned.",
  },
  {
    value: "note_discrepancy",
    label: "Note the discrepancy",
    hint: "Record what you used and leave the difference flagged for a stock take.",
  },
] as const;

interface ShortLine {
  partId: string;
  partName: string;
  availableMilli: number;
  requestedMilli: number;
}

function readShortLines(details: unknown): ShortLine[] {
  if (typeof details !== "object" || details === null) return [];
  const lines = (details as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((line): ShortLine[] => {
    if (typeof line !== "object" || line === null) return [];
    const row = line as Record<string, unknown>;
    if (typeof row.partId !== "string") return [];
    return [
      {
        partId: row.partId,
        partName: typeof row.partName === "string" ? row.partName : row.partId,
        availableMilli: typeof row.availableMilli === "number" ? row.availableMilli : 0,
        requestedMilli: typeof row.requestedMilli === "number" ? row.requestedMilli : 0,
      },
    ];
  });
}

const REPLACEMENT_REASONS: { value: ReplacementReason; label: string }[] = [
  { value: "failure", label: "It failed" },
  { value: "end_of_life", label: "End of life" },
  { value: "upgrade", label: "Upgrade" },
  { value: "damage", label: "Damage" },
  { value: "recall", label: "Recall" },
  { value: "other", label: "Other" },
];

export function CompleteDialog({
  open,
  onOpenChange,
  occurrenceId,
  title,
  dueDate,
  today,
  viewerId,
  members,
  providers,
  materials,
  estimatedMinutes,
  assetName,
  isConditionTask,
}: CompleteDialogProps) {
  // Created once per dialog instance. The dialog is unmounted after a success, so a second
  // completion of a reopened task gets a fresh key rather than replaying the old one.
  const [requestId] = useState(newRequestKey);

  const [whenMode, setWhenMode] = useState<"now" | "date">("now");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("12:00");
  const [precision, setPrecision] = useState<"exact" | "day" | "month">("exact");

  const [performer, setPerformer] = useState<string>(`user:${viewerId}`);
  const [notes, setNotes] = useState("");
  const [effort, setEffort] = useState(estimatedMinutes === null ? "" : String(estimatedMinutes));
  const [outcome, setOutcome] = useState<"done" | "done_with_issues" | "partial">("done");

  const [drafts, setDrafts] = useState<MaterialDraft[]>(() => prefillMaterials(materials));
  const [qtyText, setQtyText] = useState<Record<string, string>>(() =>
    Object.fromEntries(materials.map((line) => [line.partId, String(line.expectedQtyMilli / 1000)])),
  );

  const [replacing, setReplacing] = useState(false);
  const [replacementReason, setReplacementReason] = useState<ReplacementReason>("end_of_life");
  const [newName, setNewName] = useState("");
  const [newManufacturer, setNewManufacturer] = useState("");
  const [newModel, setNewModel] = useState("");
  const [newSerial, setNewSerial] = useState("");
  const [cloneConsumables, setCloneConsumables] = useState(true);
  const [cloneHaLinks, setCloneHaLinks] = useState(true);

  const { run, pending, failure } = useAction(completeTask, {
    success: "Completion recorded.",
    onDone: () => onOpenChange(false),
  });

  const serverShortLines = useMemo(
    () => (failure?.error === "insufficient_stock" ? readShortLines(failure.details) : []),
    [failure],
  );

  const rows = useMemo(() => diffMaterials(materials, drafts), [materials, drafts]);
  // A line is "short" either because the local balance says so, or because the server said so on
  // the previous attempt (the ledger can have moved between the page render and the submit).
  const shortPartIds = new Set([
    ...rows.filter((row) => row.isShort).map((row) => row.partId),
    ...serverShortLines.map((line) => line.partId),
  ]);
  const needsResolution = [...shortPartIds].filter(
    (partId) => (drafts.find((draft) => draft.partId === partId)?.resolutionIfShort ?? null) === null,
  );
  const blocked = serverShortLines.length > 0 && needsResolution.length > 0;

  function setQty(partId: string, text: string): void {
    setQtyText((current) => ({ ...current, [partId]: text }));
    const parsed = parseQty(text);
    if (parsed === null) return;
    setDrafts((current) =>
      current.map((draft) => (draft.partId === partId ? { ...draft, actualQtyMilli: parsed } : draft)),
    );
  }

  function setResolution(partId: string, value: string): void {
    setDrafts((current) =>
      current.map((draft) =>
        draft.partId === partId
          ? { ...draft, resolutionIfShort: value as MaterialDraft["resolutionIfShort"] }
          : draft,
      ),
    );
  }

  function submit(): void {
    const performedByUserId = performer.startsWith("user:") ? performer.slice(5) : null;
    const performedByProviderId = performer.startsWith("provider:") ? performer.slice(9) : null;
    void run({
      occurrenceId,
      requestId,
      completedAt:
        whenMode === "now"
          ? { mode: "now" }
          : { mode: "date", date, time: precision === "exact" ? time : "12:00" },
      completedAtPrecision: whenMode === "now" ? "exact" : precision,
      performedByUserId,
      performedByProviderId,
      notes: notes.trim() === "" ? undefined : notes.trim(),
      effortMinutes: effort.trim() === "" ? null : Number(effort),
      outcome,
      materials: drafts.map((draft) => ({
        partId: draft.partId,
        actualQtyMilli: draft.actualQtyMilli,
        expectedQtyMilli:
          materials.find((line) => line.partId === draft.partId)?.expectedQtyMilli ?? null,
        resolutionIfShort: draft.resolutionIfShort,
      })),
      ...(replacing && assetName !== null
        ? {
            replacement: {
              reason: replacementReason,
              cloneConsumables,
              cloneHaLinks,
              newAsset: {
                name: newName.trim() === "" ? undefined : newName.trim(),
                manufacturer: newManufacturer.trim() === "" ? null : newManufacturer.trim(),
                modelName: newModel.trim() === "" ? null : newModel.trim(),
                serialNumber: newSerial.trim() === "" ? null : newSerial.trim(),
              },
            },
          }
        : {}),
    });
  }

  const performerOptions = [
    ...members.map((member) => ({
      value: `user:${member.id}`,
      label: member.id === viewerId ? `${member.name} (you)` : member.name,
    })),
    ...providers.map((provider) => ({
      value: `provider:${provider.id}`,
      label: provider.name,
      hint: provider.trade ?? "professional",
    })),
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Record this as done"
      description={`“${title}”, due ${formatDate(dueDate)}. This writes a completion: the factual record that the work happened, the stock that left the shelf, and the anchor the next due date is computed from.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={pending}
            disabled={blocked}
            icon={<Check aria-hidden="true" />}
            onClick={submit}
          >
            {serverShortLines.length > 0 ? "Submit again" : "Record completion"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {serverShortLines.length > 0 ? (
          <div className="rounded-lg border border-blocked/45 bg-blocked-soft px-3 py-3">
            <p className="flex items-center gap-2 text-sm font-medium text-blocked">
              <PackageX aria-hidden="true" className="size-4" />
              Not enough stock for {serverShortLines.length}{" "}
              {serverShortLines.length === 1 ? "part" : "parts"}
            </p>
            <p className="mt-1 text-sm text-ink-2">
              Nothing has been recorded yet. Everything you typed is still here — choose what to do
              with each short line below, then submit again.
            </p>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-semibold text-ink">When was it done?</legend>
          <RadioGroup
            ariaLabel="When was it done"
            orientation="horizontal"
            value={whenMode}
            onValueChange={(value) => setWhenMode(value as typeof whenMode)}
            options={[
              { value: "now", label: "Just now" },
              { value: "date", label: "On an earlier date" },
            ]}
          />
          {whenMode === "date" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Date" required>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="date"
                    value={date}
                    max={today}
                    aria-describedby={describedBy}
                    onChange={(event) => setDate(event.target.value)}
                  />
                )}
              </Field>
              <Field label="Time" help="Optional precision.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="time"
                    value={time}
                    disabled={precision !== "exact"}
                    aria-describedby={describedBy}
                    onChange={(event) => setTime(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label="How sure are you?"
                help="Recorded with the completion, so the history does not overstate what is known."
              >
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    describedBy={describedBy}
                    value={precision}
                    onValueChange={(value) => setPrecision(value as typeof precision)}
                    options={[
                      { value: "exact", label: "Exact date and time" },
                      { value: "day", label: "That day" },
                      { value: "month", label: "Sometime that month" },
                    ]}
                  />
                )}
              </Field>
            </div>
          ) : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who did it" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={performer}
                onValueChange={setPerformer}
                options={performerOptions}
              />
            )}
          </Field>
          <Field label="How long did it take" help="Minutes. Leave empty if you did not time it.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="number"
                min={0}
                step={5}
                inputMode="numeric"
                value={effort}
                aria-describedby={describedBy}
                onChange={(event) => setEffort(event.target.value)}
              />
            )}
          </Field>
        </div>

        <Field label="How did it go">
          {({ id, describedBy }) => (
            <Select
              id={id}
              describedBy={describedBy}
              value={outcome}
              onValueChange={(value) => setOutcome(value as typeof outcome)}
              options={[
                { value: "done", label: "Done" },
                { value: "done_with_issues", label: "Done, but something needs watching" },
                { value: "partial", label: "Partly done" },
              ]}
            />
          )}
        </Field>

        <Field label="Notes" help="What you noticed. This is the part future-you reads.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              rows={3}
              value={notes}
              aria-describedby={describedBy}
              placeholder="Outer filter was much dirtier than the inner one; ordered two spares."
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>

        {materials.length > 0 ? (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-semibold text-ink">Materials used</legend>
            <p className="text-sm text-ink-3">
              Pre-filled from what this task expects. Change a quantity if reality differed — zero is
              a valid answer.
            </p>
            <ul className="flex flex-col gap-3">
              {rows.map((row) => {
                const line = materials.find((entry) => entry.partId === row.partId);
                const serverShort = serverShortLines.find((entry) => entry.partId === row.partId);
                const isShort = row.isShort || serverShort !== undefined;
                const draft = drafts.find((entry) => entry.partId === row.partId);
                return (
                  <li
                    key={row.partId}
                    className="rounded-md border border-line bg-surface-2 px-3 py-3"
                  >
                    <div className="flex flex-wrap items-end justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink">{row.partName}</p>
                        <p className="text-xs text-ink-3">
                          {line === undefined ? "" : `${describeSource(line.source)} · `}
                          expected {formatQty(row.expectedQtyMilli, row.unit)} ·{" "}
                          {formatQty(row.availableMilli, row.unit)} in stock
                          {line?.isRequired === false ? " · optional" : ""}
                        </p>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-ink-2">
                        <span>Used</span>
                        <Input
                          type="number"
                          min={0}
                          step={qtyStep(line?.trackingMode ?? "discrete")}
                          inputMode="decimal"
                          className="w-24"
                          value={qtyText[row.partId] ?? ""}
                          aria-label={`Quantity of ${row.partName} used, in ${row.unit}`}
                          onChange={(event) => setQty(row.partId, event.target.value)}
                        />
                        <span>{row.unit}</span>
                      </label>
                    </div>

                    {isShort ? (
                      <div className="mt-3 border-t border-line pt-3">
                        <p className="flex items-center gap-2 text-sm text-blocked">
                          <AlertTriangle aria-hidden="true" className="size-4" />
                          Stock says {formatQty(row.availableMilli, row.unit)}, you used{" "}
                          {formatQty(row.actualQtyMilli, row.unit)}.
                        </p>
                        <div className="mt-2">
                          <RadioGroup
                            ariaLabel={`What to do about the ${row.partName} shortfall`}
                            value={draft?.resolutionIfShort ?? ""}
                            onValueChange={(value) => setResolution(row.partId, value)}
                            options={SHORT_OPTIONS.map((option) => ({
                              value: option.value,
                              label: option.label,
                              hint: option.hint,
                            }))}
                          />
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {!resolutionsComplete(rows) && serverShortLines.length === 0 ? (
              <p className="text-sm text-ink-3">
                One or more lines look short against the ledger. You can submit anyway — the server
                re-checks and will ask what to do rather than guessing.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {assetName !== null ? (
          <fieldset className="flex flex-col gap-3 border-t border-line pt-4">
            <legend className="text-sm font-semibold text-ink">
              {isConditionTask ? "Was the unit replaced?" : "Equipment replacement"}
            </legend>
            <Checkbox
              checked={replacing}
              onCheckedChange={(value) => setReplacing(value === true)}
              label={`This completion replaced ${assetName}`}
              hint="Creates a new unit and keeps the old one's whole history. Plans move to the new unit; past completions stay on the old one."
            />
            {replacing ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Why was it replaced" required>
                  {({ id, describedBy }) => (
                    <Select
                      id={id}
                      describedBy={describedBy}
                      value={replacementReason}
                      onValueChange={(value) => setReplacementReason(value as ReplacementReason)}
                      options={REPLACEMENT_REASONS}
                    />
                  )}
                </Field>
                <Field label="New unit name" help={`Defaults to “${assetName}” if left empty.`}>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      value={newName}
                      aria-describedby={describedBy}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Manufacturer">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={newManufacturer}
                      onChange={(event) => setNewManufacturer(event.target.value)}
                    />
                  )}
                </Field>
                <Field label="Model">
                  {({ id }) => (
                    <Input id={id} value={newModel} onChange={(event) => setNewModel(event.target.value)} />
                  )}
                </Field>
                <Field label="Serial number">
                  {({ id }) => (
                    <Input id={id} value={newSerial} onChange={(event) => setNewSerial(event.target.value)} />
                  )}
                </Field>
                <div className="flex flex-col gap-2 sm:col-span-2">
                  <Checkbox
                    checked={cloneConsumables}
                    onCheckedChange={(value) => setCloneConsumables(value === true)}
                    label="Copy what the old unit consumes"
                    hint="Filters, batteries and the like, so the next task pre-fills correctly."
                  />
                  <Checkbox
                    checked={cloneHaLinks}
                    onCheckedChange={(value) => setCloneHaLinks(value === true)}
                    label="Copy the Home Assistant links"
                    hint="Only correct when the new unit is the same physical registry entry. Otherwise re-link it afterwards."
                  />
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {failure !== null && failure.error !== "insufficient_stock" ? (
          <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
            {messageFor(failure)}
          </p>
        ) : null}

        <p className="text-xs text-ink-3">
          Recorded as done by you.{" "}
          {performer.startsWith("provider:") ? (
            <>The provider is recorded as who performed the work; you are recorded as who logged it.</>
          ) : null}{" "}
          <Badge tone="neutral" size="sm">
            Submitting twice is safe — the same form only ever produces one completion.
          </Badge>
        </p>
      </div>
    </Dialog>
  );
}
