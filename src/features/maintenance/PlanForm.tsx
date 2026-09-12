"use client";
/**
 * Creating and editing a maintenance plan.
 *
 * One page rather than a step-by-step wizard: every answer affects the schedule preview, and a
 * wizard would hide the preview behind a "next" button. The sections are ordered the way the
 * question is actually asked — what, where, how often, when did it last happen, who, and what does
 * it need.
 *
 * The **initial setup** section is the one that must not be got wrong. Everything it offers writes
 * a *schedule anchor*; none of it writes a completion. "Sometime in spring 2024" produces an
 * immediately-overdue first task and an empty history, which is the truth (§2.4).
 */
import { ProviderPicker } from "@/features/providers/ProviderPicker";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Save, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  Panel,
  RadioGroup,
  Select,
  Textarea,
} from "@/ui";
import type { Priority } from "@/db/schema/maintenance";
import type { PartUnit } from "@/db/schema/inventory";
import {
  cancelPlanAction,
  createPlan,
  seedPlan,
  updatePlan,
} from "@/server/actions/maintenance/plans";
import { messageFor, useAction } from "./useAction";
import { SchedulePicker } from "./SchedulePicker";
import { formatQty, parseQty } from "./materials";
import {
  DEFAULT_SCHEDULE_FORM,
  SEED_EXPLANATIONS,
  toRecurrenceRule,
  type ScheduleFormState,
  type SeedExplanationKind,
} from "./schedule";

export interface PickerOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PlanFormMaterial {
  partId: string;
  qtyMilli: number;
  isRequired: boolean;
}

export interface PlanFormValues {
  target: string;
  title: string;
  description: string;
  procedureId: string;
  schedule: ScheduleFormState;
  assignmentMode: "user" | "shared";
  assigneeUserId: string;
  priority: Priority;
  estimatedMinutes: string;
  requiresProfessional: boolean;
  defaultProviderId: string;
  materials: PlanFormMaterial[];
  status: "active" | "paused";
}

export interface PlanFormProps {
  mode: "create" | "edit";
  planId?: string;
  initial?: Partial<PlanFormValues>;
  targets: readonly PickerOption[];
  procedures: readonly PickerOption[];
  parts: readonly (PickerOption & { unit: PartUnit })[];
  providers: readonly PickerOption[];
  members: readonly { id: string; name: string }[];
  today: string;
  /** The plan's current anchor, for the preview. Ignored while creating. */
  anchorDate: string | null;
  /** Show the "when was this last done?" section (always on create; on edit when unanswered). */
  askSetup: boolean;
  canCancel?: boolean;
}

const NO_PROCEDURE = "__none__";
const NO_PROVIDER = "__none__";

const PRIORITY_OPTIONS: { value: Priority; label: string; hint?: string }[] = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

