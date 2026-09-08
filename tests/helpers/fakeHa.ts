/**
 * A controllable fake Home Assistant WebSocket server, plus the manual clock the HA socket tests
 * drive it with.
 *
 * The point of a real `ws` server (rather than a stubbed WebSocket class) is that the transport
 * tests exercise the actual framing, JSON round-trip, half-open handling and `terminate()`
 * behaviour. Determinism comes from `ManualClock`: `HaSocket` takes its timers and its randomness
 * from `deps`, so nothing fires until a test advances the clock.
 *
 * Sample data is shaped like the real household instance: a Parmair MAC 120 ventilation unit with
 * a 2026.9-style child device, an IKEA MYGGBETT door sensor with the classic
 * battery / battery_type / battery_voltage trio, a Zigbee coordinator as a `service` device, and
 * the two mobile_app phones that own the notify targets.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type {
  HaAreaRegistryEntry,
  HaDeviceRegistryEntry,
  HaEntityRegistryEntry,
  HaFloorRegistryEntry,
  HaState,
} from "@/worker/ha/protocol";

/* -------------------------------------------------------------- manual clock */

interface ScheduledTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

/**
 * A hand-cranked `setTimeout`/`Date.now()` pair.
 *
 * `advance(ms)` moves time forward in due-order, setting `now` to each timer's due time before
 * running it, so cascading timers behave like real ones. Timers scheduled beyond the target time
 * are left alone - which is what lets a test advance exactly one backoff delay without also
 * tripping the next handshake timeout.
 */
export class ManualClock {
  #now: number;
  #nextId = 1;
  #timers = new Map<number, ScheduledTimer>();

  constructor(startMs = 1_760_000_000_000) {
    this.#now = startMs;
  }

  now = (): number => this.#now;

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.#nextId++;
    this.#timers.set(id, { id, dueAt: this.#now + Math.max(0, ms), callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") this.#timers.delete(handle);
  };

  get pendingCount(): number {
    return this.#timers.size;
  }

  /** Milliseconds until the earliest pending timer, or null when idle. */
  get nextDueInMs(): number | null {
    let earliest: number | null = null;
    for (const timer of this.#timers.values()) {
      if (earliest === null || timer.dueAt < earliest) earliest = timer.dueAt;
    }
    return earliest === null ? null : Math.max(0, earliest - this.#now);
  }

  /** Advance time by `ms`, running every timer that becomes due. Returns how many ran. */
  advance(ms: number): number {
    const target = this.#now + Math.max(0, ms);
    let ran = 0;
    for (let guard = 0; guard < 10_000; guard += 1) {
      let next: ScheduledTimer | null = null;
      for (const timer of this.#timers.values()) {
        if (timer.dueAt <= target && (next === null || timer.dueAt < next.dueAt)) next = timer;
      }
      if (!next) break;
      this.#timers.delete(next.id);
      this.#now = Math.max(this.#now, next.dueAt);
      next.callback();
      ran += 1;
    }
    this.#now = target;
    return ran;
  }
}

/* ------------------------------------------------------------- sample data */

/** Fixed "now" the sample states are stamped relative to, so staleness maths is deterministic. */
export const SAMPLE_NOW_MS = 1_760_000_000_000;

const DEGREE_CELSIUS = "°C";

function iso(offsetMs: number): string {
  return new Date(SAMPLE_NOW_MS + offsetMs).toISOString();
}

export interface FakeRegistry {
  entities: HaEntityRegistryEntry[];
  devices: HaDeviceRegistryEntry[];
  areas: HaAreaRegistryEntry[];
  floors: HaFloorRegistryEntry[];
  states: Map<string, HaState>;
}

interface EntitySeed {
  id: string;
  entity_id: string;
  platform: string;
  unique_id: string;
  device_id: string;
  config_entry_id: string;
  name?: string | null;
  original_name?: string | null;
  device_class?: string | null;
  unit?: string | null;
  entity_category?: string | null;
  state: string;
  attributes?: Record<string, unknown>;
  ageMs?: number;
}

