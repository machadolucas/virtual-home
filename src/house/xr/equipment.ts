import type { EquipmentHaControlsResponse, HaControlCommand, HaControlEntity, HaRgbColor } from "@/domain/haControl";
import { request, sendEquipmentCommand } from "@/features/assets/equipmentControlClient";
import { classifyState, haStore } from "../store/haStore";
import type { Placement } from "../model/types";
import type { PanelPage, PanelRow } from "./panel";

/** An immersive presentation of the same authenticated command and observation paths as the card. */
export class HeadsetEquipment {
  private data: EquipmentHaControlsResponse | null = null;
  private readonly base: string;
  private entityId: string | null = null;
  private alive = true;
  private pending = false;
  private loading = false;
  private notice = "";
  private lastRead = -Infinity;
  private draft: Extract<HaControlCommand, { type: "turn_on" }> = { type: "turn_on" };

  constructor(readonly placement: Placement) {
    this.base = `/api/equipment/${encodeURIComponent(placement.equipmentId)}/controls`;
  }
  dispose() { this.alive = false; }
  async refresh() {
    if (this.loading) return;
    this.loading = true; this.lastRead = performance.now();
    try { this.data = await request<EquipmentHaControlsResponse>(this.base); }
    catch (error) { this.data = null; this.notice = error instanceof Error ? error.message : "Controls unavailable"; }
    finally { this.loading = false; }
  }
  private async send(entity: HaControlEntity, command: HaControlCommand) {
    if (this.pending || !this.data?.connected || !entity.available) return;
    this.pending = true; this.notice = "Sending to Home Assistant…";
    try {
      await sendEquipmentCommand(this.base, entity.registryId, command, () => this.alive);
      this.notice = "Sent to Home Assistant. Reported state updates separately.";
      this.draft = { type: "turn_on" };
      if (this.alive) await this.refresh();
    } catch (error) { this.notice = error instanceof Error ? error.message : "Command failed"; }
    finally { this.pending = false; }
  }
  menu(): PanelPage {
    if (performance.now() - this.lastRead > 5000) void this.refresh();
    const ha = haStore.getState();
    const rows: PanelRow[] = [];
    const entity = this.data?.entities.find(e => e.registryId === this.entityId);
    if (entity) {
      const caps = entity.capabilities;
      const enabled = this.data?.connected && entity.available && !this.pending;
      const action = (label: string, command: HaControlCommand) => rows.push({ label, act: enabled ? () => void this.send(entity, command) : undefined });
      action("Turn on", { type: "turn_on" }); action("Turn off", { type: "turn_off" });
      if (caps.brightness) {
        const value = this.draft.brightness ?? entity.brightness ?? 255;
        rows.push({ label: `Brightness  ${Math.round(value / 2.55)}%`, value: value / 255,
          act: f => { this.draft.brightness = Math.max(1, Math.round(f * 255)); } });
      }
      if (caps.colorTemperature && caps.minKelvin != null && caps.maxKelvin != null) {
        const low = caps.minKelvin, high = caps.maxKelvin;
        const value = this.draft.colorTempKelvin ?? entity.colorTempKelvin ?? low;
        rows.push({ label: `White temperature  ${value} K`, value: (value - low) / Math.max(1, high - low),
          act: f => { delete this.draft.rgbColor; this.draft.colorTempKelvin = Math.round(low + f * (high - low)); } });
      }
      if (caps.color) {
        const rgb = this.draft.rgbColor ?? entity.rgbColor ?? [255, 255, 255];
        ["Red", "Green", "Blue"].forEach((label, i) => {
          rows.push({ label: `${label}  ${rgb[i]}`, value: rgb[i]! / 255, act: f => {
            const changed: HaRgbColor = [...rgb]; changed[i] = Math.round(f * 255);
            delete this.draft.colorTempKelvin; this.draft.rgbColor = changed;
          } });
        });
      }
      if (Object.keys(this.draft).length > 1) action("Apply settings and turn on", { ...this.draft });
      rows.push({ label: "Back to equipment readings", act: () => { this.entityId = null; } });
      return { title: entity.name, lines: [`Reported: ${entity.state}`, !enabled && !this.pending ? "Control unavailable" : "", this.notice], rows };
    }
    const links = new Map((this.placement.linkedEntities ?? []).map(e => [e.entityId, e.name ?? e.entityId]));
    if (this.placement.entityId && !links.has(this.placement.entityId)) links.set(this.placement.entityId, this.placement.entityId);
    for (const [id, name] of links) {
      const reading = ha.entities[id];
      const status = classifyState(reading, ha.haConnected ? ha.connection : "closed", Date.now());
      rows.push({ label: `${name} · ${status === "live" ? [reading?.state, reading?.unit].filter(Boolean).join(" ") : status}` });
    }
    const controls = (this.data?.entities ?? []).map(e => ({ label: `Control · ${e.name}`, act: () => {
      this.entityId = e.registryId; this.draft = { type: "turn_on" };
    } }));
    return { title: this.placement.name, lines: [this.notice || (!this.data ? "Reading controls…" : !this.data.connected ? "Home Assistant disconnected" : "Equipment readings and controls")], rows: [...controls, ...rows] };
  }
}
