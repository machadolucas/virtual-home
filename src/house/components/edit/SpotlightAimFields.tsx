"use client";

import { Crosshair, RotateCcw, X } from "lucide-react";
import type { EditDraft } from "@/house/store/slices/edit";
import { defaultSymbol, isPlacementSymbol } from "@/house/scene/symbols";
import { defaultLightAim, isSpotlightSymbol } from "@/house/model/equipmentLight";
import { useHouseStore } from "../../hooks/useHouseStore";

export { isSpotlightSymbol } from "@/house/model/equipmentLight";

export function draftSymbol(draft: EditDraft) {
  return isPlacementSymbol(draft.symbol) ? draft.symbol : defaultSymbol({ category: draft.category, entityId: draft.entityId, mountKind: draft.mount.kind, isOutdoor: !draft.roomId });
}

export function SpotlightAimFields({
  aiming,
  canAimInView,
  disabled,
  onAimingChange,
}: {
  aiming: boolean;
  canAimInView: boolean;
  disabled?: boolean;
  onAimingChange(aiming: boolean): void;
}) {
  const editing = useHouseStore((state) => state.editing);
  const updateDraft = useHouseStore((state) => state.updateDraft);
  if (!editing || !isSpotlightSymbol(draftSymbol(editing))) return null;

  const aim = editing.lightAim ?? defaultLightAim(draftSymbol(editing), editing.rotationYDeg);
  const update = (field: "yawDeg" | "pitchDeg", raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    updateDraft(
      {
        lightAim: {
          ...aim,
          [field]: field === "pitchDeg" ? Math.min(90, Math.max(-90, value)) : ((value + 180) % 360 + 360) % 360 - 180,
        },
      },
      { coalesce: true },
    );
  };

  return (
    <fieldset
      disabled={disabled}
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-2 text-xs disabled:opacity-60"
    >
      <legend className="px-1 text-ink-2">Spotlight direction</legend>
      <p className="text-[11px] leading-4 text-ink-3">
        Yaw turns around the house; pitch is −90° down, 0° level and +90° up.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-ink-3">Yaw (°)</span>
          <input
            type="number"
            step={5}
            value={aim.yawDeg}
            onChange={(event) => update("yawDeg", event.currentTarget.value)}
            className="min-h-11 rounded-md border border-line bg-surface px-2 font-mono text-xs md:min-h-8"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-3">Pitch (°)</span>
          <input
            type="number"
            min={-90}
            max={90}
            step={5}
            value={aim.pitchDeg}
            onChange={(event) => update("pitchDeg", event.currentTarget.value)}
            className="min-h-11 rounded-md border border-line bg-surface px-2 font-mono text-xs md:min-h-8"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {canAimInView ? (
          <button
            type="button"
            aria-pressed={aiming}
            onClick={() => onAimingChange(!aiming)}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 md:min-h-8"
          >
            {aiming ? <X aria-hidden="true" className="size-3.5" /> : <Crosshair aria-hidden="true" className="size-3.5" />}
            {aiming ? "Cancel aiming" : "Aim in 3D view"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            onAimingChange(false);
            updateDraft({ lightAim: null });
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3 md:min-h-8"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Reset direction
        </button>
      </div>
      {aiming ? (
        <p role="status" className="text-[11px] leading-4 text-accent-text">
          Point at a surface in the 3D view, then click to aim the beam there.
        </p>
      ) : null}
    </fieldset>
  );
}
