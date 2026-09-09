import type { StateCreator } from "zustand";
import type {
  FloorId,
  Placement,
  PlacementId,
  PlacementMount,
  RoomId,
  SurfaceId,
  Vec3,
} from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

/** The draft is the authority. Coordinates are ALWAYS physical site metres. */
export interface EditDraft {
  placementId: PlacementId | null;
  equipmentId: string;
  modelId: string;
  name: string;
  physical: Vec3;
  rotationYDeg: number;
  mount: PlacementMount;
  floorId: FloorId;
  roomId: RoomId | null;
  surfaceId: SurfaceId | null;
  locationNote: string;
  photoId: string | null;
  /** Chosen silhouette, or `null` to let the view infer one from category and mount. */
  symbol: string | null;
  dirty: boolean;
}

export interface SnapConfig {
  grid: number;
  rotationStep: number;
  enabled: boolean;
  wallSnap: boolean;
}

export type UndoEntry =
  | { t: "draft"; at: number; before: EditDraft; after: EditDraft }
  | { t: "commit"; at: number; placementId: PlacementId; before: Placement | null; after: Placement }
  | { t: "delete"; at: number; placement: Placement };

export const UNDO_LIMIT = 50;
/** Continuous drag or typing inside this window coalesces into one undo step. */
export const COALESCE_MS = 400;

export interface EditSlice {
  editorSaving: boolean;
  setEditorSaving(saving: boolean): void;
  editing: EditDraft | null;
  original: EditDraft | null;
  /** The exploded gap to put back when the editor closes; `null` outside an editing session. */
  gapBeforeEdit: number | null;
  explodeEnabledBeforeEdit: boolean | null;
  snap: SnapConfig;
  undo: UndoEntry[];
  redo: UndoEntry[];
  editError: string | null;

  beginEdit(draft: EditDraft): void;
  /** Write the draft with no undo bookkeeping. Only undo/redo should use this. */
  setDraft(draft: EditDraft): void;
  updateDraft(patch: Partial<EditDraft>, opts?: { coalesce?: boolean }): void;
  cancelEdit(): void;
  endEdit(): void;
  setSnap(patch: Partial<SnapConfig>): void;
  pushUndo(entry: UndoEntry): void;
  popUndo(): UndoEntry | null;
  popRedo(): UndoEntry | null;
  setEditError(message: string | null): void;
}

export const createEditSlice: StateCreator<HouseStore, Mutators, [], EditSlice> = (set, get) => ({
  editorSaving: false,
  setEditorSaving: (editorSaving) => set({ editorSaving }),
  editing: null,
  original: null,
  gapBeforeEdit: null,
  explodeEnabledBeforeEdit: null,
  snap: { grid: 0.05, rotationStep: 15, enabled: true, wallSnap: true },
  undo: [],
  redo: [],
  editError: null,

  /**
   * Entering edit mode collapses and locks the exploded view. That removes a whole class of "we
   * saved the presentation position" bug rather than relying on a transform being inverted on
   * every save path (defence in depth: the save reads `draft.physical`, never `object.position`).
   */
  beginEdit: (draft) =>
    set((s) => s.editorSaving ? {} : ({
      editing: draft,
      original: draft,
      editError: null,
      // The stacks belong to one editing session. Carrying them across meant Undo could walk back
      // into a *previous* draft and, because a draft entry carries its own `placementId`, save one
      // placement's numbers onto another's row.
      undo: [],
      redo: [],
      // Remember the gap so leaving the editor can put the exploded view back where it was;
      // clearing it to 0 and never restoring left the On/Off button flipping its label and moving
      // nothing until the slider was touched.
      gapBeforeEdit: s.editing ? s.gapBeforeEdit : s.explode.gap,
      explodeEnabledBeforeEdit: s.editing ? s.explodeEnabledBeforeEdit : s.explode.enabled,
      explode: { ...s.explode, enabled: false, gap: 0, locked: true },
    })),

  updateDraft: (patch, opts = {}) =>
    set((s) => {
      if (!s.editing || s.editorSaving) return {};
      const before = s.editing;
      const after: EditDraft = { ...before, ...patch, dirty: true };
      const now = Date.now();
      const last = s.undo[s.undo.length - 1];
      if (
        opts.coalesce &&
        last &&
        last.t === "draft" &&
        now - last.at < COALESCE_MS
      ) {
        const merged: UndoEntry = { t: "draft", at: now, before: last.before, after };
        return { editing: after, undo: [...s.undo.slice(0, -1), merged], redo: [] };
      }
      const entry: UndoEntry = { t: "draft", at: now, before, after };
      return {
        editing: after,
        undo: [...s.undo, entry].slice(-UNDO_LIMIT),
        redo: [],
      };
    }),

  /** Replace the draft without touching the stacks — what undo and redo need. */
  setDraft: (draft) => set((s) => s.editorSaving ? {} : { editing: draft }),

  cancelEdit: () =>
    set((s) => s.editorSaving ? {} : ({
      editing: null,
      original: null,
      editError: null,
      undo: s.undo.filter((e) => e.t !== "draft"),
      explode: { ...s.explode, locked: false, enabled: s.explodeEnabledBeforeEdit ?? s.explode.enabled, gap: s.gapBeforeEdit ?? s.explode.gap },
      gapBeforeEdit: null,
      explodeEnabledBeforeEdit: null,
    })),

  endEdit: () =>
    set((s) => ({
      editing: null,
      original: null,
      editError: null,
      undo: s.undo.filter((e) => e.t !== "draft"),
      explode: { ...s.explode, locked: false, enabled: s.explodeEnabledBeforeEdit ?? s.explode.enabled, gap: s.gapBeforeEdit ?? s.explode.gap },
      gapBeforeEdit: null,
      explodeEnabledBeforeEdit: null,
    })),

  setSnap: (patch) => set((s) => ({ snap: { ...s.snap, ...patch } })),

  pushUndo: (entry) =>
    set((s) => ({ undo: [...s.undo, entry].slice(-UNDO_LIMIT), redo: [] })),

  popUndo: () => {
    const stack = get().undo;
    const entry = stack[stack.length - 1];
    if (!entry) return null;
    set({ undo: stack.slice(0, -1), redo: [...get().redo, entry].slice(-UNDO_LIMIT) });
    return entry;
  },

  popRedo: () => {
    const stack = get().redo;
    const entry = stack[stack.length - 1];
    if (!entry) return null;
    set({ redo: stack.slice(0, -1), undo: [...get().undo, entry].slice(-UNDO_LIMIT) });
    return entry;
  },

  setEditError: (editError) => set({ editError }),
});
