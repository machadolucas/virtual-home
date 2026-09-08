"use client";
/**
 * A pin in the model: a note, a measurement, a warning, a to-do, a photo viewpoint.
 *
 * Annotations are the cheapest durable knowledge in the whole app — "the shutoff is behind this
 * panel" costs one sentence and saves an hour — so this panel is deliberately the least fussy one:
 * a kind, a title, a body, and for a measurement a value and a unit.
 *
 * Two honesty rules are enforced here rather than left to the server's error message:
 *  - a measurement needs a value, because a measurement with nothing measured is a note;
 *  - a pin whose model node the current package no longer knows says so, and keeps its words.
 *
 * The store has no annotation slice yet, so this component owns the list it loaded. It is wired
 * from `Inspector.tsx` by one line (`case "annotation"`), which is recorded as a follow-up in
 * `docs/model-contract.md` because that file is outside this change's scope.
 */
import { useEffect, useState } from "react";
import { ANNOTATION_KINDS } from "@/features/projects/wire";
import type { AnnotationDto } from "@/features/projects/wire";
import { NotPersistedError } from "@/house/store/dataApi";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { Row } from "./RoomInspector";

type Kind = AnnotationDto["kind"];

const KIND_LABEL: Record<Kind, string> = {
  note: "Note",
  measurement: "Measurement",
  warning: "Warning",
  todo: "To-do",
  photo_point: "Photo viewpoint",
};

const KIND_HELP: Record<Kind, string> = {
  note: "Something worth knowing next time somebody opens this up.",
  measurement: "A number somebody actually measured, with its unit.",
  warning: "Do not drill, do not paint, do not switch off — with the reason.",
  todo: "Something to do here. It does not schedule anything on its own.",
  photo_point: "Stand here and photograph that, so the next photo is comparable.",
};

export function AnnotationInspector({ annotationId }: { annotationId: string }) {
  const runtime = useHouseRuntime();
  const { index, modelId, fingerprint } = useHouseStore(
    useShallow((s) => ({ index: s.index, modelId: s.modelId, fingerprint: s.fingerprint })),
  );
  const setDataError = useHouseStore((s) => s.setDataError);

  const [annotation, setAnnotation] = useState<AnnotationDto | null>(null);
  const [draft, setDraft] = useState<{
    kind: Kind;
    title: string;
    body: string;
    measurementValue: string;
    measurementUnit: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    if (!modelId) return;
    let cancelled = false;
    void runtime.dataApi
      .listAnnotations(modelId)
      .then((list) => {
        if (cancelled) return;
        const found = list.find((a) => a.id === annotationId) ?? null;
        setAnnotation(found);
        setDraft(
          found
            ? {
                kind: found.kind,
                title: found.title,
                body: found.body ?? "",
                measurementValue:
                  found.measurementValue === null ? "" : String(found.measurementValue),
                measurementUnit: found.measurementUnit ?? "",
              }
            : null,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof NotPersistedError
            ? `Annotations are not stored yet (${err.reason}).`
            : "The annotation could not be loaded.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, modelId, annotationId]);

  if (deleted)
    return <p className="text-xs text-neutral-500">This pin has been deleted.</p>;
  if (error) return <p className="text-xs text-red-700">{error}</p>;
  if (!annotation || !draft || !index)
    return <p className="text-xs text-neutral-500">Loading the pin…</p>;

  const nodeName =
    annotation.modelNodeId === null
      ? null
      : (index.rooms.get(annotation.modelNodeId)?.name ??
        index.floors.get(annotation.modelNodeId)?.name ??
        annotation.modelNodeId);

  const save = async (): Promise<void> => {
    if (!modelId || !fingerprint) return;
    const value = draft.measurementValue.trim();
    const parsed = value === "" ? null : Number(value);
    if (draft.kind === "measurement" && (parsed === null || !Number.isFinite(parsed))) {
      setError("A measurement needs a number. Use “Note” if there is nothing to measure.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await runtime.dataApi.saveAnnotation(modelId, fingerprint, {
        id: annotation.id,
        targetKind: annotation.targetKind,
        targetId: annotation.targetId,
        modelNodeId: annotation.modelNodeId,
        position: annotation.position,
        kind: draft.kind,
        title: draft.title.trim() === "" ? annotation.title : draft.title.trim(),
        body: draft.body.trim() === "" ? null : draft.body.trim(),
        measurementValue: parsed !== null && Number.isFinite(parsed) ? parsed : null,
        measurementUnit: draft.measurementUnit.trim() === "" ? null : draft.measurementUnit.trim(),
      });
      setAnnotation(saved);
    } catch (err) {
      if (err instanceof NotPersistedError)
        setDataError(`Annotations are not stored yet (${err.reason}) — this change is local.`);
      else setError(err instanceof Error ? err.message : "The change was not saved.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!modelId) return;
    setBusy(true);
    try {
      await runtime.dataApi.deleteAnnotation(modelId, annotation.id);
      setDeleted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The pin was not deleted.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-base font-semibold text-neutral-900">{annotation.title}</h2>
        <p className="text-xs text-neutral-500">
          {KIND_LABEL[annotation.kind]}
          {nodeName ? ` · ${nodeName}` : ""}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Attached to" value={annotation.targetKind} />
        {annotation.position ? (
          <Row
            label="Position"
            value={annotation.position.map((v) => v.toFixed(2)).join(", ")}
          />
        ) : null}
        {annotation.measurementValue !== null ? (
          <Row
            label="Measured"
            value={`${annotation.measurementValue}${
              annotation.measurementUnit ? ` ${annotation.measurementUnit}` : ""
            }`}
          />
        ) : null}
        <Row label="Photos" value={String(annotation.photoIds.length)} />
      </dl>

      {annotation.needsReconciliation ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
          The model node this pin was placed on is not in the current package. The words are intact;
          where it points needs a human decision.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-neutral-600">Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
            className="min-h-8 rounded-md border border-neutral-300 px-1 text-xs"
          >
            {ANNOTATION_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-neutral-500">{KIND_HELP[draft.kind]}</span>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-neutral-600">Title</span>
          <input
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={200}
            className="min-h-8 rounded-md border border-neutral-300 px-2 text-xs"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-neutral-600">Body</span>
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={4}
            maxLength={4000}
            className="rounded-md border border-neutral-300 p-2 text-xs"
          />
        </label>

        {draft.kind === "measurement" ? (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-neutral-600">Value</span>
              <input
                value={draft.measurementValue}
                onChange={(e) => setDraft({ ...draft, measurementValue: e.target.value })}
                inputMode="decimal"
                className="min-h-8 rounded-md border border-neutral-300 px-2 text-xs"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-neutral-600">Unit</span>
              <input
                value={draft.measurementUnit}
                onChange={(e) => setDraft({ ...draft, measurementUnit: e.target.value })}
                maxLength={20}
                placeholder="m, mm, °C"
                className="min-h-8 rounded-md border border-neutral-300 px-2 text-xs"
              />
            </label>
          </div>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void remove()}
            className="min-h-9 rounded-md border border-red-300 bg-white px-3 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
          >
            Delete pin
          </button>
        </div>
      </div>
    </div>
  );
}
