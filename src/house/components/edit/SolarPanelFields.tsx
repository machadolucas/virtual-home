"use client";

import { Ruler, Sun } from "lucide-react";
import { DEFAULT_SOLAR_PANEL_CONFIG, type SolarPanelConfig } from "@/house/model/solarPanel";
import { useHouseStore } from "../../hooks/useHouseStore";

export function SolarPanelFields() {
  const draft = useHouseStore((s) => s.editing);
  const update = useHouseStore((s) => s.updateDraft);
  if (!draft || draft.symbol !== "solar_panel") return null;
  const panel = draft.solarPanel ?? DEFAULT_SOLAR_PANEL_CONFIG;
  const fields: [keyof SolarPanelConfig, string, number, number, number][] = [
    ["widthM", "Panel width (m)", 0.1, 10, 0.01],
    ["lengthM", "Panel length (m)", 0.1, 10, 0.01],
    ["thicknessM", "Panel thickness (m)", 0.005, 1, 0.005],
    ["tiltDeg", "Panel tilt (°)", -90, 90, 1],
  ];
  return <fieldset className="space-y-2 rounded-md border border-line p-2 text-xs">
    <legend className="flex items-center gap-1 px-1"><Sun className="size-4" aria-hidden="true" />Solar panel</legend>
    <p className="text-ink-3">Click a roof to align with its slope. Rotation turns the slope direction; tilt adjusts its angle. Sizes are actual metres.</p>
    <div className="grid grid-cols-2 gap-2">
      {fields.map(([key, label, min, max, step]) => <label key={key} className="flex min-w-0 flex-col gap-1">
        <span className="inline-flex items-center gap-1"><Ruler className="size-3" aria-hidden="true" />{label}</span>
        <input key={`${key}:${panel[key]}`} type="number" min={min} max={max} step={step} defaultValue={panel[key]} onBlur={(event) => {
          const value = event.currentTarget.valueAsNumber;
          if (Number.isFinite(value) && value >= min && value <= max) update({ solarPanel: { ...panel, [key]: value } }, { coalesce: true });
          else { event.currentTarget.reportValidity(); event.currentTarget.value = String(panel[key]); }
        }} className="min-h-9 w-full rounded-md border border-line px-2 font-mono max-sm:min-h-11" />
      </label>)}
    </div>
  </fieldset>;
}
