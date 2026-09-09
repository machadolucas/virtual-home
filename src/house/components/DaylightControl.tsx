"use client";

import { useState } from "react";
import { Clock, MapPin, Moon, Sun, Sunrise, RotateCcw } from "lucide-react";
import { instantOf, localDateOf, localDateTimeOf } from "@/domain/time";
import { Switch } from "@/ui";
import { useHouseStore } from "../hooks/useHouseStore";

/** Presentation overrides only; neither the immutable model nor household location is rewritten. */
export function DaylightControl() {
  const settings = useHouseStore((s) => s.illumination);
  const set = useHouseStore((s) => s.setIllumination);
  const coordinate = useHouseStore((s) => s.index?.manifest.coordinateSystem);
  const [now] = useState(() => Date.now());
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const latitude = settings.latitude ?? coordinate?.geoAnchor?.lat;
  const longitude = settings.longitude ?? coordinate?.geoAnchor?.lon;
  const located = latitude !== undefined && longitude !== undefined;
  const at = settings.atMs ?? now;
  const preset = (time: string) => set({ mode: "manual", atMs: instantOf(localDateOf(at, zone), time, zone) });
  const button = "inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-surface-3 max-sm:min-h-11";
  return (
    <fieldset className="min-w-0 space-y-2" aria-label="Daylight and shadows">
      <legend className="mb-2 flex items-center gap-1 text-xs font-medium"><Sun className="size-4" aria-hidden="true" />Daylight and shadows</legend>
      <div className="flex flex-wrap gap-1">
        <button type="button" className={button} aria-pressed={settings.mode === "live"} onClick={() => set({ mode: "live" })}><Clock className="size-4" aria-hidden="true" />Live time</button>
        <button type="button" className={button} aria-pressed={settings.mode === "studio"} onClick={() => set({ mode: "studio" })}><Sun className="size-4" aria-hidden="true" />Studio</button>
        <button type="button" className={button} title="Morning, 08:00" aria-label="Morning, 08:00" onClick={() => preset("08:00")}><Sunrise className="size-4" aria-hidden="true" /></button>
        <button type="button" className={button} title="Noon, 12:00" aria-label="Noon, 12:00" onClick={() => preset("12:00")}><Sun className="size-4" aria-hidden="true" /></button>
        <button type="button" className={button} title="Night, 00:00" aria-label="Night, 00:00" onClick={() => preset("00:00")}><Moon className="size-4" aria-hidden="true" /></button>
      </div>
      <label className="block text-xs">Preview date and time ({zone})
        <input type="datetime-local" className="mt-1 block min-h-9 w-full min-w-0 rounded border border-line bg-surface px-2 max-sm:min-h-11" value={localDateTimeOf(at, zone)} onChange={(e) => {
          const [date, time] = e.target.value.split("T");
          if (date && time) set({ mode: "manual", atMs: instantOf(date, time, zone) });
        }} />
      </label>
      <Switch checked={settings.softShadows} onCheckedChange={(softShadows) => set({ softShadows })} controlPosition="start" label={<span className="inline-flex items-center gap-1"><Moon className="size-4" aria-hidden="true" />Soft shadows</span>} className="min-h-9 py-0" />
      <details className="text-xs">
        <summary className="cursor-pointer py-1"><MapPin className="mr-1 inline size-3.5" aria-hidden="true" />Location and north</summary>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {([['Latitude', 'latitude', latitude, -90, 90], ['Longitude', 'longitude', longitude, -180, 180], ['North bearing (°)', 'northDeg', settings.northDeg ?? coordinate?.north?.bearingDeg ?? 0, -180, 360]] as const).map(([label, key, value, min, max]) => (
            <label key={key}>{label}<input type="number" key={`${key}:${value}`} step="any" min={min} max={max} defaultValue={value ?? ""} className="mt-1 min-h-9 w-full rounded border border-line bg-surface px-2 max-sm:min-h-11" onBlur={(e) => {
              const number = e.target.valueAsNumber;
              if (!e.target.value) set({ [key]: null });
              else if (Number.isFinite(number) && number >= min && number <= max) set({ [key]: number });
              else e.currentTarget.reportValidity();
            }} /></label>
          ))}
          <button type="button" className={button} onClick={() => set({ latitude: null, longitude: null, northDeg: null })}><RotateCcw className="size-4" aria-hidden="true" />Model location</button>
        </div>
        <p className="mt-1 text-ink-3">Overrides apply to this view only. Model north: {coordinate?.north?.certainty ?? "unknown"}. Shadows are approximate.</p>
      </details>
      {!located && settings.mode !== "studio" && <p className="text-xs text-ink-3">Set latitude and longitude to enable daylight. Studio lighting is used until then.</p>}
    </fieldset>
  );
}
