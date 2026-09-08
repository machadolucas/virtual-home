"use client";
/**
 * An explicit, bounded stack of *semantic* entries — not zustand's temporal middleware, which
 * snapshots whole slices on every change and would make "undo" also rewind unrelated view and
 * selection churn.
 */
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";

export function UndoBar() {
  const { undo, redo, editing } = useHouseStore(
    useShallow((s) => ({ undo: s.undo, redo: s.redo, editing: s.editing })),
  );
  const popUndo = useHouseStore((s) => s.popUndo);
  const popRedo = useHouseStore((s) => s.popRedo);
  const updateDraft = useHouseStore((s) => s.updateDraft);

  if (!editing) return null;

  const applyUndo = () => {
    const entry = popUndo();
    if (entry?.t === "draft") updateDraft(entry.before);
  };
  const applyRedo = () => {
    const entry = popRedo();
    if (entry?.t === "draft") updateDraft(entry.after);
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={applyUndo}
        disabled={undo.length === 0}
        className="min-h-8 rounded-md border border-neutral-300 bg-white px-2 font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
      >
        Undo
      </button>
      <button
        type="button"
        onClick={applyRedo}
        disabled={redo.length === 0}
        className="min-h-8 rounded-md border border-neutral-300 bg-white px-2 font-medium text-neutral-800 hover:bg-neutral-100 disabled:opacity-50"
      >
        Redo
      </button>
      <span className="text-neutral-500">{undo.length} step(s)</span>
    </div>
  );
}
