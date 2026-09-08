"use client";
/**
 * The procedure draft editor.
 *
 * Only the **draft** is editable. A published version is frozen: occurrences point at it, and
 * somebody halfway through a job must keep the steps they started with. Editing a published
 * procedure therefore forks a new draft rather than changing anything in place, and publishing
 * supersedes the old version without deleting it.
 *
 * The whole draft is submitted at once and its child rows are replaced. That is deliberately dumb:
 * a diffing editor would need stable ids for rows the user is still reordering, and getting that
 * wrong silently loses a step.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, Plus, Save, Send, Trash2 } from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  IconButton,
  Input,
  Panel,
  Select,
  Textarea,
} from "@/ui";
import type { PartUnit } from "@/db/schema/inventory";
import {
  discardProcedureDraft,
  publishProcedureDraft,
  saveProcedureDraft,
  startProcedureDraft,
} from "@/server/actions/maintenance/procedures";
import { messageFor, newRequestKey, useAction } from "./useAction";
import { parseQty } from "./materials";

export interface EditorChecklistItem {
  text: string;
  requiresValue: "number" | "text" | "photo" | null;
  unit: string | null;
}

export interface EditorStep {
  title: string;
  bodyMd: string;
  expectedMinutes: string;
  isOptional: boolean;
  warning: string;
  checklist: EditorChecklistItem[];
}

export interface EditorTool {
  name: string;
  isRequired: boolean;
  notes: string;
}

export interface EditorMaterial {
  partId: string;
  qtyMilli: number;
  isRequired: boolean;
}

export interface EditorReference {
  kind: "manual" | "page" | "url" | "video" | "datasheet";
  label: string;
  url: string;
  manualName: string;
  pageFrom: string;
  pageTo: string;
}

export interface EditorEquipmentNote {
  assetId: string;
  assetModelName: string;
  note: string;
}

export interface ProcedureEditorValues {
  title: string;
  summary: string;
  defaultEffortMinutes: string;
  prerequisites: string;
  safetyNotes: string;
  steps: EditorStep[];
  looseChecklist: EditorChecklistItem[];
  tools: EditorTool[];
  materials: EditorMaterial[];
  references: EditorReference[];
  equipmentNotes: EditorEquipmentNote[];
}

export interface ProcedureEditorProps {
  procedureId: string;
  /** `false` for a published version: the editor renders a "start a draft" prompt instead. */
  editable: boolean;
  initial: ProcedureEditorValues;
  parts: readonly { value: string; label: string; hint?: string; unit: PartUnit }[];
  /** A draft that has never been published cannot be discarded (it is the whole procedure). */
  isFirstDraft: boolean;
  hasDraft: boolean;
}

const EMPTY_STEP: EditorStep = {
  title: "",
  bodyMd: "",
  expectedMinutes: "",
  isOptional: false,
  warning: "",
  checklist: [],
};