export function PlanForm({
  mode,
  planId,
  initial,
  targets,
  procedures,
  parts,
  providers,
  members,
  today,
  anchorDate,
  askSetup,
  canCancel = false,
}: PlanFormProps) {
  const router = useRouter();

  const [target, setTarget] = useState(initial?.target ?? targets[0]?.value ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [procedureId, setProcedureId] = useState(initial?.procedureId ?? NO_PROCEDURE);
  const [schedule, setSchedule] = useState<ScheduleFormState>(
    initial?.schedule ?? DEFAULT_SCHEDULE_FORM,
  );
  const [assignmentMode, setAssignmentMode] = useState<"user" | "shared">(
    initial?.assignmentMode ?? "shared",
  );
  const [assigneeUserId, setAssigneeUserId] = useState(
    initial?.assigneeUserId ?? members[0]?.id ?? "",
  );
  const [priority, setPriority] = useState<Priority>(initial?.priority ?? "normal");
  const [estimatedMinutes, setEstimatedMinutes] = useState(initial?.estimatedMinutes ?? "");
  const [requiresProfessional, setRequiresProfessional] = useState(
    initial?.requiresProfessional ?? false,
  );
  const [defaultProviderId, setDefaultProviderId] = useState(
    initial?.defaultProviderId ?? NO_PROVIDER,
  );
  const [materials, setMaterials] = useState<PlanFormMaterial[]>(initial?.materials ?? []);
  const [status, setStatus] = useState<"active" | "paused">(initial?.status ?? "active");

  const [seedKind, setSeedKind] = useState<SeedExplanationKind>("baseline_exact");
  const [seedDate, setSeedDate] = useState(today);
  const [seedNote, setSeedNote] = useState("");

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const create = useAction(createPlan, { refresh: false });
  const update = useAction(updatePlan, { success: "Plan saved." });
  const seed = useAction(seedPlan, { success: "Starting point recorded. No completion was logged." });
  const cancel = useAction(cancelPlanAction, { refresh: false });

  const ruleResult = toRecurrenceRule(schedule);
  const canSave = target !== "" && title.trim() !== "" && ruleResult.ok &&
    (schedule.kind !== "one_off" || !askSetup || seedDate !== "");

  function seedPayload() {
    if (schedule.kind === "one_off") return { kind: "user_chosen" as const, date: seedDate };
    return {
      kind: seedKind,
      date: seedNeedsDate(seedKind) ? seedDate : undefined,
      note: seedNote.trim() === "" ? undefined : seedNote.trim(),
    };
  }

  function planPayload() {
    if (!ruleResult.ok) throw new Error("unreachable: guarded by canSave");
    return {
      target,
      title: title.trim(),
      description: description.trim() === "" ? null : description.trim(),
      procedureId: procedureId === NO_PROCEDURE ? null : procedureId,
      scheduleFormKind: schedule.kind,
      rule: ruleResult.rule,
      assignmentMode,
      assigneeUserId: assignmentMode === "user" ? assigneeUserId : null,
      priority,
      estimatedMinutes: estimatedMinutes.trim() === "" ? null : Number(estimatedMinutes),
      requiresProfessional,
      defaultProviderId: defaultProviderId === NO_PROVIDER ? null : defaultProviderId,
      materials: materials.map((line) => ({
        partId: line.partId,
        qtyMilli: line.qtyMilli,
        isRequired: line.isRequired,
      })),
      status,
    };
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    if (mode === "create") {
      const result = await create.run({
        plan: planPayload(),
        seed: seedPayload(),
        idempotencyKey: create.requestKey,
      });
      if (result !== null) router.push(`/plans/${result.planId}`);
      return;
    }
    if (planId === undefined) return;
    await update.run({ planId, plan: planPayload(), idempotencyKey: update.requestKey });
  }

  const failure = create.failure ?? update.failure ?? seed.failure ?? cancel.failure;
  const pending = create.pending || update.pending;

  return (
    <div data-unsaved className="flex flex-col gap-5">
      <Panel title="What and where">
        <div className="flex flex-col gap-4">
          <Field
            label="What needs doing"
            required
            help="How it should read on Today. “Replace the ventilation filters”, not “Maintenance”."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                value={title}
                aria-describedby={describedBy}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="What it is attached to"
            required
            help="One piece of equipment, one system, or one room. This is what the “Locate in house” link points at."
          >
            {({ id, describedBy }) =>
              targets.length === 0 ? (
                <p id={describedBy} className="text-sm text-ink-3">
                  Nothing to attach to yet. Equipment and rooms come from the house model and the
                  equipment pages.
                </p>
              ) : (
                <Select
                  id={id}
                  describedBy={describedBy}
                  value={target}
                  onValueChange={setTarget}
                  options={targets.map((option) => ({
                    value: option.value,
                    label: option.label,
                    hint: option.hint,
                  }))}
                />
              )
            }
          </Field>

          <Field label="Notes" help="Anything worth knowing that is not a step in a procedure.">
            {({ id, describedBy }) => (
              <Textarea
                id={id}
                rows={2}
                value={description}
                aria-describedby={describedBy}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Instructions"
            help="A published procedure is frozen onto each task as it is generated, so editing the procedure later never changes work already in progress."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={procedureId}
                onValueChange={setProcedureId}
                options={[
                  { value: NO_PROCEDURE, label: "No procedure" },
                  ...procedures.map((option) => ({
                    value: option.value,
                    label: option.label,
                    hint: option.hint,
                  })),
                ]}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="How often">
        <SchedulePicker
          value={schedule}
          onChange={setSchedule}
          anchorDate={mode === "create" ? (seedNeedsDate(seedKind) ? seedDate : today) : anchorDate}
        />
      </Panel>

      {askSetup ? (
        <Panel
          title={schedule.kind === "one_off" ? "Due date" : "When was this last done?"}
          subtitle={
            schedule.kind === "one_off"
              ? "Create one task for this date. Completing or skipping it will not create another task."
              : mode === "create"
              ? "This sets the starting point the schedule is measured from. It is never recorded as a completion — History stays empty until real work is logged."
              : "This plan is still waiting for a starting point, so it is paused and generates nothing. Answering here writes the anchor the schedule is measured from — never a completion, so History stays empty until real work is logged. It is its own act, separate from saving the rest of the form."
          }
        >
          <div className="flex flex-col gap-4">
            {schedule.kind !== "one_off" ? (
              <RadioGroup
                ariaLabel="Starting point"
                value={seedKind}
                onValueChange={(value) => setSeedKind(value as SeedExplanationKind)}
                options={SEED_EXPLANATIONS.map((entry) => ({
                  value: entry.kind,
                  label: entry.label,
                  hint: entry.plain,
                }))}
              />
            ) : null}
            {schedule.kind === "one_off" || seedNeedsDate(seedKind) ? (
              <Field
                label={schedule.kind === "one_off" ? "Due date" : seedKind === "baseline_approx" ? "Approximate date" : "Date"}
                required
                help={
                  schedule.kind !== "one_off" && seedKind === "baseline_approx"
                    ? "Pick roughly the middle of the period you mean, and say what you meant in the note below."
                    : undefined
                }
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    type="date"
                    value={seedDate}
                    aria-describedby={describedBy}
                    onChange={(event) => setSeedDate(event.target.value)}
                  />
                )}
              </Field>
            ) : null}
            {schedule.kind !== "one_off" && seedKind === "baseline_approx" ? (
              <Field label="In your words" help="Kept with the anchor, so nobody has to guess later.">
                {({ id }) => (
                  <Input
                    id={id}
                    value={seedNote}
                    placeholder="Sometime in spring 2024"
                    onChange={(event) => setSeedNote(event.target.value)}
                  />
                )}
              </Field>
            ) : null}
            {schedule.kind !== "one_off" && seedKind === "ask_later" ? (
              <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
                {mode === "create"
                  ? "The plan will be saved but paused, with no task generated. It will appear on Today under “Plans waiting for a starting point”."
                  : "That is where this plan already is: paused, with no task generated, listed on Today under “Plans waiting for a starting point”. Pick one of the answers above to get it running."}
              </p>
            ) : null}
            {/* Edit mode needs its own submit: "Save changes" writes the plan's fields, and a
                starting point is a different act with a different consequence (the plan unpauses
                and a first task appears). Folding it into the same button would make one press
                mean two things, and the seed would be invisible in the audit trail as its own
                decision. */}
            {mode === "edit" && planId !== undefined ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                <Button
                  variant="primary"
                  loading={seed.pending}
                  disabled={
                    (schedule.kind !== "one_off" && seedKind === "ask_later") ||
                    ((schedule.kind === "one_off" || seedNeedsDate(seedKind)) && seedDate.trim() === "")
                  }
                  onClick={() =>
                    void seed.run({
                      planId,
                      seed: seedPayload(),
                      idempotencyKey: seed.requestKey,
                    })
                  }
                >
                  {schedule.kind === "one_off" ? "Set the due date" : "Set the starting point"}
                </Button>
                <span className="text-xs text-ink-3">
                  Writes a schedule anchor and nothing else. No work is recorded as done.
                </span>
              </div>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel title="Who and how urgent">
        <div className="flex flex-col gap-4">
          <Field label="Assigned to" required>
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={assignmentMode === "shared" ? "shared" : `user:${assigneeUserId}`}
                onValueChange={(value) => {
                  if (value === "shared") {
                    setAssignmentMode("shared");
                  } else {
                    setAssignmentMode("user");
                    setAssigneeUserId(value.slice(5));
                  }
                }}
                options={[
                  { value: "shared", label: "Shared", hint: "Both members are reminded." },
                  ...members.map((member) => ({
                    value: `user:${member.id}`,
                    label: member.name,
                  })),
                ]}
              />
            )}
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  value={priority}
                  onValueChange={(value) => setPriority(value as Priority)}
                  options={PRIORITY_OPTIONS}
                />
              )}
            </Field>
            <Field label="Roughly how long" help="Minutes. Shown on the task so it can be slotted in.">
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  step={5}
                  inputMode="numeric"
                  value={estimatedMinutes}
                  aria-describedby={describedBy}
                  onChange={(event) => setEstimatedMinutes(event.target.value)}
                />
              )}
            </Field>
          </div>

          <Checkbox
            checked={requiresProfessional}
            onCheckedChange={(value) => setRequiresProfessional(value === true)}
            label="This normally needs a professional"
            hint="Puts “Book a professional” forward on the task. It does not stop you doing it yourself, and booking one still is not a completion."
          />

          {requiresProfessional ? (
            <Field label="Usual provider">
              {({ id, describedBy }) => (
                <ProviderPicker id={id} describedBy={describedBy} value={defaultProviderId} onValueChange={setDefaultProviderId} options={providers} emptyValue={NO_PROVIDER} emptyLabel="No default" />
              )}
            </Field>
          ) : null}

          <Field
            label="Status"
            help="A paused plan keeps its history and its schedule but generates no new tasks."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={status}
                onValueChange={(value) => setStatus(value as "active" | "paused")}
                options={[
                  { value: "active", label: "Active" },
                  { value: "paused", label: "Paused" },
                ]}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="What it needs"
        subtitle="Pre-fills the completion form and feeds the reorder list. The procedure's own materials are added on top of these."
      >
        <MaterialEditor parts={parts} materials={materials} onChange={setMaterials} />
      </Panel>

      {failure !== null ? (
        <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
          {messageFor(failure)}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <Button
          variant="primary"
          size="lg"
          loading={pending}
          disabled={!canSave}
          icon={<Save aria-hidden="true" />}
          onClick={() => void save()}
        >
          {mode === "create" ? "Create the plan" : "Save changes"}
        </Button>
        <Button data-discard-editor variant="ghost" size="lg" onClick={() => router.back()}>
          Cancel
        </Button>
        {canCancel && planId !== undefined ? (
          <Button
            variant="danger"
            size="lg"
            className="ms-auto"
            icon={<Trash2 aria-hidden="true" />}
            onClick={() => setCancelOpen(true)}
          >
            Cancel this plan
          </Button>
        ) : null}
      </div>

      {canCancel && planId !== undefined ? (
        <Dialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          size="sm"
          title="Cancel this plan"
          description="Closes the plan and its open task, and stops generating new ones. Recorded history is kept — cancelling a plan never deletes what was done."
          footer={
            <>
              <Button variant="ghost" onClick={() => setCancelOpen(false)}>
                Keep the plan
              </Button>
              <Button
                variant="danger"
                loading={cancel.pending}
                onClick={() =>
                  void cancel
                    .run({
                      planId,
                      reason: cancelReason.trim() === "" ? undefined : cancelReason.trim(),
                      idempotencyKey: cancel.requestKey,
                    })
                    .then((result) => {
                      if (result !== null) router.push("/plans");
                    })
                }
              >
                Cancel the plan
              </Button>
            </>
          }
        >
          <Field label="Why" help="Optional, and kept on the plan.">
            {({ id }) => (
              <Input
                id={id}
                value={cancelReason}
                placeholder="The unit was removed"
                onChange={(event) => setCancelReason(event.target.value)}
              />
            )}
          </Field>
        </Dialog>
      ) : null}
    </div>
  );
}

