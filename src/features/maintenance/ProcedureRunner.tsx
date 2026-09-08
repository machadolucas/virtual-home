"use client";
/**
 * Working through the frozen procedure, one step at a time.
 *
 * The instructions shown are the occurrence's **frozen** `procedure_version` — not the procedure's
 * current version — so editing a procedure never changes the steps under somebody who is halfway
 * through the job.
 *
 * Progress is persisted per step and per checklist item (`occurrence_progress_item`), so the phone
 * locking itself, a navigation, or a server restart all resume at the first unfinished step.
 */
import { useState } from "react";
import { Check, ChevronDown, SkipForward, TriangleAlert } from "lucide-react";
import { Badge, Button, Checkbox, Field, Input, Panel, ProgressBar, cn } from "@/ui";
import { setChecklistProgress, setStepProgress } from "@/server/actions/maintenance/progress";
import { useAction } from "./useAction";
import { formatMinutes } from "./dueDate";
import {
  firstUnfinishedStepId,
  indexProgress,
  isSettled,
  summariseProgress,
  type ProgressLike,
} from "./progress";

export interface RunnerChecklistItem {
  id: string;
  text: string;
  requiresValue: "number" | "text" | "photo" | null;
  unit: string | null;
}

export interface RunnerStep {
  id: string;
  seq: number;
  title: string;
  bodyMd: string | null;
  expectedMinutes: number | null;
  isOptional: boolean;
  warning: string | null;
  checklist: RunnerChecklistItem[];
}

export interface ProcedureRunnerProps {
  occurrenceId: string;
  procedureTitle: string;
  version: number;
  versionStatus: "draft" | "published" | "superseded";
  prerequisites: string | null;
  safetyNotes: string | null;
  steps: readonly RunnerStep[];
  looseChecklist: readonly RunnerChecklistItem[];
  tools: readonly { id: string; name: string; isRequired: boolean; notes: string | null }[];
  progress: readonly ProgressLike[];
  /** Closed tasks show the same instructions, read-only, with what was recorded. */
  readOnly: boolean;
}