export function ProcedureEditor({
  procedureId,
  editable,
  initial,
  parts,
  isFirstDraft,
  hasDraft,
}: ProcedureEditorProps) {
  const router = useRouter();
  const [key] = useState(newRequestKey);
  const [values, setValues] = useState<ProcedureEditorValues>(initial);
  const [publishOpen, setPublishOpen] = useState(false);
  const [changeNote, setChangeNote] = useState("");

  const save = useAction(saveProcedureDraft, { success: "Draft saved." });
  const publish = useAction(publishProcedureDraft, { success: "Published." });
  const start = useAction(startProcedureDraft, { success: "Draft started." });
  const discard = useAction(discardProcedureDraft, { success: "Draft discarded." });

  if (!editable) {
    return (
      <Panel
        title="This version is published"
        subtitle="Published versions are read-only, because tasks are generated against them. Editing starts a new draft; the published version stays exactly as it is."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            loading={start.pending}
            onClick={() =>
              void start
                .run({ procedureId, idempotencyKey: `${key}-start` })
                .then((result) => {
                  // Drop any `?version=` from the URL: the draft is what should now be on screen.
                  if (result !== null) router.push(`/procedures/${procedureId}`);
                })
            }
          >
            {hasDraft ? "Open the draft" : "Start a new draft"}
          </Button>
          {start.failure !== null ? (
            <span className="text-sm text-overdue">{messageFor(start.failure)}</span>
          ) : null}
        </div>
      </Panel>
    );
  }

  function patch(next: Partial<ProcedureEditorValues>): void {
    setValues((current) => ({ ...current, ...next }));
  }

  function payload() {
    return {
      title: values.title.trim(),
      summary: values.summary.trim() === "" ? null : values.summary.trim(),
      defaultEffortMinutes:
        values.defaultEffortMinutes.trim() === "" ? null : Number(values.defaultEffortMinutes),
      prerequisites: values.prerequisites.trim() === "" ? null : values.prerequisites.trim(),
      safetyNotes: values.safetyNotes.trim() === "" ? null : values.safetyNotes.trim(),
      steps: values.steps
        .filter((step) => step.title.trim() !== "")
        .map((step) => ({
          title: step.title.trim(),
          bodyMd: step.bodyMd.trim() === "" ? null : step.bodyMd,
          expectedMinutes:
            step.expectedMinutes.trim() === "" ? null : Number(step.expectedMinutes),
          isOptional: step.isOptional,
          warning: step.warning.trim() === "" ? null : step.warning.trim(),
          checklist: step.checklist
            .filter((item) => item.text.trim() !== "")
            .map((item) => ({
              text: item.text.trim(),
              requiresValue: item.requiresValue,
              unit: item.unit === null || item.unit.trim() === "" ? null : item.unit.trim(),
            })),
        })),
      looseChecklist: values.looseChecklist
        .filter((item) => item.text.trim() !== "")
        .map((item) => ({
          text: item.text.trim(),
          requiresValue: item.requiresValue,
          unit: item.unit === null || item.unit.trim() === "" ? null : item.unit.trim(),
        })),
      tools: values.tools
        .filter((tool) => tool.name.trim() !== "")
        .map((tool) => ({
          name: tool.name.trim(),
          isRequired: tool.isRequired,
          notes: tool.notes.trim() === "" ? null : tool.notes.trim(),
        })),
      materials: values.materials,
      references: values.references
        .filter((reference) => reference.label.trim() !== "")
        .map((reference) => ({
          kind: reference.kind,
          label: reference.label.trim(),
          url: reference.url.trim() === "" ? null : reference.url.trim(),
          manualName: reference.manualName.trim() === "" ? null : reference.manualName.trim(),
          pageFrom: reference.pageFrom.trim() === "" ? null : Number(reference.pageFrom),
          pageTo: reference.pageTo.trim() === "" ? null : Number(reference.pageTo),
        })),
      equipmentNotes: values.equipmentNotes
        .filter((note) => note.note.trim() !== "")
        .map((note) => ({
          assetId: note.assetId.trim() === "" ? null : note.assetId.trim(),
          assetModelName: note.assetModelName.trim() === "" ? null : note.assetModelName.trim(),
          note: note.note.trim(),
        })),
    };
  }

  const stepCount = values.steps.filter((step) => step.title.trim() !== "").length;
  const failure = save.failure ?? publish.failure ?? discard.failure;

  return (
    <div className="flex flex-col gap-5">
      <Panel title="The procedure">
        <div className="flex flex-col gap-4">
          <Field label="Title" required>
            {({ id }) => (
              <Input
                id={id}
                value={values.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            )}
          </Field>
          <Field label="Summary" help="One line, shown when picking a procedure for a plan.">
            {({ id }) => (
              <Input
                id={id}
                value={values.summary}
                onChange={(event) => patch({ summary: event.target.value })}
              />
            )}
          </Field>
          <Field label="Usual effort" help="Minutes. Pre-fills a plan's estimate.">
            {({ id }) => (
              <Input
                id={id}
                type="number"
                min={1}
                step={5}
                inputMode="numeric"
                value={values.defaultEffortMinutes}
                onChange={(event) => patch({ defaultEffortMinutes: event.target.value })}
              />
            )}
          </Field>
          <Field label="Before you start" help="What has to be true before the first step.">
            {({ id }) => (
              <Textarea
                id={id}
                rows={2}
                value={values.prerequisites}
                placeholder="Turn the unit off at the isolator switch and wait for the fan to stop."
                onChange={(event) => patch({ prerequisites: event.target.value })}
              />
            )}
          </Field>
          <Field
            label="Safety notes"
            help="Shown in a warning block at the top of every task using this procedure."
          >
            {({ id }) => (
              <Textarea
                id={id}
                rows={2}
                value={values.safetyNotes}
                onChange={(event) => patch({ safetyNotes: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="Steps"
        subtitle="Worked through one at a time on the task page, with progress saved per step."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() => patch({ steps: [...values.steps, { ...EMPTY_STEP }] })}
          >
            Add a step
          </Button>
        }
      >
        {values.steps.length === 0 ? (
          <p className="text-sm text-ink-3">
            No steps yet. A procedure needs at least one before it can be published — otherwise a
            task would show empty instructions.
          </p>
        ) : (
          <ol className="flex flex-col gap-4">
            {values.steps.map((step, index) => (
              <li key={index} className="rounded-md border border-line bg-surface-2 px-3 py-3">
                <div className="flex items-start gap-2">
                  <span className="vh-tnum mt-2 text-xs text-ink-3">{index + 1}</span>
                  <div className="min-w-0 flex-1 flex flex-col gap-3">
                    <Field label={`Step ${index + 1} title`} required hideLabel>
                      {({ id }) => (
                        <Input
                          id={id}
                          value={step.title}
                          aria-label={`Step ${index + 1} title`}
                          placeholder="Open the access panel"
                          onChange={(event) =>
                            patch({
                              steps: values.steps.map((entry, i) =>
                                i === index ? { ...entry, title: event.target.value } : entry,
                              ),
                            })
                          }
                        />
                      )}
                    </Field>
                    <Textarea
                      rows={3}
                      value={step.bodyMd}
                      aria-label={`Step ${index + 1} instructions`}
                      placeholder="Two clips at the top; the panel hinges downwards. Markdown is fine."
                      onChange={(event) =>
                        patch({
                          steps: values.steps.map((entry, i) =>
                            i === index ? { ...entry, bodyMd: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Expected minutes">
                        {({ id }) => (
                          <Input
                            id={id}
                            type="number"
                            min={1}
                            step={1}
                            inputMode="numeric"
                            value={step.expectedMinutes}
                            onChange={(event) =>
                              patch({
                                steps: values.steps.map((entry, i) =>
                                  i === index
                                    ? { ...entry, expectedMinutes: event.target.value }
                                    : entry,
                                ),
                              })
                            }
                          />
                        )}
                      </Field>
                      <Field label="Warning" help="Shown in a coloured block on this step only.">
                        {({ id }) => (
                          <Input
                            id={id}
                            value={step.warning}
                            onChange={(event) =>
                              patch({
                                steps: values.steps.map((entry, i) =>
                                  i === index ? { ...entry, warning: event.target.value } : entry,
                                ),
                              })
                            }
                          />
                        )}
                      </Field>
                    </div>
                    <Checkbox
                      checked={step.isOptional}
                      onCheckedChange={(value) =>
                        patch({
                          steps: values.steps.map((entry, i) =>
                            i === index ? { ...entry, isOptional: value === true } : entry,
                          ),
                        })
                      }
                      label="Optional step"
                    />

                    <ChecklistEditor
                      items={step.checklist}
                      label={`Checks for step ${index + 1}`}
                      onChange={(next) =>
                        patch({
                          steps: values.steps.map((entry, i) =>
                            i === index ? { ...entry, checklist: next } : entry,
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <IconButton
                      label={`Move step ${index + 1} up`}
                      size="sm"
                      icon={<ChevronUp aria-hidden="true" />}
                      disabled={index === 0}
                      onClick={() => patch({ steps: swap(values.steps, index, index - 1) })}
                    />
                    <IconButton
                      label={`Move step ${index + 1} down`}
                      size="sm"
                      icon={<ChevronDown aria-hidden="true" />}
                      disabled={index === values.steps.length - 1}
                      onClick={() => patch({ steps: swap(values.steps, index, index + 1) })}
                    />
                    <IconButton
                      label={`Remove step ${index + 1}`}
                      size="sm"
                      variant="danger"
                      icon={<Trash2 aria-hidden="true" />}
                      onClick={() =>
                        patch({ steps: values.steps.filter((_, i) => i !== index) })
                      }
                    />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Final checks" subtitle="Checks that belong to the whole job, not to one step.">
        <ChecklistEditor
          items={values.looseChecklist}
          label="Final checks"
          onChange={(next) => patch({ looseChecklist: next })}
        />
      </Panel>

      <Panel
        title="Tools"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() =>
              patch({ tools: [...values.tools, { name: "", isRequired: true, notes: "" }] })
            }
          >
            Add a tool
          </Button>
        }
      >
        {values.tools.length === 0 ? (
          <p className="text-sm text-ink-3">No tools listed.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {values.tools.map((tool, index) => (
              <li key={index} className="flex flex-wrap items-end gap-2">
                <Input
                  className="min-w-40 flex-1"
                  value={tool.name}
                  aria-label={`Tool ${index + 1} name`}
                  placeholder="Torx T20 screwdriver"
                  onChange={(event) =>
                    patch({
                      tools: values.tools.map((entry, i) =>
                        i === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                />
                <Checkbox
                  checked={tool.isRequired}
                  onCheckedChange={(value) =>
                    patch({
                      tools: values.tools.map((entry, i) =>
                        i === index ? { ...entry, isRequired: value === true } : entry,
                      ),
                    })
                  }
                  label="Required"
                />
                <IconButton
                  label={`Remove tool ${index + 1}`}
                  size="sm"
                  variant="danger"
                  icon={<Trash2 aria-hidden="true" />}
                  onClick={() => patch({ tools: values.tools.filter((_, i) => i !== index) })}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Materials"
        subtitle="Added to whatever the plan requires; the plan wins if both name the same part."
      >
        <MaterialRows
          parts={parts}
          materials={values.materials}
          onChange={(next) => patch({ materials: next })}
        />
      </Panel>

      <Panel
        title="References"
        subtitle="The manual and its page numbers, or a link. Manual files are attached from the equipment page."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() =>
              patch({
                references: [
                  ...values.references,
                  { kind: "manual", label: "", url: "", manualName: "", pageFrom: "", pageTo: "" },
                ],
              })
            }
          >
            Add a reference
          </Button>
        }
      >
        {values.references.length === 0 ? (
          <p className="text-sm text-ink-3">No references.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {values.references.map((reference, index) => (
              <li key={index} className="grid gap-2 rounded-md border border-line bg-surface-2 p-3 sm:grid-cols-6">
                <Field label="Kind" className="sm:col-span-1">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={reference.kind}
                      onValueChange={(value) =>
                        patch({
                          references: values.references.map((entry, i) =>
                            i === index
                              ? { ...entry, kind: value as EditorReference["kind"] }
                              : entry,
                          ),
                        })
                      }
                      options={[
                        { value: "manual", label: "Manual" },
                        { value: "page", label: "Page" },
                        { value: "url", label: "Link" },
                        { value: "video", label: "Video" },
                        { value: "datasheet", label: "Datasheet" },
                      ]}
                    />
                  )}
                </Field>
                <Field label="Label" required className="sm:col-span-2">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={reference.label}
                      onChange={(event) =>
                        patch({
                          references: values.references.map((entry, i) =>
                            i === index ? { ...entry, label: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Manual name" className="sm:col-span-1">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={reference.manualName}
                      onChange={(event) =>
                        patch({
                          references: values.references.map((entry, i) =>
                            i === index ? { ...entry, manualName: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Pages" className="sm:col-span-1">
                  {({ id }) => (
                    <span className="flex items-center gap-1">
                      <Input
                        id={id}
                        type="number"
                        min={1}
                        className="w-16"
                        aria-label="First page"
                        value={reference.pageFrom}
                        onChange={(event) =>
                          patch({
                            references: values.references.map((entry, i) =>
                              i === index ? { ...entry, pageFrom: event.target.value } : entry,
                            ),
                          })
                        }
                      />
                      <span className="text-ink-3">–</span>
                      <Input
                        type="number"
                        min={1}
                        className="w-16"
                        aria-label="Last page"
                        value={reference.pageTo}
                        onChange={(event) =>
                          patch({
                            references: values.references.map((entry, i) =>
                              i === index ? { ...entry, pageTo: event.target.value } : entry,
                            ),
                          })
                        }
                      />
                    </span>
                  )}
                </Field>
                <div className="flex items-end justify-end sm:col-span-1">
                  <IconButton
                    label={`Remove reference ${index + 1}`}
                    size="sm"
                    variant="danger"
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() =>
                      patch({ references: values.references.filter((_, i) => i !== index) })
                    }
                  />
                </div>
                {reference.kind === "url" || reference.kind === "video" ? (
                  <Field label="Link" className="sm:col-span-6">
                    {({ id }) => (
                      <Input
                        id={id}
                        type="url"
                        value={reference.url}
                        onChange={(event) =>
                          patch({
                            references: values.references.map((entry, i) =>
                              i === index ? { ...entry, url: event.target.value } : entry,
                            ),
                          })
                        }
                      />
                    )}
                  </Field>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Notes about specific equipment"
        subtitle="“On the 2019 model the filter clip is reversed.” Shown on tasks for that unit or model."
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Plus aria-hidden="true" />}
            onClick={() =>
              patch({
                equipmentNotes: [
                  ...values.equipmentNotes,
                  { assetId: "", assetModelName: "", note: "" },
                ],
              })
            }
          >
            Add a note
          </Button>
        }
      >
        {values.equipmentNotes.length === 0 ? (
          <p className="text-sm text-ink-3">No equipment-specific notes.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {values.equipmentNotes.map((note, index) => (
              <li key={index} className="grid gap-2 rounded-md border border-line bg-surface-2 p-3 sm:grid-cols-3">
                <Field label="Model name" help="Or leave empty and name a specific unit instead.">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={note.assetModelName}
                      onChange={(event) =>
                        patch({
                          equipmentNotes: values.equipmentNotes.map((entry, i) =>
                            i === index ? { ...entry, assetModelName: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field label="Note" required className="sm:col-span-2">
                  {({ id }) => (
                    <Input
                      id={id}
                      value={note.note}
                      onChange={(event) =>
                        patch({
                          equipmentNotes: values.equipmentNotes.map((entry, i) =>
                            i === index ? { ...entry, note: event.target.value } : entry,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <div className="flex justify-end sm:col-span-3">
                  <IconButton
                    label={`Remove note ${index + 1}`}
                    size="sm"
                    variant="danger"
                    icon={<Trash2 aria-hidden="true" />}
                    onClick={() =>
                      patch({
                        equipmentNotes: values.equipmentNotes.filter((_, i) => i !== index),
                      })
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {failure !== null ? (
        <p className="rounded-md border border-overdue/45 bg-overdue-soft px-3 py-2 text-sm text-overdue">
          {messageFor(failure)}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-line bg-paper/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <Button
          variant="secondary"
          size="lg"
          loading={save.pending}
          disabled={values.title.trim() === ""}
          icon={<Save aria-hidden="true" />}
          onClick={() =>
            void save.run({ procedureId, content: payload(), idempotencyKey: `${key}-save` })
          }
        >
          Save draft
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={stepCount === 0 || values.title.trim() === ""}
          icon={<Send aria-hidden="true" />}
          onClick={() => setPublishOpen(true)}
        >
          Publish
        </Button>
        <Badge tone="neutral" icon={null} size="sm">
          {stepCount} {stepCount === 1 ? "step" : "steps"}
        </Badge>
        {isFirstDraft ? null : (
          <Button
            variant="ghost"
            size="lg"
            className="ms-auto"
            loading={discard.pending}
            onClick={() =>
              void discard.run({ procedureId, idempotencyKey: `${key}-discard` })
            }
          >
            Discard draft
          </Button>
        )}
      </div>

      <Dialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        size="sm"
        title="Publish this version"
        description="Freezes it and puts it in force for new tasks. Tasks already generated keep the version they were created with, so nothing changes under anyone. Editing afterwards starts a fresh draft."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>
              Not yet
            </Button>
            <Button
              variant="primary"
              loading={publish.pending || save.pending}
              onClick={() =>
                void save
                  .run({ procedureId, content: payload(), idempotencyKey: `${key}-presave` })
                  .then((saved) => {
                    if (saved === null) return;
                    return publish
                      .run({
                        procedureId,
                        changeNote: changeNote.trim() === "" ? null : changeNote.trim(),
                        idempotencyKey: `${key}-publish`,
                      })
                      .then((result) => {
                        if (result !== null) setPublishOpen(false);
                      });
                  })
              }
            >
              Publish
            </Button>
          </>
        }
      >
        <Field
          label="What changed"
          help="Kept with the version, so the history explains itself later."
        >
          {({ id }) => (
            <Input
              id={id}
              value={changeNote}
              placeholder="Added the pre-filter step after the 2026 service"
              onChange={(event) => setChangeNote(event.target.value)}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

function swap<T>(list: readonly T[], a: number, b: number): T[] {
  const copy = [...list];
  const first = copy[a];
  const second = copy[b];
  if (first === undefined || second === undefined) return copy;
  copy[a] = second;
  copy[b] = first;
  return copy;
}

function ChecklistEditor({
  items,
  label,
  onChange,
}: {
  items: readonly EditorChecklistItem[];
  label: string;
  onChange: (next: EditorChecklistItem[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.06em] text-ink-3">{label}</p>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus aria-hidden="true" />}
          onClick={() => onChange([...items, { text: "", requiresValue: null, unit: null }])}
        >
          Add a check
        </Button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-ink-3">No checks.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item, index) => (
            <li key={index} className="flex flex-wrap items-end gap-2">
              <Input
                className="min-w-40 flex-1"
                inputSize="sm"
                value={item.text}
                aria-label={`${label} item ${index + 1}`}
                placeholder="Filter seated correctly"
                onChange={(event) =>
                  onChange(
                    items.map((entry, i) =>
                      i === index ? { ...entry, text: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Select
                selectSize="sm"
                ariaLabel={`Value required for ${label} item ${index + 1}`}
                value={item.requiresValue ?? "none"}
                onValueChange={(value) =>
                  onChange(
                    items.map((entry, i) =>
                      i === index
                        ? {
                            ...entry,
                            requiresValue:
                              value === "none" ? null : (value as EditorChecklistItem["requiresValue"]),
                          }
                        : entry,
                    ),
                  )
                }
                options={[
                  { value: "none", label: "Just a tick" },
                  { value: "number", label: "A number" },
                  { value: "text", label: "A short note" },
                  { value: "photo", label: "A photo" },
                ]}
              />
              {item.requiresValue === "number" ? (
                <Input
                  inputSize="sm"
                  className="w-20"
                  value={item.unit ?? ""}
                  aria-label={`Unit for ${label} item ${index + 1}`}
                  placeholder="Pa"
                  onChange={(event) =>
                    onChange(
                      items.map((entry, i) =>
                        i === index ? { ...entry, unit: event.target.value } : entry,
                      ),
                    )
                  }
                />
              ) : null}
              <IconButton
                label={`Remove ${label} item ${index + 1}`}
                size="sm"
                variant="danger"
                icon={<Trash2 aria-hidden="true" />}
                onClick={() => onChange(items.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialRows({
  parts,
  materials,
  onChange,
}: {
  parts: readonly { value: string; label: string; hint?: string; unit: PartUnit }[];
  materials: readonly EditorMaterial[];
  onChange: (next: EditorMaterial[]) => void;
}) {
  const [partId, setPartId] = useState(parts[0]?.value ?? "");
  const [qty, setQty] = useState("1");

  if (parts.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        No parts are defined yet. Add them under Supplies first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {materials.length === 0 ? (
        <p className="text-sm text-ink-3">No materials listed.</p>
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
                  {line.qtyMilli / 1000}{" "}
                  {parts.find((part) => part.value === line.partId)?.unit ?? ""}
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
                  label={`Remove material ${index + 1}`}
                  size="sm"
                  variant="danger"
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
        <Field label="Quantity" className="w-28">
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
          disabled={parseQty(qty) === null || parseQty(qty) === 0}
          onClick={() => {
            const parsed = parseQty(qty);
            if (parsed === null || parsed === 0) return;
            const exists = materials.some((line) => line.partId === partId);
            onChange(
              exists
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
    </div>
  );
}
