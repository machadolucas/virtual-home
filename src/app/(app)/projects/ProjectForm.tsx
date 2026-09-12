"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectKind, ProjectStatus } from "@/db/schema/infrastructure";
// The enum *values* come from the client-safe mirrors, so drizzle stays out of the browser bundle.
import { PROJECT_KINDS, PROJECT_STATUSES } from "@/features/projects/wire";
import { useAction } from "@/features/settings/actionClient";
import {
  PROJECT_KIND_LABEL,
  PROJECT_STATUS_LABEL,
  formatCents,
  parseCents,
} from "@/features/projects/labels";
import { createProject, updateProject } from "@/server/actions/infrastructure/projects";
import { Button, Field, Input, Panel, Select, Textarea } from "@/ui";

export interface ProjectFormValues {
  id?: string;
  name: string;
  kind: ProjectKind;
  status: ProjectStatus;
  startedOn: string;
  endedOn: string;
  budget: string;
  actualCost: string;
  summary: string;
  notes: string;
}

export const EMPTY_PROJECT: ProjectFormValues = {
  name: "",
  kind: "renovation",
  status: "idea",
  startedOn: "",
  endedOn: "",
  budget: "",
  actualCost: "",
  summary: "",
  notes: "",
};

/**
 * One form for both creating and editing, because the fields are identical and two copies would
 * drift.
 *
 * Money is typed as a human types it ("1 234,50", "1234.50 €") and parsed to integer cents on
 * submit; an unparseable amount blocks the submit with a message rather than quietly becoming
 * zero, because a budget of 0 € and an unrecorded budget mean very different things.
 */
export function ProjectForm({
  initial,
  submitLabel,
}: {
  initial: ProjectFormValues;
  submitLabel: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProjectFormValues>(initial);
  const [moneyError, setMoneyError] = useState<string | null>(null);

  const editing = initial.id !== undefined;
  const create = useAction(createProject, {
    successTitle: "Project created",
    onSuccess: (data) => router.push(`/projects/${data.id}`),
  });
  const update = useAction(updateProject, {
    successTitle: "Project saved",
    onSuccess: () => router.refresh(),
  });
  const active = editing ? update : create;

  const set = <K extends keyof ProjectFormValues>(key: K, value: ProjectFormValues[K]): void =>
    setValues((v) => ({ ...v, [key]: value }));

  const submit = (): void => {
    setMoneyError(null);
    const budgetCents = values.budget.trim() === "" ? null : parseCents(values.budget);
    const actualCostCents =
      values.actualCost.trim() === "" ? null : parseCents(values.actualCost);
    if (budgetCents === null && values.budget.trim() !== "") {
      setMoneyError("The budget is not an amount. Try 1 234,50.");
      return;
    }
    if (actualCostCents === null && values.actualCost.trim() !== "") {
      setMoneyError("The actual cost is not an amount. Try 1 234,50.");
      return;
    }
    const payload = {
      name: values.name,
      kind: values.kind,
      status: values.status,
      startedOn: values.startedOn === "" ? null : values.startedOn,
      endedOn: values.endedOn === "" ? null : values.endedOn,
      budgetCents,
      actualCostCents,
      currency: "EUR",
      summary: values.summary,
      notes: values.notes,
    };
    if (editing) update.run({ ...payload, id: initial.id as string });
    else create.run({ ...payload, idempotencyKey: create.idempotencyKey });
  };

  const fieldError = (key: string): string | undefined => active.fieldErrors[key]?.[0];

  return (
    <Panel
      title={editing ? "Details" : "New project"}
      subtitle="Costs are in euros. Dates are household calendar dates."
      footer={
        active.error ? (
          <span role="alert" className="text-overdue">
            {active.error}
          </span>
        ) : null
      }
    >
      <form data-unsaved
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Name" required error={fieldError("name")}>
          {({ id, describedBy, invalid, errorId }) => (
            <Input
              id={id}
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              aria-errormessage={errorId}
              required
              maxLength={200}
              placeholder="Bathroom renovation"
            />
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" error={fieldError("kind")}>
            {({ id }) => (
              <Select
                id={id}
                value={values.kind}
                onValueChange={(v) => set("kind", v as ProjectKind)}
                options={PROJECT_KINDS.map((k) => ({ value: k, label: PROJECT_KIND_LABEL[k] }))}
              />
            )}
          </Field>
          <Field
            label="Status"
            help="Marking a project done changes no maintenance history — the timeline comes from linked completions."
            error={fieldError("status")}
          >
            {({ id }) => (
              <Select
                id={id}
                value={values.status}
                onValueChange={(v) => set("status", v as ProjectStatus)}
                options={PROJECT_STATUSES.map((s) => ({
                  value: s,
                  label: PROJECT_STATUS_LABEL[s],
                }))}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Started on" error={fieldError("startedOn")}>
            {({ id }) => (
              <Input
                id={id}
                type="date"
                value={values.startedOn}
                onChange={(e) => set("startedOn", e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Ended on"
            help="An end date needs a start date."
            error={fieldError("endedOn")}
          >
            {({ id }) => (
              <Input
                id={id}
                type="date"
                value={values.endedOn}
                onChange={(e) => set("endedOn", e.target.value)}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Budget"
            help={values.budget.trim() === "" ? "Leave empty if there was no budget." : undefined}
            error={moneyError ?? fieldError("budgetCents")}
          >
            {({ id }) => (
              <Input
                id={id}
                inputMode="decimal"
                value={values.budget}
                onChange={(e) => set("budget", e.target.value)}
                trailing={<span className="text-xs text-ink-3">€</span>}
                placeholder="4 500,00"
              />
            )}
          </Field>
          <Field label="Actual cost" error={fieldError("actualCostCents")}>
            {({ id }) => (
              <Input
                id={id}
                inputMode="decimal"
                value={values.actualCost}
                onChange={(e) => set("actualCost", e.target.value)}
                trailing={<span className="text-xs text-ink-3">€</span>}
                placeholder="4 812,40"
              />
            )}
          </Field>
        </div>

        <Field label="Summary" help="One or two lines, shown in the list." error={fieldError("summary")}>
          {({ id }) => (
            <Textarea
              id={id}
              rows={2}
              maxLength={1000}
              value={values.summary}
              onChange={(e) => set("summary", e.target.value)}
            />
          )}
        </Field>

        <Field label="Notes" error={fieldError("notes")}>
          {({ id }) => (
            <Textarea
              id={id}
              rows={6}
              maxLength={8000}
              value={values.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          )}
        </Field>

        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-line bg-surface/95 py-3 backdrop-blur">
          <Button type="submit" variant="primary" loading={active.pending}>
            {submitLabel}
          </Button>
          <Button data-discard-editor type="button" variant="ghost" onClick={() => router.back()}>
            Cancel
          </Button>
          {values.budget.trim() !== "" && parseCents(values.budget) !== null ? (
            <span className="text-xs text-ink-3">
              Stored as {formatCents(parseCents(values.budget))}
            </span>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}