function entity(seed: EntitySeed): { entry: HaEntityRegistryEntry; state: HaState } {
  const entry: HaEntityRegistryEntry = {
    entity_id: seed.entity_id,
    id: seed.id,
    unique_id: seed.unique_id,
    platform: seed.platform,
    config_entry_id: seed.config_entry_id,
    device_id: seed.device_id,
    area_id: null,
    disabled_by: null,
    hidden_by: null,
    entity_category: seed.entity_category ?? null,
    name: seed.name ?? null,
    original_name: seed.original_name ?? null,
    original_device_class: seed.device_class ?? null,
    has_entity_name: true,
    options: {},
  };
  const attributes: Record<string, unknown> = {
    friendly_name: seed.name ?? seed.original_name ?? seed.entity_id,
    ...(seed.device_class ? { device_class: seed.device_class } : {}),
    ...(seed.unit ? { unit_of_measurement: seed.unit } : {}),
    ...seed.attributes,
  };
  const at = iso(-(seed.ageMs ?? 60_000));
  return {
    entry,
    state: {
      entity_id: seed.entity_id,
      state: seed.state,
      attributes,
      last_changed: at,
      last_updated: at,
      last_reported: iso(-1_000),
      context: { id: `ctx_${seed.id}`, parent_id: null, user_id: null },
    },
  };
}

