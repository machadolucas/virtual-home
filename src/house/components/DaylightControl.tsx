"use client";

import { useEffect, useState } from "react";
import { CloudSun, Clock, MapPin, Moon, Sun, Sunrise, RotateCcw } from "lucide-react";
import { useStore } from "zustand";
import { instantOf, localDateOf, localDateTimeOf } from "@/domain/time";
import { SegmentedControl, Select, Switch } from "@/ui";
import { useHouseStore } from "../hooks/useHouseStore";
import { classifyState, haStore } from "../store/haStore";
import {
  LUX_STORAGE_KEY,
  seedDaylightEntity,
  saveDaylightPreference,
  useDaylightHaEntities,
  WEATHER_STORAGE_KEY,
} from "./DaylightHaContext";

/** Presentation overrides only; neither the immutable model nor household location is rewritten. */
export function DaylightControl({ section = "all" }: { section?: "all" | "environment" | "quality" }) {
  const settings = useHouseStore((s) => s.illumination);
  const set = useHouseStore((s) => s.setIllumination);
  const coordinate = useHouseStore((s) => s.index?.manifest.coordinateSystem);
  const entities = useDaylightHaEntities();
  const connection = useStore(haStore, (s) => s.connection);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const latitude = settings.latitude ?? coordinate?.geoAnchor?.lat;
  const longitude = settings.longitude ?? coordinate?.geoAnchor?.lon;
  const located = latitude !== undefined && longitude !== undefined && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const at = settings.mode === "manual" ? settings.atMs ?? now : now;
  const preset = (time: string) => set({ mode: "manual", atMs: instantOf(localDateOf(settings.mode === "manual" ? at : Date.now(), zone), time, zone) });
  const button = "inline-flex min-h-8 items-center justify-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-surface-3 max-sm:min-h-11";
  const luxEntities = entities.filter((entity) => entity.kind === "illuminance");
  const weatherEntities = entities.filter((entity) => entity.kind === "weather");
  const luxEntity = entities.find((entity) => entity.registryId === settings.outdoorLuxRegistryId);
  const weatherEntity = entities.find((entity) => entity.registryId === settings.weatherRegistryId);
  const luxState = useStore(haStore, (s) => settings.outdoorLuxEntityId ? s.entities[settings.outdoorLuxEntityId] : undefined);
  const weatherState = useStore(haStore, (s) => settings.weatherEntityId ? s.entities[settings.weatherEntityId] : undefined);

  const selectEntity = (kind: "illuminance" | "weather", registryId: string) => {
    const entity = entities.find((candidate) => candidate.kind === kind && candidate.registryId === registryId) ?? null;
    const key = kind === "illuminance" ? LUX_STORAGE_KEY : WEATHER_STORAGE_KEY;
    saveDaylightPreference(key, entity?.registryId ?? null);
    seedDaylightEntity(entity);
    set(kind === "illuminance"
      ? { outdoorLuxRegistryId: entity?.registryId ?? null, outdoorLuxEntityId: entity?.entityId ?? null }
      : { weatherRegistryId: entity?.registryId ?? null, weatherEntityId: entity?.entityId ?? null });
  };

  const sourceStatus = (entity: typeof luxEntity, state: typeof luxState): string | null => {
    if (!entity) return null;
    const status = classifyState(state, connection, now);
    if (status !== "live") return `${entity.name}: ${status}; calculated daylight is used.`;
    return `${entity.name}: ${state?.state}${entity.unit ? ` ${entity.unit}` : ""}`;
  };
  const environment = (
    <fieldset className="min-w-0" aria-label="Daylight and shadows">
      <legend className="sr-only">Daylight and shadows</legend>
      <div className="grid min-w-0 items-start gap-x-4 gap-y-2 md:grid-cols-[minmax(16rem,1fr)_minmax(14rem,1fr)]">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <SegmentedControl
              ariaLabel="Lighting time mode"
              size="sm"
              value={settings.mode === "manual" ? "manual" : settings.mode}
              onValueChange={(mode) => {
                if (mode === "manual") set({ mode: "manual", atMs: settings.atMs ?? now });
                else set({ mode });
              }}
              items={[
                { value: "live", label: "Live time", icon: <Clock aria-hidden="true" /> },
                { value: "manual", label: "Preview", icon: <Sunrise aria-hidden="true" /> },
                { value: "studio", label: "Studio", icon: <Sun aria-hidden="true" /> },
              ]}
            />
            <div className="ml-auto flex gap-1">
              <button type="button" className={button} title="Morning, 08:00" aria-label="Morning, 08:00" onClick={() => preset("08:00")}><Sunrise className="size-4" aria-hidden="true" /></button>
              <button type="button" className={button} title="Noon, 12:00" aria-label="Noon, 12:00" onClick={() => preset("12:00")}><Sun className="size-4" aria-hidden="true" /></button>
              <button type="button" className={button} title="Night, 00:00" aria-label="Night, 00:00" onClick={() => preset("00:00")}><Moon className="size-4" aria-hidden="true" /></button>
            </div>
          </div>
          <label className="flex min-w-0 items-center gap-2 text-xs max-sm:flex-col max-sm:items-stretch">
            <span className="shrink-0 text-ink-2">Preview ({zone})</span>
            <input type="datetime-local" aria-label={`Preview date and time (${zone})`} className="block min-h-8 min-w-0 flex-1 rounded border border-line bg-surface px-2 max-sm:min-h-11" value={localDateTimeOf(at, zone)} onChange={(e) => {
              const [date, time] = e.target.value.split("T");
              if (date && time) set({ mode: "manual", atMs: instantOf(date, time, zone) });
            }} />
          </label>
        </div>
        <label className="block min-w-0 text-xs">
          <span className="flex items-center gap-1"><Sun className="size-4" aria-hidden="true" />Global illumination <output className="ml-auto tabular-nums">{Math.round(settings.intensity * 100)}%</output></span>
          <input type="range" aria-label="Global illumination intensity" min="0" max="300" step="5" value={Math.round(settings.intensity * 100)} onChange={(e) => set({ intensity: Number(e.target.value) / 100 })} className="block min-h-8 w-full accent-accent max-sm:min-h-11" />
          <span className="text-[11px] leading-4 text-ink-3">100% is calibrated. Equipment lights keep their own brightness.</span>
        </label>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-5">
      <details className="text-xs">
        <summary className="cursor-pointer py-1"><CloudSun className="mr-1 inline size-3.5" aria-hidden="true" />Outdoor conditions</summary>
        <div className="mt-1 space-y-2">
          <label className="block">Outdoor illuminance
            <Select
              value={settings.outdoorLuxRegistryId ?? ""}
              onValueChange={(value) => selectEntity("illuminance", value)}
              options={[{ value: "", label: "Calculated daylight" }, ...luxEntities.map((entity) => ({ value: entity.registryId, label: entity.name, hint: entity.entityId }))]}
              ariaLabel="Outdoor illuminance source"
              selectSize="sm"
              className="mt-1 w-full"
            />
          </label>
          <label className="block">Weather
            <Select
              value={settings.weatherRegistryId ?? ""}
              onValueChange={(value) => selectEntity("weather", value)}
              options={[{ value: "", label: "No weather adjustment" }, ...weatherEntities.map((entity) => ({ value: entity.registryId, label: entity.name, hint: entity.entityId }))]}
              ariaLabel="Weather source"
              selectSize="sm"
              className="mt-1 w-full"
            />
          </label>
          {[sourceStatus(luxEntity, luxState), sourceStatus(weatherEntity, weatherState)].filter(Boolean).map((status) => <p key={status} className="text-ink-3">{status}</p>)}
          <p className="text-ink-3">Live time uses available readings for brightness and colour. Manual previews and Studio ignore them. Choices are remembered in this browser.</p>
        </div>
      </details>
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
        <p className="mt-1 text-ink-3">Overrides are remembered on this device. Model north: {coordinate?.north?.certainty ?? "unknown"}. Shadows are approximate.</p>
      </details>
      </div>
      {!located && settings.mode !== "studio" && <p className="text-xs text-ink-3">Set latitude and longitude to enable daylight. Studio lighting is used until then.</p>}
    </fieldset>
  );

  const quality = (
    <fieldset aria-label="Shadow quality">
      <legend className="sr-only">Shadow quality</legend>
      <Switch
        checked={settings.softShadows}
        onCheckedChange={(softShadows) => set({ softShadows })}
        controlPosition="start"
        label={<span className="inline-flex items-center gap-1"><Moon className="size-4" aria-hidden="true" />Soft shadows</span>}
        hint="Turn off for crisp shadow edges."
        compact
      />
    </fieldset>
  );

  if (section === "environment") return environment;
  if (section === "quality") return quality;
  return <div className="space-y-2">{environment}{quality}</div>;
}
