"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Lightbulb, Power, RefreshCw, SlidersHorizontal, Thermometer, Palette } from "lucide-react";
import type { EquipmentHaControlsResponse, HaControlEntity, HaControlCommand } from "@/domain/haControl";
import { Button, Switch } from "@/ui";

type Command = HaControlCommand;

const ERROR_LABELS: Record<string, string> = {
  ha_disconnected: "Home Assistant is disconnected. Try again when it reconnects.",
  entity_unavailable: "This entity is unavailable in Home Assistant.",
  unsupported_capability: "This device no longer supports that setting. Refresh its controls.",
  ha_timeout: "Home Assistant did not confirm the command. Refresh the device state before retrying.",
  result_unknown: "The command result is uncertain. Refresh the device state before retrying.",
  control_result_unknown: "The command result is uncertain. Refresh the device state before retrying.",
  ha_rejected: "Home Assistant rejected the command. Check the device and try again.",
  control_entity_unlinked: "This entity is no longer linked to the equipment. Refresh its controls.",
  control_entity_disabled: "This entity is disabled in Home Assistant. Refresh its controls.",
  control_capability_changed: "The device capabilities changed. Refresh its controls before trying again.",
  control_entity_missing: "This entity is no longer available. Refresh its controls.",
  control_entity_changed: "The entity changed before the command could be sent. Refresh its controls.",
  control_expired: "The command expired before it could be sent. Nothing was sent.",
  expired: "The command expired before it could be sent. Nothing was sent.",
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(ERROR_LABELS[body.error] ?? body.message ?? body.hint ?? "Could not contact Home Assistant. Refresh and try again.");
  return body as T;
}

/** Same controls in the equipment page and viewer. State is observed from HA, never guessed on send. */
export function EquipmentHaControls({ assetId }: { assetId: string }) {
  const [data, setData] = useState<EquipmentHaControlsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const requestSequence = useRef(0);
  const base = `/api/equipment/${encodeURIComponent(assetId)}/controls`;
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const value = await request<EquipmentHaControlsResponse>(base);
      if (mounted.current && sequence === requestSequence.current) { setData(value); setError(null); }
    } catch (err) {
      if (mounted.current && sequence === requestSequence.current) setError(err instanceof Error ? err.message : "Could not load controls.");
    }
  }, [base]);

  useEffect(() => {
    mounted.current = true;
    const sequenceRef = requestSequence;
    const start = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5_000);
    return () => { mounted.current = false; sequenceRef.current++; clearTimeout(start); clearInterval(timer); };
  }, [refresh]);

  if (data?.entities.length === 0 && !error) return null;
  return (
    <section aria-label="Home Assistant controls" className="flex flex-col gap-2 rounded-md border border-line p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium"><SlidersHorizontal className="size-4" aria-hidden="true" />Device controls</h3>
        <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden="true" />} aria-label="Refresh device controls" title="Refresh device controls" onClick={() => void refresh()} />
      </div>
      {!data && !error && <p role="status" className="text-xs text-ink-3">Loading controls…</p>}
      {error && <p role="alert" className="text-xs text-overdue">{error}</p>}
      {data && !data.connected && <p className="text-xs text-ink-3">Home Assistant is disconnected.</p>}
      {data?.entities.map((entity) => <EntityControls key={`${assetId}:${entity.registryId}`} entity={entity} base={base} connected={data.connected && !error} refresh={refresh} />)}
    </section>
  );
}

