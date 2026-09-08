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
import { SnapReadout } from "./SnapIndicator";
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
  const pushUndo = useHouseStore((s) => s.pushUndo);
  const [indicator, setIndicatorState] = useState<SnapIndicatorState | null>(null);
  // The in-canvas indicator layer subscribes to the runtime; the readout below uses local state.
  const setIndicator = useCallback(
    (next: SnapIndicatorState | null) => {
      setIndicatorState(next);
      runtime.setSnapIndicator(next);
    },
    [runtime],
  );
  const [saving, setSaving] = useState(false);
  const dragging = useRef(false);

  /**
   * Drag placement on a pointer device only. On phones this is numeric-only plus the nudge
   * buttons: complex geometry editing favours a desktop, and a 44 px finger on a 5 cm grid is not
   * precision.
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

    const solve = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const hit = picker.pick(event.clientX, event.clientY, rect, camera, sceneIndex, clip, {
        candidates,
      });
      const solution = resolveSnap({
        hit,
        config: snap,
        manifest: index,
        draft: editing,
        modifiers: { alt: event.altKey, shift: event.shiftKey },
        meshOf: (id) => sceneIndex.surfaceMesh.get(id),
        anchorOf: (id) => index.roomAnchors.get(id)?.point,
      });
      setIndicator(solution.indicator);
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

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging.current = true;
      setControlsEnabled(runtime, false);
      solve(event);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      solve(event);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      setControlsEnabled(runtime, true);
      setIndicator(null);
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      setControlsEnabled(runtime, true);
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
    if (!editing.roomId) {
      setEditError("The position is outside every room on this floor. Move it inside a room, or pick a different floor.");
      return;
    }
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
    };

    setSaving(true);
    setEditError(null);
    runtime.lastSavePayload = placement;
    try {
      const saved = await runtime.dataApi.savePlacement(modelId, fingerprint, placement);
      upsertPlacement(saved);
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
  }, [editing, index, modelId, fingerprint, runtime, upsertPlacement, pushUndo, endEdit, setEditError]);

  if (!editing) return null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-neutral-900">
          {editing.placementId ? "Adjust placement" : "Place equipment"}
        </h2>
        <UndoBar />
      </header>

      {phone ? (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
          Drag placement is a desktop feature. Use the numbers and the nudge buttons here.
        </p>
      ) : (
        <p className="text-xs text-neutral-600">
          Drag on the 3D view to place. Hold <kbd className="rounded bg-neutral-100 px-1">Alt</kbd>{" "}
          to ignore the grid, <kbd className="rounded bg-neutral-100 px-1">Shift</kbd> to constrain
          to one axis.
        </p>
      )}

      <NumericPlacementFields />

      <fieldset className="flex flex-col gap-1 text-xs">
        <legend className="text-neutral-500">Nudge</legend>
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
        <legend className="text-neutral-500">Snapping</legend>
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

      {editError ? <p className="text-xs text-red-700">{editError}</p> : null}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="min-h-9 rounded-md bg-sky-700 px-3 text-xs font-semibold text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save placement"}
        </button>
        <button
          type="button"
          onClick={() => {
            setIndicator(null);
            cancelEdit();
          }}
          className="min-h-9 rounded-md border border-neutral-300 bg-white px-3 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
        >
          Cancel (Esc)
        </button>
      </div>

      <SnapReadout state={indicator} />
    </div>
  );
}

function NudgeButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 min-w-11 rounded-md border border-neutral-300 bg-white px-2 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
    >
      {label}
    </button>
  );
}

/** Stop the camera orbiting mid-placement, and let it go again on pointer-up. */
function setControlsEnabled(runtime: ReturnType<typeof useHouseRuntime>, enabled: boolean): void {
  if (runtime.controls) runtime.controls.enabled = enabled;
}
