"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { CONDITION_RULE_KINDS, PRIORITIES, type ConditionRuleKind } from "@/db/schema";
import { Badge, Button, Dialog, Field, IconButton, Input, Select, Switch } from "@/ui";
import { useAction } from "@/features/settings/actionClient";
import {
  deleteConditionRule,
  setConditionRuleEnabled,
  upsertConditionRule,
} from "@/server/actions/ha/rules";

const NO_TARGET = "__none";

export interface RuleView {
  id: string;
  name: string;
  kind: string;
  scope: string;
  enabled: boolean;
  thresholdPct: number | null;
  clearThresholdPct: number | null;
  sustainMinutes: number | null;
  clearSustainMinutes: number | null;
  assetId: string | null;
  assetName: string | null;
  haEntityRegistryId: string | null;
  entityId: string | null;
  defaultPartId: string | null;
  defaultPartName: string | null;
  titleTemplate: string;
  priority: string;
}

export interface RuleChoice {
  value: string;
  label: string;
  hint?: string;
}

const KIND_LABEL: Record<ConditionRuleKind, string> = {
  low_battery: "Low battery",
  unavailable_device: "Device unavailable",
  threshold_below: "Reading below a value",
  threshold_above: "Reading above a value",
};

/**
 * Condition rules: what turns a Home Assistant reading into a task.
 *
 * The panel says out loud what the household defaults are, because a rule with blank thresholds is
 * not a rule with no thresholds — it falls back to the household settings, and a blank field that
 * silently means "15 %" is the kind of thing nobody discovers until a battery dies.
 */