function EntityControls({ entity, base, connected, refresh }: {
  entity: HaControlEntity; base: string; connected: boolean; refresh(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [brightness, setBrightness] = useState<number | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [color, setColor] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<"white" | "color">("white");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const disabled = !connected || !entity.available || pending;
  const caps = entity.capabilities;
  const currentBrightness = Math.round((entity.brightness ?? 255) / 255 * 100);
  const currentTemperature = entity.colorTempKelvin ?? caps.minKelvin ?? 2700;
  const currentColor = `#${(entity.rgbColor ?? [255, 255, 255]).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("")}`;
  const dirty = brightness !== null || (temperature !== null && (!caps.color || colorMode === "white")) || (color !== null && (!caps.colorTemperature || colorMode === "color"));

  const send = async (command: Command) => {
    if (disabled) return;
    setPending(true); setError(null); setMessage("Sending to Home Assistant…");
    try {
      const queued = await request<{ commandId: string; status: string }>(base, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID(), registryId: entity.registryId, command }),
      });
      const deadline = Date.now() + 35_000;
      let status = queued.status;
      while ((status === "queued" || status === "sending") && Date.now() < deadline && alive.current) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (!alive.current) return;
        const receipt = await request<{ status: string; error?: string | null }>(`${base}/${encodeURIComponent(queued.commandId)}`);
        status = receipt.status;
        if (status === "failed" || status === "expired") throw new Error(ERROR_LABELS[receipt.error ?? status] ?? receipt.error ?? "Home Assistant could not complete the command.");
      }
      if (!alive.current) return;
      if (status !== "sent") throw new Error("The result is not confirmed yet. Refresh the state before trying again.");
      setBrightness(null); setTemperature(null); setColor(null);
      setMessage("Sent to Home Assistant. Reported state updates when received from the device.");
      await refresh();
    } catch (err) {
      if (alive.current) { setError(err instanceof Error ? err.message : "Could not send command."); setMessage(null); }
    } finally { if (alive.current) setPending(false); }
  };

  const apply = () => {
    const command: Command = { type: "turn_on" };
    if (brightness !== null && caps.brightness) command.brightness = Math.round(brightness / 100 * 255);
    if (temperature !== null && caps.colorTemperature && (!caps.color || colorMode === "white")) command.colorTempKelvin = temperature;
    if (color !== null && caps.color && (!caps.colorTemperature || colorMode === "color")) command.rgbColor = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number];
    void send(command);
  };

  return (
    <fieldset className="min-w-0 space-y-2 border-t border-line pt-2" aria-label={`${entity.name} controls`}>
      <legend className="sr-only">{entity.name}</legend>
      <Switch disabled={disabled} checked={entity.state === "on"} onCheckedChange={(on) => void send({ type: on ? "turn_on" : "turn_off" })} controlPosition="start" label={<span className="inline-flex items-center gap-1.5">{entity.entityId.startsWith("light.") ? <Lightbulb className="size-4" aria-hidden="true" /> : <Power className="size-4" aria-hidden="true" />}{entity.name}</span>} />
      <p className="text-xs text-ink-3">{entity.available ? `Reported state: ${entity.state}` : "Unavailable in Home Assistant"}</p>
      {caps.brightness && <label className="block text-xs"><span className="flex items-center gap-1"><SlidersHorizontal className="size-3.5" aria-hidden="true" />Brightness · {brightness ?? currentBrightness}%</span><input aria-label={`${entity.name} brightness`} disabled={disabled} type="range" min="1" max="100" value={brightness ?? Math.max(1, currentBrightness)} onChange={(e) => setBrightness(Number(e.target.value))} className="my-1 min-h-8 w-full accent-accent" /></label>}
      {caps.colorTemperature && caps.color && <div className="flex gap-1" role="group" aria-label={`${entity.name} color mode`}>
        <Button size="sm" disabled={disabled} aria-pressed={colorMode === "white"} icon={<Thermometer aria-hidden="true" />} onClick={() => setColorMode("white")}>White</Button>
        <Button size="sm" disabled={disabled} aria-pressed={colorMode === "color"} icon={<Palette aria-hidden="true" />} onClick={() => setColorMode("color")}>Color</Button>
      </div>}
      {caps.colorTemperature && (!caps.color || colorMode === "white") && caps.minKelvin !== null && caps.maxKelvin !== null && <label className="block text-xs"><span className="flex items-center gap-1"><Thermometer className="size-3.5" aria-hidden="true" />White temperature · {temperature ?? currentTemperature} K</span><input aria-label={`${entity.name} white temperature`} disabled={disabled} type="range" min={caps.minKelvin} max={caps.maxKelvin} step="1" value={temperature ?? currentTemperature} onChange={(e) => setTemperature(Number(e.target.value))} className="my-1 min-h-8 w-full accent-accent" /></label>}
      {caps.color && (!caps.colorTemperature || colorMode === "color") && <label className="flex items-center gap-2 text-xs"><Palette className="size-3.5" aria-hidden="true" />Color<input aria-label={`${entity.name} color`} type="color" disabled={disabled} value={color ?? currentColor} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 rounded border border-line bg-surface" /></label>}
      {(caps.brightness || caps.colorTemperature || caps.color) && <Button size="sm" disabled={disabled || !dirty} loading={pending} icon={<Power aria-hidden="true" />} onClick={apply}>Apply and turn on</Button>}
      {message && <p role="status" className="text-xs text-ink-3">{message}</p>}
      {error && <p role="alert" className="text-xs text-overdue">{error}</p>}
    </fieldset>
  );
}
