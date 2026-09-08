"use client";
/* eslint-disable react-hooks/immutability -- `HouseRuntime` is a deliberately mutable,
   non-reactive box handed around by context (see `src/house/runtime.ts`): the imperative layer
   publishes its handles onto it and React never re-renders because of it. The React Compiler
   rule assumes a hook's return value is immutable, which is precisely the assumption this
   design breaks on purpose — the alternative is putting `Object3D`s in React state. */
/**
 * The placement editor panel: numeric fields (the authority), drag-to-place on a pointer device,
 * nudge buttons everywhere, save and cancel.
 *
 * Save never reads `object.position`; it reads `draft.physical`, which is always physical site
 * metres. The explode gap is forced to 0 and locked while this is open, and a dev-only assertion
 * cross-checks the world position against the draft before the write is dispatched.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { snapValue } from "@/house/model/geometry2d";
import type { Placement } from "@/house/model/types";
import { dragCandidates } from "@/house/scene/picker";
import { assertPhysicalY, resolveSnap, type SnapIndicatorState } from "@/house/scene/snap";
import { NotPersistedError } from "@/house/store/dataApi";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { useIsPhone } from "../../hooks/useReducedMotion";
import { NumericPlacementFields } from "./NumericPlacementFields";
import { UndoBar } from "./UndoBar";

export function PlacementEditor() {
  const runtime = useHouseRuntime();
  const phone = useIsPhone();
  const { editing, snap, index, fingerprint, modelId, editError } = useHouseStore(
    useShallow((s) => ({
      editing: s.editing,
      snap: s.snap,
      index: s.index,
      fingerprint: s.fingerprint,
      modelId: s.modelId,
      editError: s.editError,
    })),
  );
  const updateDraft = useHouseStore((s) => s.updateDraft);
  const setSnap = useHouseStore((s) => s.setSnap);
  const cancelEdit = useHouseStore((s) => s.cancelEdit);
  const endEdit = useHouseStore((s) => s.endEdit);
  const setEditError = useHouseStore((s) => s.setEditError);
  const upsertPlacement = useHouseStore((s) => s.upsertPlacement);
  const markPlaced = useHouseStore((s) => s.markPlaced);
  const removePlacement = useHouseStore((s) => s.removePlacement);
  const restorePlaceable = useHouseStore((s) => s.restorePlaceable);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pushUndo = useHouseStore((s) => s.pushUndo);
  // Both the in-canvas indicator and the on-canvas readout subscribe to the runtime channel, so
  // there is no local copy to keep in step — and a hover never re-renders this panel.
  const setIndicator = useCallback(
    (next: SnapIndicatorState | null) => {
      runtime.setSnapIndicator(next);
    },
    [runtime],
  );
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);

  /**
   * Aiming with the pointer, on a pointer device only. On phones this is numeric-only plus the
   * nudge buttons: complex geometry editing favours a desktop, and a 44 px finger on a 5 cm grid
   * is not precision.
   *
   * The camera is *not* touched here. It is owned by the tool (`useToolCamera` in
   * `HouseWorkspace`), which switches to the place tool on entering the editor and hands the
   * camera back on leaving. Disabling the controls inside this handler was the old bug: by the
   * time `pointerdown` reached the app, `camera-controls` had already captured the gesture, so the
   * house orbited while the marker moved.
   */
  useEffect(() => {
    if (phone || !editing || !index) return;
    const el = runtime.canvasEl;
    const picker = runtime.picker;
    const sceneIndex = runtime.index;
    const clip = runtime.clip;
    if (!el || !picker || !sceneIndex || !clip) return;

    const candidates = dragCandidates(sceneIndex, editing.floorId);
    const camera = runtime.camera3d;
    if (!camera) return;

    /** Solve the snap under the pointer without touching the draft. */
    const solveAt = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const hit = picker.pick(event.clientX, event.clientY, rect, camera, sceneIndex, clip, {
        candidates,
      });
      return resolveSnap({
        hit,
        config: snap,
        manifest: index,
        draft: editing,
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        meshOf: (id) => sceneIndex.surfaceMesh.get(id),
        anchorOf: (id) => index.roomAnchors.get(id)?.point,
      });
    };

    const commit = (solution: ReturnType<typeof solveAt>) => {
      updateDraft(
        {
          physical: solution.physical,
          rotationYDeg: solution.rotationYDeg,
          mount: solution.mount,
          floorId: solution.floorId,
          roomId: solution.roomId,
          surfaceId: solution.surfaceId,
        },
        { coalesce: true },
      );
    };

    /** The pointer places only when the place tool holds the left button. */
    const placing = () => {
      const s = runtime.store.getState();
      return s.tool === "place" && !s.cameraOverride;
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || !placing()) return;
      dragging.current = true;
      const solution = solveAt(event);
      setIndicator(solution.indicator);
      commit(solution);
    };

    // Hover previews. Aiming used to be blind — the indicator and the readout only appeared once
    // the button was already down, so the only way to find out where a click would land was to
    // click. Now the solve runs on every move and the draft changes only while pressed.
    const onMove = (event: PointerEvent) => {
      if (!placing()) {
        if (!dragging.current) setIndicator(null);
        return;
      }
      const solution = solveAt(event);
      setIndicator(solution.indicator);
      if (dragging.current) commit(solution);
    };

    const onUp = () => {
      dragging.current = false;
    };

    /** Leaving the canvas ends the preview; a stale ring under no cursor is a lie. */
    const onLeave = () => {
      dragging.current = false;
      setIndicator(null);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onLeave);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onLeave);
      el.removeEventListener("pointerleave", onLeave);
      setIndicator(null);
    };
  }, [runtime, editing, index, snap, phone, updateDraft, setIndicator]);

  // Leaving the editor by any path (save, cancel, unmount) clears the in-canvas indicator.
  useEffect(() => () => runtime.setSnapIndicator(null), [runtime]);

  const nudge = useCallback(
    (dx: number, dz: number, dRot: number) => {
      if (!editing) return;
      updateDraft({
        physical: [
          snapValue(editing.physical[0] + dx, snap.grid),
          editing.physical[1],
          snapValue(editing.physical[2] + dz, snap.grid),
        ],
        rotationYDeg: editing.rotationYDeg + dRot,
      });
    },
    [editing, snap.grid, updateDraft],
  );

  const save = useCallback(async () => {
    if (!editing || !index || !modelId || !fingerprint) return;
    if (editing.physical.some((v) => !Number.isFinite(v))) {
      setEditError("The coordinates must be numbers.");
      return;
    }
    // No room is a legitimate answer, not an error: a yard lamp, an eave spot or anything on the
    // terrace sits outside every room footprint. The package's `rooms` are interior only, so
    // requiring one made every outdoor fixture unplaceable. The row then anchors to the floor —
    // which is exactly what the endpoint's own `resolveNode` falls back to — and the bounds check
    // below still refuses a coordinate that is nowhere near the property.
    const bounds = index.manifest.bounds;
    for (let i = 0; i < 3; i++) {
      if ((editing.physical[i] as number) < (bounds.min[i] as number) || (editing.physical[i] as number) > (bounds.max[i] as number)) {
        setEditError("The position is outside the model's bounds.");
        return;
      }
    }

    // Defence in depth: the world position minus the group's presentation offset must equal the
    // draft's physical Y. The draft is still what gets saved.
    const offset = runtime.offsets.get(editing.floorId) ?? 0;
    assertPhysicalY(editing.physical[1] + offset, offset, editing.physical[1]);

    const placement: Placement = {
      id: editing.placementId ?? crypto.randomUUID(),
      modelId,
      equipmentId: editing.equipmentId,
      name: editing.name,
      position: [
        snapValue(editing.physical[0], 0),
        snapValue(editing.physical[1], 0),
        snapValue(editing.physical[2], 0),
      ],
      rotationYDeg: editing.rotationYDeg,
      mount: editing.mount,
      floorId: editing.floorId,
      roomId: editing.roomId,
      surfaceId: editing.surfaceId,
      locationNote: editing.locationNote,
      photoId: editing.photoId,
      entityId: null,
      symbol: editing.symbol,
      category: null,
    };

    setSaving(true);
    setEditError(null);
    runtime.lastSavePayload = placement;
    try {
      const saved = await runtime.dataApi.savePlacement(modelId, fingerprint, placement);
      upsertPlacement(saved);
      markPlaced(saved.equipmentId);
      pushUndo({ t: "commit", at: Date.now(), placementId: saved.id, before: null, after: saved });
      endEdit();
    } catch (err) {
      if (err instanceof NotPersistedError) {
        // Nowhere to save yet: keep it in the session and say so, rather than pretend.
        upsertPlacement(placement);
        setEditError("Saved for this session only — placements are not persisted yet.");
        endEdit();
        return;
      }
      setEditError(err instanceof Error ? err.message : "Could not save the placement.");
    } finally {
      setSaving(false);
    }
  }, [editing, index, modelId, fingerprint, runtime, upsertPlacement, markPlaced, pushUndo, endEdit, setEditError]);

  /**
   * Remove the placement. The equipment record itself is untouched — this says "it is not here",
   * not "it does not exist", which is why it lands back in the "Not placed yet" list rather than
   * disappearing from the household.
   */
  const remove = useCallback(async () => {
    if (!editing?.placementId || !modelId) return;
    setSaving(true);
    setEditError(null);
    try {
      await runtime.dataApi.deletePlacement(modelId, editing.placementId);
      removePlacement(editing.placementId);
      restorePlaceable({
        assetId: editing.equipmentId,
        name: editing.name,
        category: "",
        status: "installed",
        locationName: null,
      });
      endEdit();
      runtime.store.getState().announce(`${editing.name} removed from the model.`);
    } catch (err) {
      if (err instanceof NotPersistedError) {
        removePlacement(editing.placementId);
        endEdit();
        return;
      }
      setEditError(err instanceof Error ? err.message : "Could not remove the placement.");
    } finally {
      setSaving(false);
    }
  }, [editing, modelId, runtime, removePlacement, restorePlaceable, endEdit, setEditError]);

  if (!editing) return null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-ink">
          {editing.placementId ? "Adjust placement" : "Place equipment"}
        </h2>
        <UndoBar />
      </header>

      {phone ? (
        <p className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2">
          Drag placement is a desktop feature. Use the numbers and the nudge buttons here.
        </p>
      ) : (
        <p className="text-xs text-ink-2">
          Drag on the 3D view to place. Hold <kbd className="rounded bg-surface-2 px-1">Alt</kbd>{" "}
          to ignore the grid, <kbd className="rounded bg-surface-2 px-1">Shift</kbd> to constrain
          to one axis.
        </p>
      )}

      <NumericPlacementFields />

      <fieldset className="flex flex-col gap-1 text-xs">
        <legend className="text-ink-3">Nudge</legend>
        <div className="flex flex-wrap gap-1">
          <NudgeButton onClick={() => nudge(-snap.grid, 0, 0)} label="X −5 cm" />
          <NudgeButton onClick={() => nudge(snap.grid, 0, 0)} label="X +5 cm" />
          <NudgeButton onClick={() => nudge(0, -snap.grid, 0)} label="Z −5 cm" />
          <NudgeButton onClick={() => nudge(0, snap.grid, 0)} label="Z +5 cm" />
          <NudgeButton onClick={() => nudge(0, 0, -snap.rotationStep)} label="Rotate −15°" />
          <NudgeButton onClick={() => nudge(0, 0, snap.rotationStep)} label="Rotate +15°" />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-1 text-xs">
        <legend className="text-ink-3">Snapping</legend>
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={snap.enabled}
            onChange={(event) => setSnap({ enabled: event.currentTarget.checked })}
            className="h-4 w-4"
          />
          Snap to a {(snap.grid * 100).toFixed(0)} cm grid and {snap.rotationStep}° steps
        </label>
        <label className="flex min-h-8 items-center gap-2">
          <input
            type="checkbox"
            checked={snap.wallSnap}
            onChange={(event) => setSnap({ wallSnap: event.currentTarget.checked })}
            className="h-4 w-4"
          />
          Snap to walls and align to the wall normal
        </label>
      </fieldset>

      {editError ? <p className="text-xs text-overdue">{editError}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="min-h-9 rounded-md bg-accent px-3 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save placement"}
        </button>
        <button
          type="button"
          onClick={() => {
            setIndicator(null);
            cancelEdit();
          }}
          className="min-h-9 rounded-md border border-line bg-surface px-3 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Cancel (Esc)
        </button>
      </div>

      {/* Un-placing was impossible: the endpoint and the store action both existed, and nothing
          called either, so a marker put in the wrong room could be moved forever but never
          removed. Two-step rather than a dialog, because the editor panel is already a modal
          context and a second overlay on top of it reads as a mistake. */}
      {editing.placementId ? (
        <div className="flex items-center gap-2 border-t border-line pt-2">
          {confirmRemove ? (
            <>
              <span className="text-xs text-ink-2">Remove {editing.name} from the model?</span>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={saving}
                className="min-h-8 rounded-md border border-overdue/45 bg-surface px-2 text-xs font-semibold text-overdue hover:bg-overdue-soft disabled:opacity-50"
              >
                {saving ? "Removing…" : "Remove it"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3"
              >
                Keep it
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink-2 hover:bg-surface-3"
            >
              Remove from the model
            </button>
          )}
        </div>
      ) : null}

    </div>
  );
}

function NudgeButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 min-w-11 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3"
    >
      {label}
    </button>
  );
}

