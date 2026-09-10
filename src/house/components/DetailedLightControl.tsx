"use client";

import { useId } from "react";
import { Gauge, Lightbulb } from "lucide-react";
import { Button, Switch } from "@/ui";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";

/** Session-scoped light-detail budget. The renderer supplies the conservative recommendation after WebGL init. */
export function DetailedLightControl() {
  const id = useId();
  const helpId = `${id}-help`;
  const { requested, hardwareMax, performanceMode, experimental, error, capabilities } = useHouseStore(
    useShallow((s) => ({
      requested: s.detailedLightLimit,
      hardwareMax: s.detailedLightHardwareMax,
      performanceMode: s.performanceMode,
      experimental: s.detailedLightExperimental,
      error: s.detailedLightError,
      capabilities: s.detailedLightCapabilities,
    })),
  );
  const setLimit = useHouseStore((s) => s.setDetailedLightLimit);
  const setExperimental = useHouseStore((s) => s.setDetailedLightExperimental);
  const ceiling = experimental ? 64 : hardwareMax;
  const selected = Math.min(requested, ceiling);

  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={helpId}>
      <legend className="flex w-full items-center gap-1.5 text-xs font-medium text-ink-2">
        <Lightbulb aria-hidden="true" className="size-4 text-ink-3" />
        Detailed lights
        <output htmlFor={id} className="ml-auto font-mono text-ink tabular-nums">
          {selected} / {ceiling}
        </output>
      </legend>
      <input
        id={id}
        type="range"
        aria-label="Detailed lights"
        aria-describedby={helpId}
        min={0}
        max={ceiling}
        step={1}
        value={selected}
        disabled={ceiling === 0}
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
          Use recommended
        </Button>
        {performanceMode ? (
          <span className="text-[11px] font-medium text-ink-2">Performance mode: 2 detailed</span>
        ) : null}
      </div>
      <Switch checked={experimental} onCheckedChange={setExperimental} controlPosition="start" label="Try higher limits" />
      <p id={helpId} className="max-w-sm text-[11px] leading-4 text-ink-3">
        Recommended: {hardwareMax}, based on WebGL shader resources, not an FPS benchmark.
        Higher limits allow testing up to 64; rejected shaders automatically restore the recommendation.
        {performanceMode ? " Performance mode caps detailed lighting at 2." : " Extra lights keep their surface glow."}
      </p>
      {capabilities ? <p className="text-[10px] text-ink-3">WebGL: {capabilities.textures} texture units · {capabilities.varyings} varying vectors</p> : null}
      {error ? <p role="alert" className="text-xs text-ink-2">{error}</p> : null}
    </fieldset>
  );
}
