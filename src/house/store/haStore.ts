/**
 * Home Assistant live state, in its own **vanilla** zustand store.
 *
 * Separate from the house store for two reasons: HA traffic must never be able to invalidate a
 * selector in the view/selection store, and the label overlay subscribes to it imperatively from
 * outside React.
 */
import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";

export interface EntityState {
  entityId: string;
  /** `'on' | 'off' | '23.4' | 'unavailable' | 'unknown'` — never coerced to a number here. */
  state: string;
  lastUpdated: number;
  battery?: number | null;
  batteryType?: string | null;
  unit?: string | null;
  deviceClass?: string | null;
  /** Normalized light attributes retained by the server for live fixture rendering. */
  currentTemperature?: number | null;
  targetTemperature?: number | null;
  targetTempLow?: number | null;
  targetTempHigh?: number | null;
  temperatureUnit?: string | null;
  hvacAction?: string | null;
  fanMode?: string | null;
  brightness?: number | null;
  rgbColor?: [number, number, number] | null;
  hsColor?: [number, number] | null;
  colorTempKelvin?: number | null;
  colorTempMireds?: number | null;
}

export type ConnectionState = "idle" | "connecting" | "open" | "retrying" | "closed";

export interface HaStore {
  connection: ConnectionState;
  lastEventAt: number | null;
  lastSeq: number | null;
  entities: Record<string, EntityState>;
  applyBatch(events: readonly EntityState[]): void;
  setConnection(c: ConnectionState): void;
  setSeq(seq: number): void;
  reset(): void;
}

export const haStore = createStore<HaStore>()(
  subscribeWithSelector((set) => ({
    connection: "idle",
    lastEventAt: null,
    lastSeq: null,
    entities: {},

    /**
     * Replaces only the changed keys. The `{}` early-out matters: a duplicate event must not
     * notify subscribers, or a chatty sensor would wake the label layer for nothing.
     */
    applyBatch: (events) =>
      set((s) => {
        let next: Record<string, EntityState> | null = null;
        for (const e of events) {
          const prev = s.entities[e.entityId];
          if (prev && sameEntityState(prev, e)) continue;
          (next ??= { ...s.entities })[e.entityId] = e;
        }
        return next ? { entities: next, lastEventAt: Date.now() } : {};
      }),

    setConnection: (connection) => set((s) => (s.connection === connection ? {} : { connection })),
    setSeq: (lastSeq) => set({ lastSeq }),
    reset: () => set({ entities: {}, lastEventAt: null, lastSeq: null, connection: "idle" }),
  })),
);

function sameTuple(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined) {
  if (a == null || b == null) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameEntityState(a: EntityState, b: EntityState): boolean {
  return (
    a.state === b.state &&
    a.lastUpdated === b.lastUpdated &&
    a.battery === b.battery &&
    a.batteryType === b.batteryType &&
    a.unit === b.unit &&
    a.deviceClass === b.deviceClass &&
    a.currentTemperature === b.currentTemperature &&
    a.targetTemperature === b.targetTemperature &&
    a.targetTempLow === b.targetTempLow &&
    a.targetTempHigh === b.targetTempHigh &&
    a.temperatureUnit === b.temperatureUnit &&
    a.hvacAction === b.hvacAction &&
    a.fanMode === b.fanMode &&
    a.brightness === b.brightness &&
    sameTuple(a.rgbColor, b.rgbColor) &&
    sameTuple(a.hsColor, b.hsColor) &&
    a.colorTempKelvin === b.colorTempKelvin &&
    a.colorTempMireds === b.colorTempMireds
  );
}

// ---------------------------------------------------------------------------
// presentation classification
// ---------------------------------------------------------------------------

export type StateClass =
  | "unlinked"
  | "disconnected"
  | "unavailable"
  | "unknown"
  | "stale"
  | "live";

/**
 * Staleness by device class. Event-driven binary sensors legitimately go quiet for a day, so a
 * single global threshold would cry wolf on every door sensor.
 */
export const STALE_MS: Record<string, number> = {
  battery: 26 * 3600_000,
  temperature: 2 * 3600_000,
  humidity: 2 * 3600_000,
  door: 24 * 3600_000,
  window: 24 * 3600_000,
  motion: 24 * 3600_000,
  opening: 24 * 3600_000,
  default: 6 * 3600_000,
};

export const staleMs = (deviceClass?: string | null): number =>
  STALE_MS[deviceClass ?? "default"] ?? STALE_MS.default ?? 6 * 3600_000;

export function classifyState(
  entity: EntityState | undefined,
  connection: ConnectionState,
  now: number,
): StateClass {
  if (!entity) return "unlinked";
  if (connection !== "open") return "disconnected";
  if (entity.state === "unavailable") return "unavailable";
  if (entity.state === "unknown") return "unknown";
  // A connected HA stream is authoritative for event-driven lights. A lamp can remain steadily
  // on or off for days without emitting another state change.
  if (entity.entityId.startsWith("light.") || entity.entityId.startsWith("climate.")) return "live";
  if (now - entity.lastUpdated > staleMs(entity.deviceClass)) return "stale";
  return "live";
}

export interface BatteryThresholds {
  low: number;
  critical: number;
  /** Percentage points of hysteresis, so a reading hovering at the threshold does not flap. */
  hysteresis: number;
}

export const DEFAULT_BATTERY_THRESHOLDS: BatteryThresholds = {
  low: 20,
  critical: 10,
  hysteresis: 3,
};

export type BatteryClass = "ok" | "low" | "critical" | "unknown";

/**
 * `null`/`undefined` battery is **never** rendered as 0 %: it is "battery unknown". `previous`
 * applies the hysteresis so a value sitting on the threshold does not oscillate.
 */
export function classifyBattery(
  battery: number | null | undefined,
  previous: BatteryClass = "unknown",
  t: BatteryThresholds = DEFAULT_BATTERY_THRESHOLDS,
): BatteryClass {
  if (battery === null || battery === undefined || Number.isNaN(battery)) return "unknown";
  const up = (limit: number) => limit + t.hysteresis;
  if (previous === "critical") return battery > up(t.critical) ? (battery > up(t.low) ? "ok" : "low") : "critical";
  if (previous === "low") {
    if (battery <= t.critical) return "critical";
    return battery > up(t.low) ? "ok" : "low";
  }
  if (battery <= t.critical) return "critical";
  if (battery <= t.low) return "low";
  return "ok";
}

/** Marker instance colour key: battery state outranks a merely-live telemetry state. */
export function markerStateKey(
  entity: EntityState | undefined,
  connection: ConnectionState,
  now: number,
  previousBattery: BatteryClass = "unknown",
): string {
  const cls = classifyState(entity, connection, now);
  if (cls !== "live") return cls;
  const battery = classifyBattery(entity?.battery, previousBattery);
  if (battery === "critical") return "critical";
  if (battery === "low") return "low";
  return "live";
}