/** The registry the fake serves. Freshly built per call, so tests can mutate it freely. */
export function buildSampleRegistry(): FakeRegistry {
  const floors: HaFloorRegistryEntry[] = [
    { floor_id: "basement", name: "Basement", level: -1, icon: null, aliases: [] },
    { floor_id: "ground", name: "Ground floor", level: 0, icon: "mdi:home", aliases: [] },
    { floor_id: "first", name: "First floor", level: 1, icon: null, aliases: ["Upstairs"] },
  ];

  const areas: HaAreaRegistryEntry[] = [
    {
      area_id: "technical_room",
      name: "Technical room",
      floor_id: "basement",
      icon: "mdi:tools",
      aliases: ["Tekninen tila"],
    },
    { area_id: "kitchen", name: "Kitchen", floor_id: "ground", icon: null, aliases: [] },
    { area_id: "bedroom", name: "Bedroom", floor_id: "first", icon: "mdi:bed", aliases: [] },
  ];

  const devices: HaDeviceRegistryEntry[] = [
    {
      id: "dev_parmair",
      name: "Parmair MAC 120",
      name_by_user: "House ventilation",
      manufacturer: "Parmair",
      model: "MAC 120",
      model_id: "MAC-120",
      sw_version: "2.14",
      hw_version: "C",
      serial_number: "MAC120-000123",
      area_id: "technical_room",
      via_device_id: null,
      parent_device_id: null,
      identifiers: [["parmair", "mac120-000123"]],
      connections: [["mac", "aa:bb:cc:00:01:23"]],
      entry_type: null,
      disabled_by: null,
      // Both the deprecated list and the 2026.8+ fields, as a real 2026.9 instance sends.
      config_entries: ["cfg_parmair"],
      primary_config_entry: "cfg_parmair",
      config_entry_id: "cfg_parmair",
    },
    {
      // 2026.9 child device: no manufacturer/model/firmware fields at all.
      id: "dev_parmair_filter",
      name: "Parmair MAC 120 filter",
      parent_device_id: "dev_parmair",
      area_id: "technical_room",
      identifiers: [["parmair", "mac120-000123-filter"]],
      primary_config_entry: "cfg_parmair",
    },
    {
      id: "dev_zigbee_coordinator",
      name: "Zigbee2MQTT bridge",
      manufacturer: "Zigbee2MQTT",
      model: "Bridge",
      sw_version: "2.6.2",
      area_id: "technical_room",
      entry_type: "service",
      identifiers: [["mqtt", "zigbee2mqtt_bridge"]],
      primary_config_entry: "cfg_mqtt",
      config_entries: ["cfg_mqtt"],
    },
    {
      id: "dev_door_sensor",
      name: "MYGGBETT door/window sensor",
      name_by_user: "Bedroom door sensor",
      manufacturer: "IKEA of Sweden",
      model: "MYGGBETT door/window sensor",
      model_id: "E2013",
      sw_version: "1.0.32",
      area_id: "bedroom",
      via_device_id: "dev_zigbee_coordinator",
      identifiers: [["mqtt", "0x0c4314fffe12ab34"]],
      connections: [["zigbee", "0x0c4314fffe12ab34"]],
      primary_config_entry: "cfg_mqtt",
      config_entries: ["cfg_mqtt"],
    },
    {
      id: "dev_lucas_iphone",
      name: "Lucas iPhone",
      manufacturer: "Apple",
      model: "iPhone17,1",
      sw_version: "26.1",
      area_id: null,
      identifiers: [["mobile_app", "lucas_iphone"]],
      primary_config_entry: "cfg_mobile_lucas",
    },
    {
      id: "dev_marja_iphone",
      name: "Marja-Helena iPhone",
      manufacturer: "Apple",
      model: "iPhone15,4",
      sw_version: "26.1",
      area_id: null,
      identifiers: [["mobile_app", "marja_helenas_iphone"]],
      primary_config_entry: "cfg_mobile_marja",
    },
  ];

  const seeds: EntitySeed[] = [
    // ---- Parmair MAC 120 (ventilation) -------------------------------------------------
    {
      id: "reg_hrv_fan",
      entity_id: "fan.house_hrv",
      platform: "parmair",
      unique_id: "mac120_000123_fan",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Ventilation",
      state: "on",
      attributes: { percentage: 45, preset_mode: "home" },
    },
    {
      id: "reg_hrv_filter_state",
      entity_id: "binary_sensor.ventilation_filter_state",
      platform: "parmair",
      unique_id: "mac120_000123_filter_state",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Filter state",
      device_class: "problem",
      entity_category: "diagnostic",
      state: "off",
    },
    {
      id: "reg_hrv_supply_temp",
      entity_id: "sensor.ventilation_supply_air_temperature",
      platform: "parmair",
      unique_id: "mac120_000123_supply_temp",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Supply air temperature",
      device_class: "temperature",
      unit: DEGREE_CELSIUS,
      state: "20.4",
    },
    {
      id: "reg_hrv_extract_temp",
      entity_id: "sensor.ventilation_extract_air_temperature",
      platform: "parmair",
      unique_id: "mac120_000123_extract_temp",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Extract air temperature",
      device_class: "temperature",
      unit: DEGREE_CELSIUS,
      state: "21.8",
    },
    {
      id: "reg_hrv_exhaust_temp",
      entity_id: "sensor.ventilation_exhaust_air_temperature",
      platform: "parmair",
      unique_id: "mac120_000123_exhaust_temp",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Exhaust air temperature",
      device_class: "temperature",
      unit: DEGREE_CELSIUS,
      state: "3.1",
    },
    {
      id: "reg_hrv_outdoor_temp",
      entity_id: "sensor.ventilation_outdoor_air_temperature",
      platform: "parmair",
      unique_id: "mac120_000123_outdoor_temp",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Outdoor air temperature",
      device_class: "temperature",
      unit: DEGREE_CELSIUS,
      state: "-2.7",
    },
    {
      // Unit '%' but no battery device_class: must never become a battery candidate.
      id: "reg_hrv_supply_fan",
      entity_id: "sensor.ventilation_supply_fan_speed",
      platform: "parmair",
      unique_id: "mac120_000123_supply_fan",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Supply fan speed",
      unit: "%",
      state: "45",
    },
    {
      id: "reg_hrv_extract_fan",
      entity_id: "sensor.ventilation_extract_fan_speed",
      platform: "parmair",
      unique_id: "mac120_000123_extract_fan",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Extract fan speed",
      unit: "%",
      state: "47",
    },
    {
      id: "reg_hrv_efficiency",
      entity_id: "sensor.ventilation_heat_recovery_efficiency",
      platform: "parmair",
      unique_id: "mac120_000123_efficiency",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Heat recovery efficiency",
      unit: "%",
      state: "81",
    },
    {
      id: "reg_hrv_boost",
      entity_id: "switch.ventilation_boost",
      platform: "parmair",
      unique_id: "mac120_000123_boost",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Boost",
      state: "off",
    },
    {
      id: "reg_hrv_fan_level",
      entity_id: "number.ventilation_fan_level",
      platform: "parmair",
      unique_id: "mac120_000123_fan_level",
      device_id: "dev_parmair",
      config_entry_id: "cfg_parmair",
      original_name: "Fan level",
      state: "3",
    },
    {
      id: "reg_hrv_filter_days",
      entity_id: "sensor.ventilation_filter_remaining_days",
      platform: "parmair",
      unique_id: "mac120_000123_filter_days",
      device_id: "dev_parmair_filter",
      config_entry_id: "cfg_parmair",
      original_name: "Filter remaining days",
      unit: "d",
      state: "37",
    },
    // ---- IKEA MYGGBETT door sensor -----------------------------------------------------
    {
      id: "reg_door_contact",
      entity_id: "binary_sensor.bedroom_door_sensor_contact",
      platform: "mqtt",
      unique_id: "0x0c4314fffe12ab34_contact",
      device_id: "dev_door_sensor",
      config_entry_id: "cfg_mqtt",
      original_name: "Contact",
      device_class: "door",
      state: "off",
    },
    {
      id: "reg_door_battery",
      entity_id: "sensor.bedroom_door_sensor_battery",
      platform: "mqtt",
      unique_id: "0x0c4314fffe12ab34_battery",
      device_id: "dev_door_sensor",
      config_entry_id: "cfg_mqtt",
      original_name: "Battery",
      device_class: "battery",
      unit: "%",
      entity_category: "diagnostic",
      state: "68",
      ageMs: 30 * 60_000,
    },
    {
      id: "reg_door_battery_type",
      entity_id: "sensor.bedroom_door_sensor_battery_type",
      platform: "mqtt",
      unique_id: "0x0c4314fffe12ab34_battery_type",
      device_id: "dev_door_sensor",
      config_entry_id: "cfg_mqtt",
      original_name: "Battery type",
      device_class: "enum",
      entity_category: "diagnostic",
      state: "AAA",
      attributes: { options: ["AAA", "AA", "CR2032"] },
    },
    {
      id: "reg_door_battery_voltage",
      entity_id: "sensor.bedroom_door_sensor_battery_voltage",
      platform: "mqtt",
      unique_id: "0x0c4314fffe12ab34_battery_voltage",
      device_id: "dev_door_sensor",
      config_entry_id: "cfg_mqtt",
      original_name: "Battery voltage",
      device_class: "voltage",
      unit: "V",
      entity_category: "diagnostic",
      state: "2.9",
    },
    {
      id: "reg_door_linkquality",
      entity_id: "sensor.bedroom_door_sensor_linkquality",
      platform: "mqtt",
      unique_id: "0x0c4314fffe12ab34_linkquality",
      device_id: "dev_door_sensor",
      config_entry_id: "cfg_mqtt",
      original_name: "Linkquality",
      unit: "lqi",
      entity_category: "diagnostic",
      state: "132",
    },
    // ---- the two phones that own the notify targets ------------------------------------
    {
      id: "reg_lucas_battery_level",
      entity_id: "sensor.lucas_iphone_battery_level",
      platform: "mobile_app",
      unique_id: "lucas_iphone_battery_level",
      device_id: "dev_lucas_iphone",
      config_entry_id: "cfg_mobile_lucas",
      original_name: "Battery level",
      device_class: "battery",
      unit: "%",
      entity_category: "diagnostic",
      state: "82",
    },
    {
      id: "reg_lucas_battery_state",
      entity_id: "sensor.lucas_iphone_battery_state",
      platform: "mobile_app",
      unique_id: "lucas_iphone_battery_state",
      device_id: "dev_lucas_iphone",
      config_entry_id: "cfg_mobile_lucas",
      original_name: "Battery state",
      device_class: "enum",
      entity_category: "diagnostic",
      state: "Charging",
    },
    {
      id: "reg_marja_battery_level",
      entity_id: "sensor.marja_helenas_iphone_battery_level",
      platform: "mobile_app",
      unique_id: "marja_helenas_iphone_battery_level",
      device_id: "dev_marja_iphone",
      config_entry_id: "cfg_mobile_marja",
      original_name: "Battery level",
      device_class: "battery",
      unit: "%",
      entity_category: "diagnostic",
      state: "41",
    },
    {
      id: "reg_marja_battery_state",
      entity_id: "sensor.marja_helenas_iphone_battery_state",
      platform: "mobile_app",
      unique_id: "marja_helenas_iphone_battery_state",
      device_id: "dev_marja_iphone",
      config_entry_id: "cfg_mobile_marja",
      original_name: "Battery state",
      device_class: "enum",
      entity_category: "diagnostic",
      state: "Not Charging",
    },
  ];

  const entities: HaEntityRegistryEntry[] = [];
  const states = new Map<string, HaState>();
  for (const seed of seeds) {
    const built = entity(seed);
    entities.push(built.entry);
    states.set(built.state.entity_id, built.state);
  }

  return { entities, devices, areas, floors, states };
}

