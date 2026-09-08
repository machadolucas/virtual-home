/**
 * The Home Assistant WebSocket client. The **worker alone** owns this and the token
 * (docs/design-notes/auth-security-operations.md §8.1).
 *
 * State machine (§8.2):
 *
 *   disconnected -> connecting -> authenticating -> syncing -> subscribed
 *                       |              |               |          |
 *                       |              | auth_invalid  |          | 2 missed pongs
 *                       |              v               |          v
 *                       |          auth_failed         |       degraded
 *                       |         (>= 5 min floor)     |          |
 *                       +--------------> backoff <-----+----------+
 *                                          | full-jitter delay
 *                                          +-> connecting
 *
 * Everything time- or randomness-dependent is injected (`deps`), so tests drive the whole machine
 * with a manual clock and a deterministic `random()`; see tests/helpers/fakeHa.ts.
 *
 * No database access here on purpose: the socket emits typed events and the persistence layer
 * subscribes. That keeps this file testable without a schema and keeps HA parsing out of SQL.
 */
import { EventEmitter } from "node:events";
import { WebSocket as NodeWebSocket } from "ws";
import { log } from "@/server/log";
import {
  HA_DEFAULT_EVENT_TYPES,
  HA_REGISTRY_EVENT,
  HaAreaRegistryEntrySchema,
  HaDeviceRegistryEntrySchema,
  HaEntityRegistryEntrySchema,
  HaFloorRegistryEntrySchema,
  HaStateChangedDataSchema,
  HaStateSchema,
  authCommand,
  callServiceCommand,
  getStatesCommand,
  parseIncomingMessage,
  parseListLenient,
  pingCommand,
  registryListCommand,
  subscribeEventsCommand,
  unsubscribeEventsCommand,
  type HaAreaRegistryEntry,
  type HaCommand,
  type HaCommandBody,
  type HaContext,
  type HaDeviceRegistryEntry,
  type HaEntityRegistryEntry,
  type HaEvent,
  type HaFloorRegistryEntry,
  type HaRegistryName,
  type HaServiceTarget,
  type HaState,
  type HaStateChangedData,
} from "./protocol";
import { errorText, redactSecrets } from "./redact";

/* ------------------------------------------------------------------ errors */

/** Thrown/rejected when the connection is gone: every pending command fails with this. */
export class HaDisconnectedError extends Error {
  constructor(message = "home assistant connection lost") {
    super(message);
    this.name = "HaDisconnectedError";
  }
}

/** A command got no `result` frame within `commandTimeoutMs`. */
export class HaCommandTimeoutError extends Error {
  constructor(
    readonly commandType: string,
    timeoutMs: number,
  ) {
    super(`home assistant command ${commandType} timed out after ${timeoutMs} ms`);
    this.name = "HaCommandTimeoutError";
  }
}

/** HA answered `{"success": false}`. */
export class HaCommandError extends Error {
  constructor(
    readonly commandType: string,
    readonly code: string,
    message: string,
  ) {
    super(`home assistant rejected ${commandType} (${code}): ${message}`);
    this.name = "HaCommandError";
  }
}

/** The token was rejected. Never carries the token itself. */
export class HaAuthFailedError extends Error {
  constructor(message = "invalid access token") {
    super(message);
    this.name = "HaAuthFailedError";
  }
}

/* -------------------------------------------------------- injected surfaces */

/** Opaque timer handle: whatever the injected `setTimeout` returns. */
export type HaTimerHandle = unknown;

/** The slice of `ws`'s WebSocket the socket actually uses. */
export interface HaWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  removeAllListeners(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: unknown) => void): unknown;
}

export type HaWebSocketCtor = new (url: string, options?: unknown) => HaWebSocketLike;

export interface HaLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface HaSocketDeps {
  WebSocketImpl: HaWebSocketCtor;
  setTimeout: (callback: () => void, ms: number) => HaTimerHandle;
  clearTimeout: (handle: HaTimerHandle) => void;
  now: () => number;
  random: () => number;
  logger: HaLogger;
}

