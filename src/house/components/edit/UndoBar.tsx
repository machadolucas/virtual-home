"use client";
/**
 * An explicit, bounded stack of *semantic* entries — not zustand's temporal middleware, which
 * snapshots whole slices on every change and would make "undo" also rewind unrelated view and
 * selection churn.
 */
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { Redo2, Undo2 } from "lucide-react";

export function UndoBar() {
  const { undo, redo, editing } = useHouseStore(
    useShallow((s) => ({ undo: s.undo, redo: s.redo, editing: s.editing })),
  );
  const popUndo = useHouseStore((s) => s.popUndo);
  const popRedo = useHouseStore((s) => s.popRedo);
  const setDraft = useHouseStore((s) => s.setDraft);

  if (!editing) return null;

  /**
   * Undo writes the draft **without** the undo bookkeeping.
   *
   * It used to go through `updateDraft`, which pushes a new undo entry and clears the redo stack —
   * so the stack grew as you undid, Undo never reached further than one step, and Redo could never
   * become enabled. A step also carries its own `placementId`, so applying one from a previous
   * editing session would have written those numbers onto whatever row is open now; the entry is
   * therefore refused unless it belongs to this draft.
   */
  const belongsHere = (entry: { before: { placementId: string | null } }) =>
    entry.before.placementId === editing.placementId;

  const applyUndo = () => {
    const entry = popUndo();
    if (entry?.t === "draft" && belongsHere(entry)) setDraft(entry.before);
  };
  const applyRedo = () => {
    const entry = popRedo();
    if (entry?.t === "draft" && belongsHere({ before: entry.after })) setDraft(entry.after);
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={applyUndo}
        disabled={undo.length === 0}
        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-line bg-surface px-2 font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
      >
        <Undo2 aria-hidden="true" className="size-3.5" />
        Undo
      </button>
      <button
        type="button"
        onClick={applyRedo}
        disabled={redo.length === 0}
        className="inline-flex min-h-8 items-center gap-1 rounded-md border border-line bg-surface px-2 font-medium text-ink hover:bg-surface-3 disabled:opacity-50"
      >
        <Redo2 aria-hidden="true" className="size-3.5" />
        Redo
      </button>
      <span className="text-ink-3">{undo.length} step(s)</span>
    </div>
  );
}