export function ProcedureRunner({
  occurrenceId,
  procedureTitle,
  version,
  versionStatus,
  prerequisites,
  safetyNotes,
  steps,
  looseChecklist,
  tools,
  progress,
  readOnly,
}: ProcedureRunnerProps) {
  const index = indexProgress(progress);
  const resumeAt = firstUnfinishedStepId(steps, progress);
  const summary = summariseProgress(steps, looseChecklist, progress);
  const [openStepId, setOpenStepId] = useState<string | null>(resumeAt ?? steps[0]?.id ?? null);

  const stepAction = useAction(setStepProgress, { refresh: true });
  const checkAction = useAction(setChecklistProgress, { refresh: true });

  return (
    <Panel
      title="Instructions"
      subtitle={`${procedureTitle} · version ${version}${versionStatus === "superseded" ? " (the version this task was created with)" : ""}`}
      actions={
        steps.length > 0 ? (
          <span className="vh-tnum text-xs text-ink-3">
            {summary.settled} of {summary.total} steps
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-4">
        {steps.length > 0 ? (
          <ProgressBar
            label="Procedure progress"
            value={summary.settled}
            max={summary.total}
            valueText={`${summary.settled} of ${summary.total} steps`}
          />
        ) : null}

        {safetyNotes !== null && safetyNotes.trim() !== "" ? (
          <div className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2">
            <p className="flex items-center gap-2 text-sm font-medium text-overdue">
              <TriangleAlert aria-hidden="true" className="size-4" />
              Safety
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{safetyNotes}</p>
          </div>
        ) : null}

        {prerequisites !== null && prerequisites.trim() !== "" ? (
          <section>
            <h3 className="text-sm font-semibold text-ink">Before you start</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{prerequisites}</p>
          </section>
        ) : null}

        {tools.length > 0 ? (
          <section>
            <h3 className="text-sm font-semibold text-ink">Tools</h3>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <Badge tone={tool.isRequired ? "neutral" : "accent"} icon={null} size="sm">
                    {tool.name}
                    {tool.isRequired ? "" : " (optional)"}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {steps.length === 0 ? (
          <p className="text-sm text-ink-3">
            This procedure version has no steps recorded. There is nothing to work through — the
            completion form still records what was done.
          </p>
        ) : (
          <ol className="flex flex-col gap-2">
            {steps.map((step, position) => {
              const state = index.stepState.get(step.id);
              const settled = isSettled(state);
              const isOpen = openStepId === step.id;
              return (
                <li
                  key={step.id}
                  className={cn(
                    "rounded-md border bg-surface-2",
                    settled ? "border-line" : "border-line-strong",
                    isOpen && "bg-surface",
                  )}
                >
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-3 px-3 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() => setOpenStepId(isOpen ? null : step.id)}
                  >
                    <span
                      className={cn(
                        "vh-tnum mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm border text-xs font-medium",
                        settled
                          ? "border-ok/45 bg-ok-soft text-ok"
                          : "border-line-strong bg-surface text-ink-2",
                      )}
                      aria-hidden="true"
                    >
                      {state === "done" ? "✓" : state === "skipped" ? "–" : position + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{step.title}</span>
                      <span className="mt-0.5 block text-xs text-ink-3">
                        {[
                          state === "done"
                            ? "Done"
                            : state === "skipped"
                              ? "Skipped"
                              : resumeAt === step.id
                                ? "Next"
                                : null,
                          formatMinutes(step.expectedMinutes),
                          step.isOptional ? "optional" : null,
                          step.checklist.length > 0
                            ? `${step.checklist.length} ${step.checklist.length === 1 ? "check" : "checks"}`
                            : null,
                        ]
                          .filter((piece): piece is string => piece !== null)
                          .join(" · ")}
                      </span>
                    </span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("mt-1 size-4 shrink-0 text-ink-3", isOpen && "rotate-180")}
                    />
                  </button>

                  {isOpen ? (
                    <div className="border-t border-line px-3 py-3">
                      {step.warning !== null && step.warning.trim() !== "" ? (
                        <p className="mb-3 flex items-start gap-2 rounded-md border border-due/45 bg-due-soft px-2.5 py-2 text-sm text-due">
                          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                          <span className="text-ink">{step.warning}</span>
                        </p>
                      ) : null}
                      {step.bodyMd !== null && step.bodyMd.trim() !== "" ? (
                        <p className="whitespace-pre-wrap text-sm leading-6 text-ink-2">
                          {step.bodyMd}
                        </p>
                      ) : null}

                      {step.checklist.length > 0 ? (
                        <ul className="mt-3 flex flex-col gap-2">
                          {step.checklist.map((item) => (
                            <ChecklistRow
                              key={item.id}
                              item={item}
                              state={index.checklistState.get(item.id)}
                              readOnly={readOnly}
                              pending={checkAction.pending}
                              onChange={(next) =>
                                void checkAction.run({
                                  occurrenceId,
                                  checklistItemId: item.id,
                                  stepId: step.id,
                                  state: next.state,
                                  valueText: next.valueText,
                                  valueNumber: next.valueNumber,
                                })
                              }
                            />
                          ))}
                        </ul>
                      ) : null}

                      {readOnly ? null : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            variant={state === "done" ? "secondary" : "primary"}
                            size="sm"
                            loading={stepAction.pending}
                            icon={<Check aria-hidden="true" />}
                            onClick={() => {
                              void stepAction.run({
                                occurrenceId,
                                stepId: step.id,
                                state: state === "done" ? "todo" : "done",
                              });
                              const next = steps[position + 1];
                              if (state !== "done" && next) setOpenStepId(next.id);
                            }}
                          >
                            {state === "done" ? "Mark not done" : "Step done"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={stepAction.pending}
                            icon={<SkipForward aria-hidden="true" />}
                            onClick={() => {
                              void stepAction.run({
                                occurrenceId,
                                stepId: step.id,
                                state: state === "skipped" ? "todo" : "skipped",
                              });
                              const next = steps[position + 1];
                              if (state !== "skipped" && next) setOpenStepId(next.id);
                            }}
                          >
                            {state === "skipped" ? "Un-skip" : "Skip this step"}
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        {looseChecklist.length > 0 ? (
          <section>
            <h3 className="text-sm font-semibold text-ink">Final checks</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {looseChecklist.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  state={index.checklistState.get(item.id)}
                  readOnly={readOnly}
                  pending={checkAction.pending}
                  onChange={(next) =>
                    void checkAction.run({
                      occurrenceId,
                      checklistItemId: item.id,
                      stepId: null,
                      state: next.state,
                      valueText: next.valueText,
                      valueNumber: next.valueNumber,
                    })
                  }
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Panel>
  );
}

interface ChecklistChange {
  state: "todo" | "done";
  valueText: string | null;
  valueNumber: number | null;
}

function ChecklistRow({
  item,
  state,
  readOnly,
  pending,
  onChange,
}: {
  item: RunnerChecklistItem;
  state: ProgressLike["state"] | undefined;
  readOnly: boolean;
  pending: boolean;
  onChange: (next: ChecklistChange) => void;
}) {
  const [text, setText] = useState("");
  const [number, setNumber] = useState("");
  const done = state === "done";

  return (
    <li className="flex min-h-11 flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <Checkbox
        checked={done}
        disabled={readOnly || pending}
        onCheckedChange={(value) =>
          onChange({
            state: value === true ? "done" : "todo",
            valueText: item.requiresValue === "text" && text !== "" ? text : null,
            valueNumber:
              item.requiresValue === "number" && number !== "" ? Number(number) : null,
          })
        }
        label={item.text}
        hint={
          item.requiresValue === null
            ? undefined
            : item.requiresValue === "photo"
              ? "Needs a photo — attach it below and tick this."
              : `Record a ${item.requiresValue}${item.unit === null ? "" : ` in ${item.unit}`}.`
        }
      />
      {item.requiresValue === "number" && !readOnly ? (
        <Field label={`Value${item.unit === null ? "" : ` (${item.unit})`}`} hideLabel>
          {({ id }) => (
            <Input
              id={id}
              type="number"
              inputSize="sm"
              className="w-28"
              inputMode="decimal"
              value={number}
              aria-label={`${item.text} value${item.unit === null ? "" : ` in ${item.unit}`}`}
              onChange={(event) => setNumber(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      {item.requiresValue === "text" && !readOnly ? (
        <Input
          inputSize="sm"
          className="sm:w-48"
          value={text}
          aria-label={`${item.text} note`}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
    </li>
  );
}