/* ------------------------------------------------------------------- types */

export type HaConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "syncing"
  | "subscribed"
  | "degraded"
  | "backoff"
  | "auth_failed";

/** Payload of the `'state'` event and of `HaSocket.status`. */
export interface HaStatus {
  state: HaConnectionState;
  haVersion?: string;
  /** Redacted, human-readable. Safe to persist in `integration_status.last_error`. */
  error?: string;
  /** Only on `backoff` / `auth_failed`: milliseconds until the next connect attempt. */
  retryInMs?: number;
  /** 1-based attempt counter of the *next* connect. */
  attempt?: number;
  at: number;
}

/** One full re-snapshot. Emitted on every (re)connect, before `subscribed`. */
export interface HaSnapshot {
  at: number;
  haVersion: string | null;
  states: HaState[];
  entities: HaEntityRegistryEntry[];
  devices: HaDeviceRegistryEntry[];
  areas: HaAreaRegistryEntry[];
  floors: HaFloorRegistryEntry[];
  /** Records HA sent that failed even the lenient schema. Non-zero means: look at the HA release notes. */
  skipped: Record<"states" | "entities" | "devices" | "areas" | "floors", number>;
}

export interface HaRegistryLists {
  entities: HaEntityRegistryEntry[];
  devices: HaDeviceRegistryEntry[];
  areas: HaAreaRegistryEntry[];
  floors: HaFloorRegistryEntry[];
  skipped: Record<"entities" | "devices" | "areas" | "floors", number>;
}

/** Payload of `'registry'`: a freshly re-listed registry after a `*_registry_updated` signal. */
export type HaRegistryRefresh =
  | { registry: "entity"; records: HaEntityRegistryEntry[]; skipped: number; at: number }
  | { registry: "device"; records: HaDeviceRegistryEntry[]; skipped: number; at: number }
  | { registry: "area"; records: HaAreaRegistryEntry[]; skipped: number; at: number }
  | { registry: "floor"; records: HaFloorRegistryEntry[]; skipped: number; at: number };

export interface HaCallServiceResult {
  context?: HaContext | null;
}

export type HaEventHandler = (event: HaEvent) => void;
export type Unsubscribe = () => void;

export interface HaSocketEventMap {
  /** Status transitions. */
  state: [HaStatus];
  /** A complete states + registries snapshot, once per successful (re)connect. */
  snapshot: [HaSnapshot];
  /** Raw `state_changed` event data. */
  state_changed: [HaStateChangedData];
  /** Every event from every active subscription. */
  event: [HaEvent];
  /** A `*_registry_updated` signal arrived. Cache-invalidation only — the payload is NOT applied. */
  registry_updated: [{ registry: HaRegistryName; at: number }];
  /** The debounced re-list that follows a `registry_updated` signal. */
  registry: [HaRegistryRefresh];
  /** Only emitted when a listener exists, so an unhandled 'error' can never kill the worker. */
  error: [Error];
}

export interface HaSocketOptions {
  url: string;
  token: string;
  /** Connect + authenticate budget. Default 10 s (§8.2). */
  handshakeTimeoutMs?: number;
  /** Per-command reply budget. Default 30 s. */
  commandTimeoutMs?: number;
  /** Heartbeat period. Default 30 s. */
  pingIntervalMs?: number;
  /** Pong budget per ping. Default 10 s. */
  pongTimeoutMs?: number;
  /** Consecutive misses before `degraded`. Default 2. */
  maxMissedPongs?: number;
  /** Full-jitter backoff base / cap. Defaults 1 s / 60 s. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Floor applied after `auth_invalid`. Default 5 min. */
  authFailedFloorMs?: number;
  /** Coalescing window for `*_registry_updated` signals. Default 2 s. */
  registryDebounceMs?: number;
  /** Always-on subscriptions. Defaults to HA_DEFAULT_EVENT_TYPES. */
  eventTypes?: readonly string[];
  deps?: Partial<HaSocketDeps>;
}

