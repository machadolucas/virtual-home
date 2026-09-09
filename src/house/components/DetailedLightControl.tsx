"use client";

import { useId } from "react";
import { Gauge, Lightbulb } from "lucide-react";
import { Button } from "@/ui";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";

/** Session-scoped light-detail budget. The renderer supplies the device ceiling after WebGL init. */
export function DetailedLightControl() {
  const id = useId();
  const helpId = `${id}-help`;
  const { requested, hardwareMax, performanceMode } = useHouseStore(
    useShallow((s) => ({
      requested: s.detailedLightLimit,
      hardwareMax: s.detailedLightHardwareMax,
      performanceMode: s.performanceMode,
    })),
  );
  const setLimit = useHouseStore((s) => s.setDetailedLightLimit);
  const selected = Math.min(requested, hardwareMax);

  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={helpId}>
      <legend className="flex w-full items-center gap-1.5 text-xs font-medium text-ink-2">
        <Lightbulb aria-hidden="true" className="size-4 text-ink-3" />
        Detailed lights
        <output htmlFor={id} className="ml-auto font-mono text-ink tabular-nums">
          {selected} of {hardwareMax}
        </output>
      </legend>
      <input
        id={id}
        type="range"
        aria-label="Detailed lights"
        aria-describedby={helpId}
        min={0}
        max={hardwareMax}
        step={1}
        value={selected}
        disabled={hardwareMax === 0}
        onChange={(event) => setLimit(event.currentTarget.valueAsNumber)}
        className="block min-h-9 w-full accent-accent max-sm:min-h-11"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={hardwareMax === 0 || selected === hardwareMax}
          onClick={() => setLimit(hardwareMax)}
        >
          <Gauge className="size-3.5" aria-hidden="true" />
          Device maximum
        </Button>
        {performanceMode ? (
          <span className="text-[11px] font-medium text-ink-2">Performance mode: 2 detailed</span>
        ) : null}
      </div>
      <p id={helpId} className="max-w-sm text-[11px] leading-4 text-ink-3">
        This device safely supports up to {hardwareMax}. Performance mode caps detailed lighting at
        2; extra active lights keep their visible glow.
      </p>
    </fieldset>
  );
}
