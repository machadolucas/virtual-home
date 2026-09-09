"use client";
/**
 * Exploded floors.
 *
 * Disabled during placement edit: entering edit mode collapses the gap and locks it, which removes
 * a whole class of "we saved the presentation position" bug rather than relying on a transform
 * being inverted correctly on every save path.
 */
import { MAX_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { Layers3 } from "lucide-react";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useIsPhone } from "../hooks/useReducedMotion";
import { ToolbarButton } from "./ViewToolbar";

export function ExplodeControl() {
  const { explode, setExplode, editing } = useHouseStore(
    useShallow((s) => ({ explode: s.explode, setExplode: s.setExplode, editing: s.editing })),
  );
  const phone = useIsPhone();

  // Explode needs precise orbiting to be legible, which a phone cannot give.
  if (phone) return null;

  const disabled = explode.locked || editing !== null;

  return (
    <section className="flex flex-col gap-1" aria-label="Exploded floors">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Exploded floors
        </span>
        <ToolbarButton
          pressed={explode.enabled}
          disabled={disabled}
          title={disabled ? "Exploded view is off while placing equipment." : undefined}
          onClick={() => setExplode({ enabled: !explode.enabled })}
        >
          <span className="inline-flex items-center gap-1">
            <Layers3 aria-hidden="true" className="size-3.5" />
            {explode.enabled ? "On (X)" : "Off (X)"}
          </span>
        </ToolbarButton>
      </div>
      <label className="flex flex-col gap-1 text-xs text-ink-2">
        <span>
          Gap <span className="font-mono">{explode.gap.toFixed(2)} m</span>
        </span>
        <input
          type="range"
          min={0}
          max={MAX_EXPLODE_GAP}
          step={0.1}
          value={explode.gap}
          disabled={disabled}
          onChange={(event) =>
            setExplode({ enabled: true, gap: Number(event.currentTarget.value) })
          }
          className="h-11 md:h-6 w-full touch-manipulation disabled:opacity-50"
          aria-label="Explode gap in metres"
        />
      </label>
      {disabled ? (
        <p className="text-[11px] text-ink-3">
          Exploded view is off while placing equipment, so a saved position is always the physical
          one.
        </p>
      ) : null}
    </section>
  );
}