function seedNeedsDate(kind: SeedExplanationKind): boolean {
  return kind === "baseline_exact" || kind === "baseline_approx" || kind === "user_chosen";
}

function MaterialEditor({
  parts,
  materials,
  onChange,
}: {
  parts: readonly (PickerOption & { unit: PartUnit })[];
  materials: readonly PlanFormMaterial[];
  onChange: (next: PlanFormMaterial[]) => void;
}) {
  const [partId, setPartId] = useState(parts[0]?.value ?? "");
  const [qty, setQty] = useState("1");

  if (parts.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        No parts are defined yet. Add them under Supplies first, then come back — a plan can only
        require a part the inventory knows about.
      </p>
    );
  }

  const unitOf = (id: string): PartUnit => parts.find((part) => part.value === id)?.unit ?? "pcs";

  return (
    <div className="flex flex-col gap-3">
      {materials.length === 0 ? (
        <p className="text-sm text-ink-3">Nothing required yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materials.map((line, index) => (
            <li
              key={line.partId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface-2 px-3 py-2"
            >
              <span className="text-sm text-ink">
                {parts.find((part) => part.value === line.partId)?.label ?? line.partId}
              </span>
              <span className="flex items-center gap-2">
                <span className="vh-tnum text-sm text-ink-2">
                  {formatQty(line.qtyMilli, unitOf(line.partId))}
                </span>
                <Checkbox
                  checked={line.isRequired}
                  onCheckedChange={(value) =>
                    onChange(
                      materials.map((entry, i) =>
                        i === index ? { ...entry, isRequired: value === true } : entry,
                      ),
                    )
                  }
                  label="Required"
                />
                <IconButton
                  label={`Remove ${line.partId}`}
                  size="sm"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => onChange(materials.filter((_, i) => i !== index))}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Part" className="min-w-48 flex-1">
          {({ id }) => (
            <Select
              id={id}
              value={partId}
              onValueChange={setPartId}
              options={parts.map((part) => ({
                value: part.value,
                label: part.label,
                hint: part.hint,
              }))}
            />
          )}
        </Field>
        <Field label={`Quantity (${unitOf(partId)})`} className="w-32">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={0.001}
              step={0.001}
              inputMode="decimal"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
            />
          )}
        </Field>
        <Button
          variant="secondary"
          icon={<Plus aria-hidden="true" />}
          disabled={partId === "" || parseQty(qty) === null || parseQty(qty) === 0}
          onClick={() => {
            const parsed = parseQty(qty);
            if (parsed === null || parsed === 0) return;
            const existing = materials.some((line) => line.partId === partId);
            onChange(
              existing
                ? materials.map((line) =>
                    line.partId === partId ? { ...line, qtyMilli: parsed } : line,
                  )
                : [...materials, { partId, qtyMilli: parsed, isRequired: true }],
            );
            setQty("1");
          }}
        >
          Add
        </Button>
      </div>
      <p className="text-xs text-ink-3">
        <Badge tone="neutral" icon={null} size="sm">
          Quantities are exact
        </Badge>{" "}
        Two filters means two will be deducted from stock when the task is completed.
      </p>
    </div>
  );
}