interface PendingCommand {
  commandType: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: HaTimerHandle;
}

interface SubscriptionEntry {
  handlers: Set<HaEventHandler>;
  /** HA subscription id == the id of the `subscribe_events` command. Null while not subscribed. */
  subscriptionId: number | null;
  /** True while a `subscribe_events` for this type is in flight, so we never subscribe twice. */
  subscribing: boolean;
  /** True for the always-on subscriptions, which are never torn down. */
  permanent: boolean;
}

/* ------------------------------------------------------------------ helpers */

const defaultDeps: HaSocketDeps = {
  WebSocketImpl: NodeWebSocket as unknown as HaWebSocketCtor,
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
  now: () => Date.now(),
  random: () => Math.random(),
  // Replaced lazily in the constructor so importing this module never touches the logger/env.
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

/** ws delivers strings, Buffers, Buffer[] or ArrayBuffers depending on negotiation. */
function frameToText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return data.map(frameToText).join("");
  return String(data);
}

/* ------------------------------------------------------------------- class */

export class HaSocket extends EventEmitter<HaSocketEventMap> {
  readonly #url: string;
  readonly #token: string;
  readonly #handshakeTimeoutMs: number;
  readonly #commandTimeoutMs: number;
  readonly #pingIntervalMs: number;
  readonly #pongTimeoutMs: number;
  readonly #maxMissedPongs: number;
  readonly #backoffBaseMs: number;
  readonly #backoffCapMs: number;
  readonly #authFailedFloorMs: number;
  readonly #registryDebounceMs: number;
  readonly #deps: HaSocketDeps;

  #status: HaStatus;
  #ws: HaWebSocketLike | null = null;
  #stopped = true;
  /** Bumped on every connect and every teardown; async callbacks bail when theirs is stale. */
  #generation = 0;
  #authenticated = false;
  #authFailed = false;
  #haVersion: string | null = null;
  #attempt = 0;
  #reconnectCount = 0;

  /** Per-connection monotonic command id, reset to 1 on every socket. */
  #nextId = 1;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #subscriptions = new Map<string, SubscriptionEntry>();
  readonly #subscriptionType = new Map<number, string>();
  readonly #registryTimers = new Map<HaRegistryName, HaTimerHandle>();

  #handshakeTimer: HaTimerHandle = null;
  #pingTimer: HaTimerHandle = null;
  #pongTimer: HaTimerHandle = null;
  #reconnectTimer: HaTimerHandle = null;
  #pingId: number | null = null;
  #missedPongs = 0;

  #logger: HaLogger | null = null;

