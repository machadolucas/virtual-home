"use client";

import { useId } from "react";
import { Gauge, Lightbulb } from "lucide-react";
import { Button, Switch } from "@/ui";
import { DETAILED_LIGHT_SLIDER_MAX, SINGLE_PASS_LIGHT_MAX } from "../model/detailedLightBudget";
import { useHouseStore, useShallow } from "../hooks/useHouseStore";

/** Device-local light-detail budget. The renderer supplies the conservative recommendation after WebGL init. */
export function DetailedLightControl() {
  const id = useId();
  const helpId = `${id}-help`;
  const { requested, hardwareMax, performanceMode, batched, all, experimental, error, capabilities } = useHouseStore(
    useShallow((s) => ({
      requested: s.detailedLightLimit,
      hardwareMax: s.detailedLightHardwareMax,
      performanceMode: s.performanceMode,
      batched: s.detailedLightBatched,
      all: s.detailedLightAll,
      experimental: s.detailedLightExperimental,
      error: s.detailedLightError,
      capabilities: s.detailedLightCapabilities,
    })),
  );
  const setBatched = useHouseStore((s) => s.setDetailedLightBatched);
  const setAll = useHouseStore((s) => s.setDetailedLightAll);
  const setLimit = useHouseStore((s) => s.setDetailedLightLimit);
  const setExperimental = useHouseStore((s) => s.setDetailedLightExperimental);
  const ceiling = batched ? DETAILED_LIGHT_SLIDER_MAX : experimental ? SINGLE_PASS_LIGHT_MAX : hardwareMax;
  const selected = Math.min(requested, ceiling);

  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={helpId}>
      <legend className="flex w-full items-center gap-1.5 text-xs font-medium text-ink-2">
        <Lightbulb aria-hidden="true" className="size-4 text-ink-3" />
        Detailed lights
        <output htmlFor={id} className="ml-auto font-mono text-ink tabular-nums">
          {batched && all ? "All" : `${selected} / ${ceiling}`}
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
        disabled={ceiling === 0 || (batched && all)}
        onChange={(event) => setLimit(event.currentTarget.valueAsNumber)}
        className="block min-h-9 w-full accent-accent max-sm:min-h-11"
      />
      <div className="flex flex-wrap items-center gap-2">
        {!batched ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={hardwareMax === 0 || selected === hardwareMax}
            onClick={() => setLimit(hardwareMax)}
          >
            <Gauge className="size-3.5" aria-hidden="true" />
            Use recommended
          </Button>
        ) : null}
        {performanceMode ? (
          <span className="text-[11px] font-medium text-ink-2">Performance mode: 2 detailed</span>
        ) : null}
      </div>
      <div className="grid gap-x-5 md:grid-cols-3">
        <Switch checked={batched} onCheckedChange={setBatched} controlPosition="start" label="Batched lighting" compact />
        {batched ? <Switch checked={all} onCheckedChange={setAll} controlPosition="start" label="All installed lights" compact /> : null}
        {!batched ? (
          <Switch checked={experimental} onCheckedChange={setExperimental} controlPosition="start" label="Try higher limits" compact />
        ) : null}
      </div>
      <details className="text-[11px] leading-4 text-ink-3">
        <summary className="cursor-pointer py-1 font-medium text-ink-2">Budget details and diagnostics</summary>
        <p id={helpId} className="max-w-2xl">
          {batched ? (
            <>Up to {hardwareMax} lights per pass, based conservatively on WebGL shader resources. Additional lights render in extra passes. All installed lights removes the total cap; cost grows with the number of fixtures.</>
          ) : (
            <>
              Recommended: {hardwareMax}, based on WebGL shader resources, not an FPS benchmark.
              Higher limits allow testing up to 64; rejected shaders automatically restore the recommendation.
            </>
          )}
          {performanceMode ? " Performance mode caps detailed lighting at 2." : " Lights beyond a selected budget keep their simpler surface glow."}
        </p>
        {capabilities ? <p className="mt-1 text-[10px]">WebGL: {capabilities.textures} texture units · {capabilities.varyings} varying vectors</p> : null}
      </details>
      {error ? <p role="alert" className="text-xs text-ink-2">{error}</p> : null}
    </fieldset>
  );
}