/** The two notify services the real instance exposes. */
export const SAMPLE_NOTIFY_SERVICES: readonly string[] = [
  "notify.mobile_app_lucas_iphone",
  "notify.mobile_app_marja_helenas_iphone",
];

/* --------------------------------------------------------------- fake server */

export interface RecordedServiceCall {
  id: number;
  domain: string;
  service: string;
  serviceData: Record<string, unknown> | undefined;
  target: Record<string, unknown> | undefined;
  returnResponse: unknown;
}

export interface FakeHaOptions {
  token?: string;
  haVersion?: string;
}

interface FakeClient {
  socket: WebSocket;
  authenticated: boolean;
  /** subscription id -> event_type (null means "all events"). */
  subscriptions: Map<number, string | null>;
}

const DEFAULT_TOKEN = "fake-ha-long-lived-access-token";

export class FakeHa {
  readonly registry: FakeRegistry = buildSampleRegistry();
  readonly serviceCalls: RecordedServiceCall[] = [];
  readonly notifyServices: readonly string[] = SAMPLE_NOTIFY_SERVICES;
  readonly haVersion: string;

  #token: string;
  #wss: WebSocketServer;
  #clients = new Set<FakeClient>();
  #commandCounts = new Map<string, number>();
  #stalled = new Set<string>();
  #pongEnabled = true;
  #callServiceError: { code: string; message: string } | null = null;
  #connectionCount = 0;
  #contextSeq = 0;