  constructor(options: HaSocketOptions) {
    super();
    this.#url = options.url;
    this.#token = options.token;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.#pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.#pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.#maxMissedPongs = options.maxMissedPongs ?? 2;
    this.#backoffBaseMs = options.backoffBaseMs ?? 1_000;
    this.#backoffCapMs = options.backoffCapMs ?? 60_000;
    this.#authFailedFloorMs = options.authFailedFloorMs ?? 300_000;
    this.#registryDebounceMs = options.registryDebounceMs ?? 2_000;
    this.#deps = { ...defaultDeps, ...options.deps };
    if (options.deps?.logger) this.#logger = options.deps.logger;
    this.#status = { state: "disconnected", at: this.#deps.now() };
    for (const eventType of options.eventTypes ?? HA_DEFAULT_EVENT_TYPES) {
      this.#subscriptions.set(eventType, {
        handlers: new Set(),
        subscriptionId: null,
        subscribing: false,
        permanent: true,
      });
    }
  }

  /* ------------------------------------------------------------- accessors */

  get state(): HaConnectionState {
    return this.#status.state;
  }

  get status(): HaStatus {
    return { ...this.#status };
  }

  get haVersion(): string | null {
    return this.#haVersion;
  }

  /** How many times we re-entered `connecting` after the first connect. For `integration_status`. */
  get reconnectCount(): number {
    return this.#reconnectCount;
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Idempotent. Starts (or resumes) the connect/backoff loop. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#connect();
  }

  /**
   * Idempotent. Cancels backoff, terminates the socket and rejects every pending command.
   * `terminate()` rather than `close()`: a half-open TCP socket would otherwise keep the
   * process alive for minutes (§8.2).
   */
  stop(): void {
    this.#stopped = true;
    this.#teardown();
    this.#setState("disconnected");
  }

  /* -------------------------------------------------------------- commands */

  /** Send a command and await its `result`. Rejects with HaDisconnectedError when not connected. */
  async send<T = unknown>(command: HaCommandBody): Promise<T> {
    return (await this.#dispatch(command).promise) as T;
  }

  async getStates(): Promise<HaState[]> {
    const raw = await this.send(getStatesCommand());
    return parseListLenient(HaStateSchema, raw).records;
  }

  /** All four registries in parallel. Used by the sync phase and by callers that want a re-read. */
  async listRegistries(): Promise<HaRegistryLists> {
    const [entitiesRaw, devicesRaw, areasRaw, floorsRaw] = await Promise.all([
      this.send(registryListCommand("entity")),
      this.send(registryListCommand("device")),
      this.send(registryListCommand("area")),
      this.send(registryListCommand("floor")),
    ]);
    const entities = parseListLenient(HaEntityRegistryEntrySchema, entitiesRaw);
    const devices = parseListLenient(HaDeviceRegistryEntrySchema, devicesRaw);
    const areas = parseListLenient(HaAreaRegistryEntrySchema, areasRaw);
    const floors = parseListLenient(HaFloorRegistryEntrySchema, floorsRaw);
    return {
      entities: entities.records,
      devices: devices.records,
      areas: areas.records,
      floors: floors.records,
      skipped: {
        entities: entities.skipped,
        devices: devices.skipped,
        areas: areas.skipped,
        floors: floors.skipped,
      },
    };
  }

  /** `call_service` with `return_response: false`. */
  async callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: HaServiceTarget,
  ): Promise<HaCallServiceResult> {
    const result = await this.send<unknown>(
      callServiceCommand(domain, service, serviceData, target),
    );
    if (result && typeof result === "object" && "context" in result) {
      return { context: (result as { context?: HaContext | null }).context ?? null };
    }
    return {};
  }

  /**
   * Register a handler for one HA event type. The socket keeps a single HA subscription per event
   * type no matter how many handlers there are, and re-establishes all of them after a reconnect
   * (subscription ids never survive a new socket, §8.3).
   */
  subscribeEvents(eventType: string, handler: HaEventHandler): Unsubscribe {
    let entry = this.#subscriptions.get(eventType);
    if (!entry) {
      entry = { handlers: new Set(), subscriptionId: null, subscribing: false, permanent: false };
      this.#subscriptions.set(eventType, entry);
    }
    entry.handlers.add(handler);
    if (this.#authenticated && entry.subscriptionId === null && !entry.subscribing) {
      this.#subscribeOne(eventType, entry, this.#generation).catch((err: unknown) => {
        this.#log.warn(
          { eventType, error: this.#redact(errorText(err)) },
          "ha subscribe_events failed",
        );
      });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const current = this.#subscriptions.get(eventType);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size > 0 || current.permanent) return;
      const subscriptionId = current.subscriptionId;
      this.#subscriptions.delete(eventType);
      if (subscriptionId !== null) {
        this.#subscriptionType.delete(subscriptionId);
        if (this.#authenticated) {
          this.send(unsubscribeEventsCommand(subscriptionId)).catch(() => {
            /* the socket is gone; HA drops the subscription with it */
          });
        }
      }
    };
  }

  /* ------------------------------------------------------------- internals */

  get #log(): HaLogger {
    if (!this.#logger) this.#logger = log.child({ component: "ha" }) as unknown as HaLogger;
    return this.#logger;
  }

  #redact(text: string): string {
    return redactSecrets(text, this.#token);
  }

  #setState(state: HaConnectionState, extra?: Omit<HaStatus, "state" | "at">): void {
    this.#status = {
      state,
      at: this.#deps.now(),
      ...(this.#haVersion ? { haVersion: this.#haVersion } : {}),
      ...extra,
    };
    this.emit("state", { ...this.#status });
  }

  #emitError(err: Error): void {
    // Never emit 'error' unconditionally: an unhandled EventEmitter 'error' would take the
    // worker process down, and a flaky HA connection is not a reason to die.
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  #connect(): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#nextId = 1;
    this.#missedPongs = 0;
    this.#pingId = null;
    this.#haVersion = null;
    this.#setState("connecting", { attempt: this.#attempt + 1 });

    let ws: HaWebSocketLike;
    try {
      ws = new this.#deps.WebSocketImpl(this.#url, {
        handshakeTimeout: this.#handshakeTimeoutMs,
      });
    } catch (err) {
      this.#fail(generation, `websocket construction failed: ${errorText(err)}`);
      return;
    }
    this.#ws = ws;

    this.#handshakeTimer = this.#deps.setTimeout(() => {
      this.#handshakeTimer = null;
      this.#fail(generation, `handshake timed out after ${this.#handshakeTimeoutMs} ms`);
    }, this.#handshakeTimeoutMs);

    ws.on("open", () => {
      // Nothing to do: HA speaks first with auth_required.
      this.#log.debug({ state: this.state }, "ha websocket open");
    });
    ws.on("message", (data: unknown) => {
      this.#onMessage(generation, data);
    });
    ws.on("error", (err: Error) => {
      this.#fail(generation, `websocket error: ${errorText(err)}`);
    });
    ws.on("close", (code: number) => {
      this.#fail(generation, `websocket closed (code ${code})`);
    });
  }

  #onMessage(generation: number, data: unknown): void {
    if (generation !== this.#generation) return;
    let json: unknown;
    try {
      json = JSON.parse(frameToText(data)) as unknown;
    } catch {
      this.#log.warn({}, "ignored unparseable ha frame");
      return;
    }
    const message = parseIncomingMessage(json);
    if (!message) return; // A frame type we do not model. HA adds them; ignoring is correct.

    switch (message.type) {
      case "auth_required": {
        this.#setState("authenticating");
        this.#sendRaw(authCommand(this.#token));
        return;
      }
      case "auth_ok": {
        this.#onAuthOk(generation, message.ha_version ?? null);
        return;
      }
      case "auth_invalid": {
        this.#authFailed = true;
        this.#log.error(
          { message: this.#redact(message.message ?? "invalid access token") },
          "home assistant rejected HA_TOKEN — rotate the token (see docs/home-assistant.md)",
        );
        this.#emitError(new HaAuthFailedError());
        this.#fail(generation, "invalid access token");
        return;
      }
      case "result": {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        this.#deps.clearTimeout(pending.timer);
        if (message.success) {
          pending.resolve(message.result);
        } else {
          pending.reject(
            new HaCommandError(
              pending.commandType,
              String(message.error?.code ?? "unknown"),
              this.#redact(message.error?.message ?? "command failed"),
            ),
          );
        }
        return;
      }
      case "pong": {
        if (this.#pingId !== null && message.id === this.#pingId) this.#onPong();
        return;
      }
      case "event": {
        this.#onEvent(message.event);
        return;
      }
    }
  }

  #onAuthOk(generation: number, haVersion: string | null): void {
    if (this.#handshakeTimer !== null) {
      this.#deps.clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
    }
    this.#authenticated = true;
    this.#authFailed = false;
    this.#haVersion = haVersion;
    this.#setState("syncing");
    this.#scheduleNextPing();
    void this.#sync(generation);
  }

  /**
   * Full re-snapshot, then (re)subscribe. Ordered per §8.3: `state_changed` only describes the
   * future, so a reconnect must always re-read `get_states` — skipping it is the classic
   * "the app shows yesterday's state after a network blip" bug. Consumers apply the snapshot
   * first and can compare `last_updated` before overwriting a newer live value.
   */
  async #sync(generation: number): Promise<void> {
    try {
      const [statesRaw, entitiesRaw, devicesRaw, areasRaw, floorsRaw] = await Promise.all([
        this.send(getStatesCommand()),
        this.send(registryListCommand("entity")),
        this.send(registryListCommand("device")),
        this.send(registryListCommand("area")),
        this.send(registryListCommand("floor")),
      ]);
      if (generation !== this.#generation) return;

      const states = parseListLenient(HaStateSchema, statesRaw);
      const entities = parseListLenient(HaEntityRegistryEntrySchema, entitiesRaw);
      const devices = parseListLenient(HaDeviceRegistryEntrySchema, devicesRaw);
      const areas = parseListLenient(HaAreaRegistryEntrySchema, areasRaw);
      const floors = parseListLenient(HaFloorRegistryEntrySchema, floorsRaw);

      this.emit("snapshot", {
        at: this.#deps.now(),
        haVersion: this.#haVersion,
        states: states.records,
        entities: entities.records,
        devices: devices.records,
        areas: areas.records,
        floors: floors.records,
        skipped: {
          states: states.skipped,
          entities: entities.skipped,
          devices: devices.skipped,
          areas: areas.skipped,
          floors: floors.skipped,
        },
      });

      await this.#subscribeAll(generation);
      if (generation !== this.#generation) return;
      this.#attempt = 0;
      this.#setState("subscribed");
      this.#log.info(
        {
          haVersion: this.#haVersion,
          entities: entities.records.length,
          devices: devices.records.length,
        },
        "ha snapshot complete",
      );
    } catch (err) {
      if (generation !== this.#generation) return;
      this.#fail(generation, `snapshot failed: ${errorText(err)}`);
    }
  }

  async #subscribeAll(generation: number): Promise<void> {
    const work: Promise<void>[] = [];
    for (const [eventType, entry] of this.#subscriptions) {
      if (entry.subscriptionId === null && !entry.subscribing) {
        work.push(this.#subscribeOne(eventType, entry, generation));
      }
    }
    await Promise.all(work);
  }

  async #subscribeOne(
    eventType: string,
    entry: SubscriptionEntry,
    generation: number,
  ): Promise<void> {
    entry.subscribing = true;
    try {
      const { id, promise } = this.#dispatch(subscribeEventsCommand(eventType));
      await promise;
      if (generation !== this.#generation) return;
      if (!this.#subscriptions.has(eventType)) return; // unsubscribed while in flight
      entry.subscriptionId = id;
      this.#subscriptionType.set(id, eventType);
    } finally {
      entry.subscribing = false;
    }
  }

  #onEvent(event: HaEvent): void {
    this.emit("event", event);

    const entry = this.#subscriptions.get(event.event_type);
    if (entry) {
      for (const handler of [...entry.handlers]) {
        try {
          handler(event);
        } catch (err) {
          this.#log.warn(
            { eventType: event.event_type, error: this.#redact(errorText(err)) },
            "ha event handler threw",
          );
        }
      }
    }

    if (event.event_type === "state_changed") {
      const parsed = HaStateChangedDataSchema.safeParse(event.data);
      if (parsed.success) this.emit("state_changed", parsed.data);
      return;
    }

    const registry = HA_REGISTRY_EVENT[event.event_type];
    if (registry) {
      // Cache-invalidation signal ONLY. `event.data.changes` reports the *old* values
      // (HA core #134613, #152288), so applying it would corrupt the cache. The HA frontend
      // itself responds with a full list refresh; we do the same, debounced (§8.4).
      this.emit("registry_updated", { registry, at: this.#deps.now() });
      this.#scheduleRegistryRefresh(registry);
    }
  }

  #scheduleRegistryRefresh(registry: HaRegistryName): void {
    const existing = this.#registryTimers.get(registry);
    if (existing !== undefined) this.#deps.clearTimeout(existing);
    const generation = this.#generation;
    this.#registryTimers.set(
      registry,
      this.#deps.setTimeout(() => {
        this.#registryTimers.delete(registry);
        void this.#refreshRegistry(registry, generation);
      }, this.#registryDebounceMs),
    );
  }

  async #refreshRegistry(registry: HaRegistryName, generation: number): Promise<void> {
    if (generation !== this.#generation || !this.#authenticated) return;
    try {
      const raw = await this.send(registryListCommand(registry));
      if (generation !== this.#generation) return;
      const at = this.#deps.now();
      switch (registry) {
        case "entity": {
          const parsed = parseListLenient(HaEntityRegistryEntrySchema, raw);
          this.emit("registry", {
            registry,
            records: parsed.records,
            skipped: parsed.skipped,
            at,
          });
          return;
        }
        case "device": {
          const parsed = parseListLenient(HaDeviceRegistryEntrySchema, raw);
          this.emit("registry", { registry, records: parsed.records, skipped: parsed.skipped, at });
          return;
        }
        case "area": {
          const parsed = parseListLenient(HaAreaRegistryEntrySchema, raw);
          this.emit("registry", { registry, records: parsed.records, skipped: parsed.skipped, at });
          return;
        }
        case "floor": {
          const parsed = parseListLenient(HaFloorRegistryEntrySchema, raw);
          this.emit("registry", { registry, records: parsed.records, skipped: parsed.skipped, at });
          return;
        }
      }
    } catch (err) {
      this.#log.warn(
        { registry, error: this.#redact(errorText(err)) },
        "ha registry re-list failed",
      );
      this.#emitError(err instanceof Error ? err : new Error(this.#redact(errorText(err))));
    }
  }

  /* ------------------------------------------------------------- heartbeat */

  #scheduleNextPing(): void {
    if (this.#pingTimer !== null) this.#deps.clearTimeout(this.#pingTimer);
    const generation = this.#generation;
    this.#pingTimer = this.#deps.setTimeout(() => {
      this.#pingTimer = null;
      this.#sendPing(generation);
    }, this.#pingIntervalMs);
  }

  #sendPing(generation: number): void {
    if (generation !== this.#generation || !this.#authenticated || !this.#ws) return;
    const id = this.#nextId++;
    this.#pingId = id;
    this.#sendRaw({ ...pingCommand(), id });
    this.#pongTimer = this.#deps.setTimeout(() => {
      this.#pongTimer = null;
      if (generation !== this.#generation) return;
      this.#missedPongs += 1;
      this.#log.warn({ missed: this.#missedPongs }, "ha heartbeat missed");
      if (this.#missedPongs >= this.#maxMissedPongs) {
        // The socket looks open but delivers nothing (the classic Wi-Fi/router hiccup).
        this.#setState("degraded", {
          error: `no pong for ${this.#missedPongs} consecutive pings`,
        });
        this.#fail(generation, `heartbeat lost (${this.#missedPongs} missed pongs)`);
        return;
      }
      this.#scheduleNextPing();
    }, this.#pongTimeoutMs);
  }

  #onPong(): void {
    if (this.#pongTimer !== null) {
      this.#deps.clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    }
    this.#missedPongs = 0;
    this.#pingId = null;
    this.#scheduleNextPing();
  }

  /* ---------------------------------------------------------------- plumbing */

  #dispatch(command: HaCommandBody): { id: number; promise: Promise<unknown> } {
    const ws = this.#ws;
    const id = this.#nextId++;
    if (!ws || !this.#authenticated) {
      return {
        id,
        promise: Promise.reject(
          new HaDisconnectedError(`cannot send ${command.type}: not connected to home assistant`),
        ),
      };
    }
    const frame: HaCommand = { ...command, id };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = this.#deps.setTimeout(() => {
        this.#pending.delete(id);
        reject(new HaCommandTimeoutError(command.type, this.#commandTimeoutMs));
      }, this.#commandTimeoutMs);
      this.#pending.set(id, { commandType: command.type, resolve, reject, timer });
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        this.#pending.delete(id);
        this.#deps.clearTimeout(timer);
        reject(new HaDisconnectedError(this.#redact(`send failed: ${errorText(err)}`)));
      }
    });
    return { id, promise };
  }

  #sendRaw(frame: object): void {
    try {
      this.#ws?.send(JSON.stringify(frame));
    } catch (err) {
      this.#log.warn({ error: this.#redact(errorText(err)) }, "ha raw send failed");
    }
  }

  /** Single failure funnel: tear down, then either stay stopped or schedule a backoff retry. */
  #fail(generation: number, reason: string): void {
    if (generation !== this.#generation) return;
    const error = this.#redact(reason);
    this.#teardown();
    if (this.#stopped) {
      this.#setState("disconnected", { error });
      return;
    }
    this.#reconnectCount += 1;
    this.#scheduleReconnect(error);
  }

  #scheduleReconnect(error: string): void {
    const attempt = this.#attempt;
    this.#attempt = Math.min(attempt + 1, 64);

    // Full-jitter exponential backoff (§8.3). The jitter is not cosmetic: without it an HA
    // restart makes every retry land in the same tight, perfectly aligned rhythm.
    const window = Math.min(this.#backoffCapMs, this.#backoffBaseMs * 2 ** Math.min(attempt, 6));
    let delay = Math.round(this.#deps.random() * window);
    if (this.#authFailed) delay = Math.max(delay, this.#authFailedFloorMs);
    delay = Math.max(0, delay);

    this.#setState(this.#authFailed ? "auth_failed" : "backoff", {
      error,
      retryInMs: delay,
      attempt: this.#attempt,
    });

    const generation = this.#generation;
    this.#reconnectTimer = this.#deps.setTimeout(() => {
      this.#reconnectTimer = null;
      if (generation !== this.#generation || this.#stopped) return;
      this.#connect();
    }, delay);
  }

  /**
   * Drop the socket and everything hanging off it. Bumps the generation so in-flight async
   * work becomes a no-op. Every pending command rejects with HaDisconnectedError so no caller
   * can hang forever (§8.2).
   */
  #teardown(): void {
    this.#generation += 1;
    this.#authenticated = false;

    for (const timer of [
      this.#handshakeTimer,
      this.#pingTimer,
      this.#pongTimer,
      this.#reconnectTimer,
    ]) {
      if (timer !== null) this.#deps.clearTimeout(timer);
    }
    this.#handshakeTimer = null;
    this.#pingTimer = null;
    this.#pongTimer = null;
    this.#reconnectTimer = null;
    this.#pingId = null;
    this.#missedPongs = 0;

    for (const timer of this.#registryTimers.values()) this.#deps.clearTimeout(timer);
    this.#registryTimers.clear();

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      this.#deps.clearTimeout(entry.timer);
      entry.reject(new HaDisconnectedError(`home assistant connection lost before ${entry.commandType} completed`));
    }

    // Subscription handlers survive a reconnect; the HA-side ids do not.
    for (const entry of this.#subscriptions.values()) {
      entry.subscriptionId = null;
      entry.subscribing = false;
    }
    this.#subscriptionType.clear();

    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.removeAllListeners();
        // `terminate()` on a socket that is still handshaking aborts it by *emitting* an error.
        // With no listener attached that would take the process down, so swallow it explicitly.
        ws.on("error", () => {});
        ws.terminate();
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Convenience constructor for the worker entry point. Returns null when HA is not configured —
 * the worker is expected to keep running (scheduling works without HA) and say so loudly.
 */
export function createHaSocketFromEnv(
  env: { haWsUrl: string | null; HA_TOKEN?: string | undefined },
  options?: Omit<HaSocketOptions, "url" | "token">,
): HaSocket | null {
  if (!env.haWsUrl || !env.HA_TOKEN) return null;
  return new HaSocket({ ...options, url: env.haWsUrl, token: env.HA_TOKEN });
}
