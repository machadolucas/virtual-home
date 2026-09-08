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
 * What each kind's numbers actually mean.
 *
 * The panel used to describe every rule as a battery percentage — "Below 15 %, clears above 30 %" —
 * whatever its kind, and filled the blanks with the household *battery* defaults. For three of the
 * four kinds that was a sentence about numbers the rule does not have and a fallback that does not
 * apply to it, so each kind carries its own wording here.
 */
interface KindCopy {
  /** Whether the two threshold fields mean anything for this kind. */
  hasThresholds: boolean;
  /** Suffix inside the threshold inputs. `condition_rule` stores both as 0–100 integers. */
  unit: string;
  lowLabel: string;
  clearLabel: string;
  lowHelp: string;
  clearHelp: string;
  /**
   * Whether a blank threshold falls back to `household_setting`. Only `low_battery` does:
   * `resolveRule` in `src/domain/condition.ts` reads those columns for that kind alone.
   */
  usesHouseholdDefaults: boolean;
}

const KIND_COPY: Record<ConditionRuleKind, KindCopy> = {
  low_battery: {
    hasThresholds: true,
    unit: "%",
    lowLabel: "Low below",
    clearLabel: "Clears above",
    lowHelp: "Blank uses the household default.",
    clearHelp: "Must be above the low level. Blank uses the household default.",
    usesHouseholdDefaults: true,
  },
  unavailable_device: {
    hasThresholds: false,
    unit: "",
    lowLabel: "Low level",
    clearLabel: "Clear level",
    lowHelp: "",
    clearHelp: "",
    usesHouseholdDefaults: false,
  },
  threshold_below: {
    hasThresholds: true,
    unit: "%",
    lowLabel: "Opens below",
    clearLabel: "Clears above",
    lowHelp: "Blank means no level is set — this kind has no household fallback.",
    clearHelp:
      "Must be above the opening level; the database enforces that gap. Blank means no clear level is set.",
    usesHouseholdDefaults: false,
  },
  threshold_above: {
    hasThresholds: true,
    unit: "%",
    lowLabel: "Opens above",
    clearLabel: "Clear level",
    lowHelp: "Blank means no level is set — this kind has no household fallback.",
    clearHelp:
      "The database requires the clear level to be the higher of the two numbers, whichever way round this kind reads. Blank means no clear level is set.",
    usesHouseholdDefaults: false,
  },
};

/**
 * `resolveRule` matches on `kind = 'low_battery'` at every level of its precedence chain, so a
 * rule of any other kind is stored and shown but never evaluated. Saying so is cheaper than
 * letting somebody build a rule and wait for a task that cannot arrive.
 */