export function RulesPanel({
  rules,
  assets,
  parts,
  householdDefaults,
}: {
  rules: readonly RuleView[];
  assets: readonly RuleChoice[];
  parts: readonly RuleChoice[];
  householdDefaults: {
    thresholdPct: number;
    clearPct: number;
    sustainMinutes: number;
    clearSustainMinutes: number;
  };
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-sm leading-6 text-ink-2">
        A rule watches a reading and opens a task when it stays out of range. The gap between the
        low level and the clear level, plus the two “for at least” times, are what stop a battery
        sitting on the line from opening and closing a task forever. Leave a field blank to use the
        household default: below{" "}
        <strong className="font-semibold text-ink">{householdDefaults.thresholdPct} %</strong>,
        clears above{" "}
        <strong className="font-semibold text-ink">{householdDefaults.clearPct} %</strong>,
        sustained {householdDefaults.sustainMinutes} min, recovered{" "}
        {householdDefaults.clearSustainMinutes} min.
      </p>

      {rules.length === 0 ? (
        <p className="text-sm text-ink-3">
          No rules yet. Without one, battery levels are shown but never become work.
        </p>
      ) : (
        <ul className="flex list-none flex-col divide-y divide-line rounded-md border border-line">
          {rules.map((rule) => (
            <li key={rule.id} className="flex flex-col gap-1.5 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-ink">{rule.name}</span>
                <Badge tone="neutral" size="sm">
                  {KIND_LABEL[rule.kind as ConditionRuleKind] ?? rule.kind}
                </Badge>
                <Badge tone="neutral" size="sm">
                  {rule.scope === "all_batteries"
                    ? "Every battery"
                    : rule.scope === "asset"
                      ? (rule.assetName ?? "one unit")
                      : (rule.entityId ?? "one entity")}
                </Badge>
                <span className="ml-auto flex items-center gap-1">
                  <ToggleRule ruleId={rule.id} enabled={rule.enabled} name={rule.name} />
                  <RuleDialog
                    assets={assets}
                    parts={parts}
                    triggerLabel={`Edit ${rule.name}`}
                    iconOnly
                    initial={{
                      ruleId: rule.id,
                      name: rule.name,
                      kind: rule.kind as ConditionRuleKind,
                      scope: rule.scope as "all_batteries" | "asset" | "entity",
                      assetId: rule.assetId ?? "",
                      haEntityRegistryId: rule.haEntityRegistryId ?? "",
                      thresholdPct: rule.thresholdPct === null ? "" : String(rule.thresholdPct),
                      clearThresholdPct:
                        rule.clearThresholdPct === null ? "" : String(rule.clearThresholdPct),
                      sustainMinutes:
                        rule.sustainMinutes === null ? "" : String(rule.sustainMinutes),
                      clearSustainMinutes:
                        rule.clearSustainMinutes === null
                          ? ""
                          : String(rule.clearSustainMinutes),
                      defaultPartId: rule.defaultPartId ?? "",
                      priority: rule.priority,
                      titleTemplate: rule.titleTemplate,
                      enabled: rule.enabled,
                    }}
                  />
                  <DeleteRule ruleId={rule.id} name={rule.name} />
                </span>
              </div>

              <p className="vh-tnum text-xs leading-5 text-ink-2">
                Below {rule.thresholdPct ?? householdDefaults.thresholdPct} %
                {rule.sustainMinutes === null
                  ? ` for ${householdDefaults.sustainMinutes} min (household default)`
                  : ` for ${rule.sustainMinutes} min`}
                , clears above {rule.clearThresholdPct ?? householdDefaults.clearPct} %
                {rule.clearSustainMinutes === null
                  ? ` for ${householdDefaults.clearSustainMinutes} min (household default)`
                  : ` for ${rule.clearSustainMinutes} min`}
                .
              </p>
              <p className="text-xs leading-5 text-ink-3">
                Opens “{rule.titleTemplate}” at {rule.priority} priority
                {rule.defaultPartName === null
                  ? ", with no part on the line unless the unit declares one"
                  : `, consuming ${rule.defaultPartName} when the unit declares nothing`}
                .
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <RuleDialog
          assets={assets}
          parts={parts}
          triggerLabel="New rule"
          initial={{
            name: "Low battery",
            kind: "low_battery",
            scope: "all_batteries",
            assetId: "",
            haEntityRegistryId: "",
            thresholdPct: "",
            clearThresholdPct: "",
            sustainMinutes: "",
            clearSustainMinutes: "",
            defaultPartId: "",
            priority: "normal",
            titleTemplate: "Replace battery: {{asset}}",
            enabled: true,
          }}
        />
        <span className="text-xs text-ink-3">
          Switching a rule off closes its open episodes but leaves the tasks it opened open — a job
          nobody did is still a job.
        </span>
      </div>
    </div>
  );
}

interface RuleDraft {
  ruleId?: string;
  name: string;
  kind: ConditionRuleKind;
  scope: "all_batteries" | "asset" | "entity";
  assetId: string;
  haEntityRegistryId: string;
  thresholdPct: string;
  clearThresholdPct: string;
  sustainMinutes: string;
  clearSustainMinutes: string;
  defaultPartId: string;
  priority: string;
  titleTemplate: string;
  enabled: boolean;
}

function RuleDialog({
  initial,
  assets,
  parts,
  triggerLabel,
  iconOnly = false,
}: {
  initial: RuleDraft;
  assets: readonly RuleChoice[];
  parts: readonly RuleChoice[];
  triggerLabel: string;
  iconOnly?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initial);
  const editing = initial.ruleId !== undefined;

  const call = useAction(upsertConditionRule, {
    successTitle: editing ? "Rule saved" : "Rule created",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      trigger={
        iconOnly ? (
          <IconButton
            label={triggerLabel}
            variant="ghost"
            size="sm"
            icon={<Pencil aria-hidden="true" />}
          />
        ) : (
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
            {triggerLabel}
          </Button>
        )
      }
      title={editing ? `Edit ${initial.name}` : "New condition rule"}
      description="Turns a reading into a task, with the hysteresis that stops it flapping."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button
            loading={call.pending}
            disabled={draft.name.trim() === "" || draft.titleTemplate.trim() === ""}
            onClick={() =>
              call.run({
                ruleId: draft.ruleId ?? null,
                name: draft.name,
                kind: draft.kind,
                scope: draft.scope,
                assetId: draft.scope === "asset" && draft.assetId !== "" ? draft.assetId : null,
                haEntityRegistryId:
                  draft.scope === "entity" && draft.haEntityRegistryId !== ""
                    ? draft.haEntityRegistryId
                    : null,
                thresholdPct: optionalInt(draft.thresholdPct),
                clearThresholdPct: optionalInt(draft.clearThresholdPct),
                sustainMinutes: optionalInt(draft.sustainMinutes),
                clearSustainMinutes: optionalInt(draft.clearSustainMinutes),
                defaultPartId: draft.defaultPartId === "" ? null : draft.defaultPartId,
                priority: draft.priority as (typeof PRIORITIES)[number],
                titleTemplate: draft.titleTemplate,
                enabled: draft.enabled,
              })
            }
          >
            {editing ? "Save" : "Create it"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            {({ id }) => (
              <Input
                id={id}
                value={draft.name}
                onChange={(event) => set("name", event.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Field label="What it watches" required>
            {({ id }) => (
              <Select
                id={id}
                value={draft.kind}
                onValueChange={(value) => set("kind", value as ConditionRuleKind)}
                options={CONDITION_RULE_KINDS.map((kind) => ({
                  value: kind,
                  label: KIND_LABEL[kind],
                }))}
              />
            )}
          </Field>
          <Field
            label="Scope"
            required
            help="“Every battery” covers each device's canonical battery entity, which is the one the app picks and verifies numerically."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={draft.scope}
                onValueChange={(value) =>
                  set("scope", value as "all_batteries" | "asset" | "entity")
                }
                options={[
                  { value: "all_batteries", label: "Every battery in the house" },
                  { value: "asset", label: "One piece of equipment" },
                  { value: "entity", label: "One specific entity" },
                ]}
              />
            )}
          </Field>
          {draft.scope === "asset" ? (
            <Field label="Which equipment" required>
              {({ id }) => (
                <Select
                  id={id}
                  value={draft.assetId === "" ? NO_TARGET : draft.assetId}
                  onValueChange={(value) => set("assetId", value === NO_TARGET ? "" : value)}
                  options={[{ value: NO_TARGET, label: "Choose equipment…" }, ...assets]}
                />
              )}
            </Field>
          ) : null}
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field label="Low below" help="Blank uses the household default.">
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={draft.thresholdPct}
                onChange={(event) => set("thresholdPct", event.target.value)}
                trailing={<span className="text-xs text-ink-3">%</span>}
              />
            )}
          </Field>
          <Field
            label="Clears above"
            help="Must be above the low level. Blank uses the household default."
            error={call.fieldErrors["clearThresholdPct"]?.[0]}
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                inputMode="numeric"
                value={draft.clearThresholdPct}
                onChange={(event) => set("clearThresholdPct", event.target.value)}
                trailing={<span className="text-xs text-ink-3">%</span>}
              />
            )}
          </Field>
          <Field label="Low for at least">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={draft.sustainMinutes}
                onChange={(event) => set("sustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>
          <Field label="Recovered for at least">
            {({ id }) => (
              <Input
                id={id}
                inputMode="numeric"
                value={draft.clearSustainMinutes}
                onChange={(event) => set("clearSustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <Field
            label="Task title"
            required
            help="{{asset}} is replaced with the name of the equipment."
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                value={draft.titleTemplate}
                onChange={(event) => set("titleTemplate", event.target.value)}
              />
            )}
          </Field>
          <Field label="Priority">
            {({ id }) => (
              <Select
                id={id}
                value={draft.priority}
                onValueChange={(value) => set("priority", value)}
                options={PRIORITIES.map((priority) => ({ value: priority, label: priority }))}
              />
            )}
          </Field>
          <Field
            label="Part to use"
            className="sm:col-span-2"
            help="Only used when the equipment itself declares no battery. Its own declaration always wins."
          >
            {({ id, describedBy }) => (
              <Select
                id={id}
                describedBy={describedBy}
                value={draft.defaultPartId === "" ? NO_TARGET : draft.defaultPartId}
                onValueChange={(value) => set("defaultPartId", value === NO_TARGET ? "" : value)}
                options={[{ value: NO_TARGET, label: "None" }, ...parts]}
              />
            )}
          </Field>
        </div>

        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => set("enabled", checked)}
          label="This rule is on"
          hint="Switching it off closes its open episodes and stops watching. Tasks it already opened stay open."
        />

        {call.error === null ? null : (
          <p role="alert" className="text-sm font-medium text-overdue">
            {call.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function ToggleRule({
  ruleId,
  enabled,
  name,
}: {
  ruleId: string;
  enabled: boolean;
  name: string;
}) {
  const router = useRouter();
  const call = useAction(setConditionRuleEnabled, { onSuccess: () => router.refresh() });
  return (
    <Switch
      checked={enabled}
      disabled={call.pending}
      onCheckedChange={(checked) => call.run({ ruleId, enabled: checked })}
      ariaLabel={enabled ? `Switch off ${name}` : `Switch on ${name}`}
    />
  );
}

function DeleteRule({ ruleId, name }: { ruleId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const call = useAction(deleteConditionRule, {
    successTitle: "Rule deleted",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <IconButton
          label={`Delete ${name}`}
          variant="ghost"
          size="sm"
          icon={<Trash2 aria-hidden="true" />}
        />
      }
      title={`Delete ${name}?`}
      description="A rule that has already produced tasks cannot be deleted — those tasks were real. Disabling it is the honest alternative."
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={call.pending}>
            Cancel
          </Button>
          <Button variant="danger" loading={call.pending} onClick={() => call.run({ ruleId })}>
            Delete it
          </Button>
        </>
      }
    >
      <p className="text-sm leading-6 text-ink-2">
        If the deletion is refused, that is the database protecting the tasks this rule opened. Turn
        the rule off instead: it stops watching and keeps the record of what it once did.
      </p>
      {call.error === null ? null : (
        <p role="alert" className="mt-3 text-sm font-medium text-overdue">
          {call.error}
        </p>
      )}
    </Dialog>
  );
}

function optionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}