  private constructor(wss: WebSocketServer, token: string, haVersion: string) {
    this.#wss = wss;
    this.#token = token;
    this.haVersion = haVersion;
    wss.on("connection", (socket) => {
      this.#onConnection(socket);
    });
  }

  /** Listen on an ephemeral port at `/api/websocket`. */
  static async start(options: FakeHaOptions = {}): Promise<FakeHa> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/api/websocket" });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", () => {
        resolve();
      });
      wss.once("error", reject);
    });
    return new FakeHa(wss, options.token ?? DEFAULT_TOKEN, options.haVersion ?? "2026.9.1");
  }

  get url(): string {
    const address = this.#wss.address();
    if (typeof address === "string" || address === null) {
      throw new Error("fake ha server is not listening on a TCP port");
    }
    return `ws://127.0.0.1:${address.port}/api/websocket`;
  }

  /** The token a client must present when the fake is configured with defaults. */
  get token(): string {
    return DEFAULT_TOKEN;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Connections accepted since start - the "no tight reconnect loop" assertion. */
  get connectionCount(): number {
    return this.#connectionCount;
  }

  commandCount(type: string): number {
    return this.#commandCounts.get(type) ?? 0;
  }

  /** `true` restores the default token; `false` makes every auth attempt fail. */
  setToken(valid: string | boolean): void {
    this.#token = valid === true ? DEFAULT_TOKEN : valid === false ? " never-matches" : valid;
  }

  /** Stop answering `ping`, to drive the heartbeat into `degraded`. */
  setPongEnabled(enabled: boolean): void {
    this.#pongEnabled = enabled;
  }

  /** Make `call_service` answer `{success:false}`. */
  setCallServiceError(error: { code: string; message: string } | null): void {
    this.#callServiceError = error;
  }

  /** Accept a command type but never answer it, so the caller's promise stays pending. */
  setStalled(commandType: string, stalled: boolean): void {
    if (stalled) this.#stalled.add(commandType);
    else this.#stalled.delete(commandType);
  }

  /** Deliver one event to every matching subscription of every authenticated client. */
  emitEvent(eventType: string, data: unknown): void {
    this.#contextSeq += 1;
    const frame = {
      type: "event" as const,
      event: {
        event_type: eventType,
        data,
        origin: "LOCAL",
        time_fired: new Date().toISOString(),
        context: { id: `ctx_ev_${this.#contextSeq}`, parent_id: null, user_id: null },
      },
    };
    for (const client of this.#clients) {
      if (!client.authenticated) continue;
      for (const [subscriptionId, subscribedType] of client.subscriptions) {
        if (subscribedType === null || subscribedType === eventType) {
          this.#send(client.socket, { id: subscriptionId, ...frame });
        }
      }
    }
  }

  /** Update the in-memory state store and fire the matching `state_changed`. */
  emitStateChanged(entityId: string, newState: string | null, oldState?: string | null): void {
    const previous = this.registry.states.get(entityId) ?? null;
    const at = new Date().toISOString();
    const old: HaState | null =
      oldState === undefined
        ? previous
        : oldState === null
          ? null
          : {
              entity_id: entityId,
              state: oldState,
              attributes: previous?.attributes ?? {},
              last_changed: previous?.last_changed ?? at,
              last_updated: previous?.last_updated ?? at,
            };
    let next: HaState | null = null;
    if (newState !== null) {
      this.#contextSeq += 1;
      next = {
        entity_id: entityId,
        state: newState,
        attributes: previous?.attributes ?? {},
        last_changed: at,
        last_updated: at,
        last_reported: at,
        context: { id: `ctx_sc_${this.#contextSeq}`, parent_id: null, user_id: null },
      };
      this.registry.states.set(entityId, next);
    } else {
      this.registry.states.delete(entityId);
    }
    this.emitEvent("state_changed", { entity_id: entityId, new_state: next, old_state: old });
  }

  /**
   * Rename an entity in the registry and emit `entity_registry_updated` with a **deliberately
   * stale** `changes` payload - HA reports the *old* values there (core #134613, #152288).
   * A client that applies the payload gets the pre-rename entity_id; a client that re-lists is
   * correct. That is the whole point of the test.
   */
  renameEntity(registryId: string, newEntityId: string): void {
    const entry = this.registry.entities.find((candidate) => candidate.id === registryId);
    if (!entry) throw new Error(`fake ha: no entity registry entry ${registryId}`);
    const oldEntityId = entry.entity_id;
    entry.entity_id = newEntityId;
    const state = this.registry.states.get(oldEntityId);
    if (state) {
      this.registry.states.delete(oldEntityId);
      this.registry.states.set(newEntityId, { ...state, entity_id: newEntityId });
    }
    this.emitEvent("entity_registry_updated", {
      action: "update",
      entity_id: oldEntityId,
      changes: { entity_id: oldEntityId, original_name: entry.original_name },
    });
  }

  /** Kill every connection without a close handshake (the half-open-socket scenario). */
  dropAllClients(): void {
    for (const client of [...this.#clients]) {
      this.#clients.delete(client);
      client.socket.terminate();
    }
  }

  async close(): Promise<void> {
    this.dropAllClients();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => {
        resolve();
      });
    });
  }

  /* ------------------------------------------------------------- internals */

  #onConnection(socket: WebSocket): void {
    this.#connectionCount += 1;
    const client: FakeClient = { socket, authenticated: false, subscriptions: new Map() };
    this.#clients.add(client);
    socket.on("close", () => {
      this.#clients.delete(client);
    });
    socket.on("error", () => {
      this.#clients.delete(client);
    });
    socket.on("message", (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString()) as unknown;
      } catch {
        return;
      }
      this.#onCommand(client, message);
    });
    this.#send(socket, { type: "auth_required", ha_version: this.haVersion });
  }

  #onCommand(client: FakeClient, message: unknown): void {
    if (!message || typeof message !== "object") return;
    const command = message as Record<string, unknown>;
    const type = typeof command.type === "string" ? command.type : "";
    this.#commandCounts.set(type, (this.#commandCounts.get(type) ?? 0) + 1);

    if (!client.authenticated) {
      if (type !== "auth") return;
      if (command.access_token === this.#token) {
        client.authenticated = true;
        this.#send(client.socket, { type: "auth_ok", ha_version: this.haVersion });
      } else {
        this.#send(client.socket, {
          type: "auth_invalid",
          message: "Invalid access token or password",
        });
        client.socket.close(1000, "auth_invalid");
      }
      return;
    }

    const id = typeof command.id === "number" ? command.id : 0;
    if (this.#stalled.has(type)) return; // accepted, never answered

    switch (type) {
      case "ping": {
        if (this.#pongEnabled) this.#send(client.socket, { id, type: "pong" });
        return;
      }
      case "subscribe_events": {
        const eventType = typeof command.event_type === "string" ? command.event_type : null;
        client.subscriptions.set(id, eventType);
        this.#ok(client, id, null);
        return;
      }
      case "unsubscribe_events": {
        const subscription = typeof command.subscription === "number" ? command.subscription : -1;
        const existed = client.subscriptions.delete(subscription);
        if (existed) this.#ok(client, id, null);
        else this.#error(client, id, "not_found", "Subscription not found.");
        return;
      }
      case "get_states": {
        this.#ok(client, id, [...this.registry.states.values()]);
        return;
      }
      case "config/entity_registry/list": {
        this.#ok(client, id, this.registry.entities);
        return;
      }
      case "config/device_registry/list": {
        this.#ok(client, id, this.registry.devices);
        return;
      }
      case "config/area_registry/list": {
        this.#ok(client, id, this.registry.areas);
        return;
      }
      case "config/floor_registry/list": {
        this.#ok(client, id, this.registry.floors);
        return;
      }
      case "call_service": {
        this.serviceCalls.push({
          id,
          domain: String(command.domain ?? ""),
          service: String(command.service ?? ""),
          serviceData: (command.service_data as Record<string, unknown> | undefined) ?? undefined,
          target: (command.target as Record<string, unknown> | undefined) ?? undefined,
          returnResponse: command.return_response,
        });
        if (this.#callServiceError) {
          this.#error(client, id, this.#callServiceError.code, this.#callServiceError.message);
          return;
        }
        this.#contextSeq += 1;
        this.#ok(client, id, {
          context: { id: `ctx_svc_${this.#contextSeq}`, parent_id: null, user_id: "ha_user_1" },
        });
        return;
      }
      default: {
        this.#error(client, id, "unknown_command", `Unknown command: ${type}`);
        return;
      }
    }
  }

  #ok(client: FakeClient, id: number, result: unknown): void {
    this.#send(client.socket, { id, type: "result", success: true, result });
  }

  #error(client: FakeClient, id: number, code: string, message: string): void {
    this.#send(client.socket, { id, type: "result", success: false, error: { code, message } });
  }

  #send(socket: WebSocket, payload: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(payload));
  }
}

/* --------------------------------------------------------------- test utils */

/**
 * Resolve when `subscribe` calls back, with a real-time guard so a hung expectation fails fast
 * instead of eating the suite timeout. `subscribe` must return its own teardown.
 */
export function waitFor<T>(
  subscribe: (resolve: (value: T) => void) => () => void,
  what: string,
  timeoutMs = 4_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const teardown = (): void => {
      settled = true;
      if (unsubscribe) unsubscribe();
    };
    const timer = globalThis.setTimeout(() => {
      teardown();
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
    }, timeoutMs);
    const registered = subscribe((value) => {
      globalThis.clearTimeout(timer);
      teardown();
      resolve(value);
    });
    unsubscribe = registered;
    // `subscribe` may have resolved synchronously, before `unsubscribe` was assigned.
    if (settled) registered();
  });
}

/** Let queued microtasks and a few macrotask turns run. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      globalThis.setImmediate(resolve);
    });
  }
}