function evaluatedYet(kind: ConditionRuleKind): boolean {
  return kind === "low_battery";
}

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
  entities,
  entitiesTruncated,
  parts,
  householdDefaults,
}: {
  rules: readonly RuleView[];
  assets: readonly RuleChoice[];
  /** Linkable entities, for a rule scoped to one entity. */
  entities: readonly RuleChoice[];
  /** The entity list is capped; say so rather than presenting a shortlist as everything. */
  entitiesTruncated: boolean;
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
        sitting on the line from opening and closing a task forever. On a{" "}
        <strong className="font-semibold text-ink">low battery</strong> rule — and only that kind —
        a blank field falls back to the household default: below{" "}
        <strong className="font-semibold text-ink">{householdDefaults.thresholdPct} %</strong>,
        clears above{" "}
        <strong className="font-semibold text-ink">{householdDefaults.clearPct} %</strong>,
        sustained {householdDefaults.sustainMinutes} min, recovered{" "}
        {householdDefaults.clearSustainMinutes} min. The other kinds have no such fallback, and a
        blank field on one of them is genuinely unset.
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
                    entities={entities}
                    entitiesTruncated={entitiesTruncated}
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
                      entityLabel: rule.entityId ?? "",
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
                {ruleSummary(rule, householdDefaults)}
              </p>
              {evaluatedYet(rule.kind as ConditionRuleKind) ? null : (
                <p className="flex items-start gap-1.5 text-xs leading-5 text-stale">
                  <span aria-hidden="true">&#9888;</span>
                  <span>
                    Nothing evaluates this kind yet — only low-battery rules are matched against
                    readings, so this one is recorded but will not open a task.
                  </span>
                </p>
              )}
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
          entities={entities}
          entitiesTruncated={entitiesTruncated}
          parts={parts}
          triggerLabel="New rule"
          initial={{
            name: "Low battery",
            kind: "low_battery",
            scope: "all_batteries",
            assetId: "",
            haEntityRegistryId: "",
            entityLabel: "",
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
  /** `entity_id` of `haEntityRegistryId`, so a target outside the capped list still has a name. */
  entityLabel: string;
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
  entities,
  entitiesTruncated,
  parts,
  triggerLabel,
  iconOnly = false,
}: {
  initial: RuleDraft;
  assets: readonly RuleChoice[];
  entities: readonly RuleChoice[];
  entitiesTruncated: boolean;
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

  const copy = KIND_COPY[draft.kind];

  // A rule can point at an entity the capped list does not contain (it is hidden, diagnostic, or
  // simply beyond the cap). Dropping it from the options would silently retarget the rule on the
  // next save, so the current value is always present.
  const entityOptions =
    draft.haEntityRegistryId !== "" &&
    !entities.some((entity) => entity.value === draft.haEntityRegistryId)
      ? [
          {
            value: draft.haEntityRegistryId,
            label: draft.entityLabel === "" ? draft.haEntityRegistryId : draft.entityLabel,
            hint: "currently targeted; not in the list above",
          },
          ...entities,
        ]
      : entities;

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
            <Field label="Which equipment" required error={call.fieldErrors["assetId"]?.[0]}>
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  value={draft.assetId === "" ? NO_TARGET : draft.assetId}
                  onValueChange={(value) => set("assetId", value === NO_TARGET ? "" : value)}
                  options={[{ value: NO_TARGET, label: "Choose equipment…" }, ...assets]}
                />
              )}
            </Field>
          ) : null}
          {/* Without this the “One specific entity” scope was unreachable: the server refuses the
              save (`haEntityRegistryId` is required for it) and nothing on screen said which field
              was missing, because the field did not exist. */}
          {draft.scope === "entity" ? (
            <Field
              label="Which entity"
              required
              help={
                entityOptions.length === 0
                  ? "The registry cache holds no linkable entities yet, so there is nothing to point at."
                  : entitiesTruncated
                    ? "The first 400 entities the registry cache holds, by entity id. If the one you want is not here, link it from its device first."
                    : "Every linkable entity in the registry cache, by entity id."
              }
              error={call.fieldErrors["haEntityRegistryId"]?.[0]}
            >
              {({ id, describedBy, invalid }) => (
                <Select
                  id={id}
                  describedBy={describedBy}
                  invalid={invalid}
                  value={draft.haEntityRegistryId === "" ? NO_TARGET : draft.haEntityRegistryId}
                  onValueChange={(value) =>
                    set("haEntityRegistryId", value === NO_TARGET ? "" : value)
                  }
                  options={[{ value: NO_TARGET, label: "Choose an entity…" }, ...entityOptions]}
                />
              )}
            </Field>
          ) : null}
        </div>

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          {/* “Device unavailable” has no reading to compare, so it has no levels — showing two
              percentage boxes for it invited numbers that mean nothing. */}
          {copy.hasThresholds ? (
            <>
              <Field label={copy.lowLabel} help={copy.lowHelp}>
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={draft.thresholdPct}
                    onChange={(event) => set("thresholdPct", event.target.value)}
                    trailing={<span className="text-xs text-ink-3">{copy.unit}</span>}
                  />
                )}
              </Field>
              <Field
                label={copy.clearLabel}
                help={copy.clearHelp}
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
                    trailing={<span className="text-xs text-ink-3">{copy.unit}</span>}
                  />
                )}
              </Field>
            </>
          ) : (
            <p className="text-xs leading-5 text-ink-3 sm:col-span-2">
              A device is either reporting or it is not, so this kind has no levels — only the two
              “for at least” times below.
            </p>
          )}
          <Field
            label="Low for at least"
            help={
              copy.usesHouseholdDefaults
                ? "Blank uses the household default."
                : "Blank means no minimum is set."
            }
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={draft.sustainMinutes}
                onChange={(event) => set("sustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>
          <Field
            label="Recovered for at least"
            help={
              copy.usesHouseholdDefaults
                ? "Blank uses the household default."
                : "Blank means no minimum is set."
            }
          >
            {({ id, describedBy }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                value={draft.clearSustainMinutes}
                onChange={(event) => set("clearSustainMinutes", event.target.value)}
                trailing={<span className="text-xs text-ink-3">minutes</span>}
              />
            )}
          </Field>
          {evaluatedYet(draft.kind) ? null : (
            <p className="flex items-start gap-1.5 text-xs leading-5 text-stale sm:col-span-2">
              <span aria-hidden="true">&#9888;</span>
              <span>
                Only low-battery rules are matched against readings today. A rule of this kind is
                saved and listed, but nothing opens a task from it yet.
              </span>
            </p>
          )}
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

interface HouseholdDefaults {
  thresholdPct: number;
  clearPct: number;
  sustainMinutes: number;
  clearSustainMinutes: number;
}

/**
 * One sentence describing what this specific rule watches.
 *
 * Branching on `kind` is the whole point: the previous single sentence claimed every rule was a
 * battery percentage rule and filled its blanks with the household *battery* defaults, so an
 * `unavailable_device` rule read as "Below 15 %, clears above 30 %" — three false statements in a
 * row about a rule that has no levels at all.
 */
function ruleSummary(rule: RuleView, defaults: HouseholdDefaults): string {
  const kind = rule.kind as ConditionRuleKind;
  const copy = KIND_COPY[kind] ?? KIND_COPY.low_battery;

  const level = (value: number | null, fallback: number): string =>
    value === null
      ? copy.usesHouseholdDefaults
        ? `${fallback} ${copy.unit} (household default)`
        : "no level set"
      : `${value} ${copy.unit}`.trim();

  const minutes = (value: number | null, fallback: number): string =>
    value === null
      ? copy.usesHouseholdDefaults
        ? `${fallback} min (household default)`
        : "no minimum"
      : `${value} min`;

  const sustain = minutes(rule.sustainMinutes, defaults.sustainMinutes);
  const clearSustain = minutes(rule.clearSustainMinutes, defaults.clearSustainMinutes);

  if (kind === "unavailable_device") {
    return `Opens when it stops reporting for ${sustain}, clears once it reports again for ${clearSustain}.`;
  }

  const low = level(rule.thresholdPct, defaults.thresholdPct);
  const clear = level(rule.clearThresholdPct, defaults.clearPct);
  const direction = kind === "threshold_above" ? "Above" : "Below";
  return `${direction} ${low} for ${sustain}, clears at ${clear} for ${clearSustain}.`;
}

function optionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number.parseInt(trimmed, 10);
  return Number.isFinite(value) ? value : null;
}
