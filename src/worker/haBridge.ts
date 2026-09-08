/**
 * The wire between `HaSocket` (transport, no database) and `src/server/ha/*` (database, no HA
 * protocol). Everything stateful and awkward about the HA integration meets here:
 *
 *   socket 'state'         -> integration_status (+ integration.status event)
 *   socket 'snapshot'      -> registry cache, state cache, battery signals, location suggestions
 *   socket 'registry'      -> a single re-listed registry
 *   socket 'state_changed' -> 250 ms coalescing buffer -> state cache -> ha.state outbox events
 *   every hour             -> full re-list, as a safety net for a missed signal
 *
 * **No domain imports.** The low-battery engine lives in `src/domain` and is owned by other code;
 * this module hands it readings through the injected `onBatterySignal` callback instead of
 * importing it. That keeps the bridge compilable and testable on its own, and keeps the dependency
 * arrow pointing one way.
 *
 * The 250 ms buffer is stage 1 of the two-stage coalescing in
 * `docs/design-notes/auth-security-operations.md` §7.3, and it is the important stage: HA sends
 * every state change on the instance (~3300 entities), and without it the outbox would grow at
 * HA's event rate instead of at the household's.
 */
import { writeTx, type DbHandle } from "@/db/client";
import { EVENT_TOPICS, publish, type OutboxItem } from "@/server/events/outbox";
import {
  applyRegistryList,
  applyRegistryLists,
  applySnapshot,
  suggestLocationMappings,
} from "@/server/ha/registryCache";
import {
  applyStatesTx,
  applyStateChangedTx,
  interestingEntityIds,
  readCanonicalBatteryStates,
  type HaStateRecord,
} from "@/server/ha/stateCache";
import { writeIntegrationStatus } from "@/server/ha/status";
import { log } from "@/server/log";
import type { IntegrationState } from "@/db/schema/ha";
import type {
  HaRegistryRefresh,
  HaSnapshot,
  HaSocket,
  HaStatus,
} from "@/worker/ha/socket";
import type { HaStateChangedData } from "@/worker/ha/protocol";

/** The slice of the timer API the bridge uses. `ManualClock` in tests satisfies it as-is. */
export interface HaBridgeClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type BatterySignalHandler = (
  entityRegistryId: string,
  rawState: string,
  lastUpdatedMs: number,
) => void;

export interface HaBridgeOptions {
  handle: DbHandle;
  socket: HaSocket;
  clock?: HaBridgeClock;
  /**
   * Called for every reading of a device's canonical battery entity (on snapshot and on change).
   * Injected so the bridge does not depend on `src/domain`.
   */
  onBatterySignal?: BatterySignalHandler;
  /** Stage-1 coalescing window. Default 250 ms. */
  coalesceMs?: number;
  /** Full re-list safety net. Default 1 h. `0` disables it. */
  relistIntervalMs?: number;
  /** Redacted out of `integration_status.last_error`. */
  token?: string | null;
}

export interface HaBridge {
  /** Detach every listener and cancel every timer. Idempotent. */
  stop(): void;
  /** Flush the coalescing buffer now. Exposed for tests and for a clean shutdown. */
  flush(): void;
  /** Rows currently waiting in the coalescing buffer. */
  readonly pending: number;
}

const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RELIST_MS = 3_600_000;

const realClock: HaBridgeClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = globalThis.setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * `HaSocket` has a `backoff` state that `integration_status` does not: from the household's point
 * of view "waiting to retry" and "not connected" are the same sentence.
 */
function toIntegrationState(state: HaStatus["state"]): IntegrationState {
  return state === "backoff" ? "disconnected" : state;
}

function stateItem(record: HaStateRecord, atMs: number): OutboxItem {
  return {
    topic: EVENT_TOPICS.haState,
    entityKey: record.entityId,
    // Exactly the shape `src/house/store/haSse.ts` parses.
    payload: {
      state: record.state,
      attributes: record.attributes,
      lastUpdated: record.lastUpdatedMs,
    },
    atMs,
  };
}

export function startHaBridge(options: HaBridgeOptions): HaBridge {
  const { handle, socket } = options;
  const clock = options.clock ?? realClock;
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
  const relistIntervalMs = options.relistIntervalMs ?? DEFAULT_RELIST_MS;
  const onBatterySignal = options.onBatterySignal;
  const token = options.token ?? null;

  /** Stage-1 buffer: last write wins per entity. A dimmer sweep collapses to one row. */
  const buffer = new Map<string, HaStateChangedData>();
  let flushTimer: unknown = null;
  let relistTimer: unknown = null;
  let stopped = false;
  /** Reconnects since start: every re-entry into `connecting` after the first. */
  let reconnectCount = 0;
  let sawConnecting = false;

  /* -------------------------------------------------------------- batteries */

  /** entity_id -> registry_id for the canonical battery entities. */
  function canonicalBatteryIndex(): Map<string, string> {
    const rows = readCanonicalBatteryStates(handle.db);
    return new Map(rows.map((row) => [row.entityId, row.registryId]));
  }

  function emitBatterySignals(records: readonly HaStateRecord[]): void {
    if (!onBatterySignal || records.length === 0) return;
    const canonical = canonicalBatteryIndex();
    for (const record of records) {
      const registryId = canonical.get(record.entityId);
      if (!registryId) continue;
      onBatterySignal(registryId, record.state, record.lastUpdatedMs);
    }
  }

  /* ------------------------------------------------------------------ flush */

  function flush(): void {
    if (flushTimer !== null) {
      clock.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (buffer.size === 0) return;
    const events = [...buffer.values()];
    buffer.clear();
    const at = clock.now();

    let written: HaStateRecord[];
    try {
      written = writeTx(handle.db, (tx) => {
        // One `interestingEntityIds` query per flush rather than per event.
        const wanted = interestingEntityIds(tx);
        const records: HaStateRecord[] = [];
        for (const event of events) {
          const outcome = applyStateChangedTx(tx, event, at, wanted);
          if (outcome.record) records.push(outcome.record);
        }
        if (records.length > 0) {
          publish(
            tx,
            records.map((record) => stateItem(record, at)),
          );
        }
        return records;
      });
    } catch (err) {
      log.error({ err, events: events.length }, "ha bridge: state flush failed");
      return;
    }

    emitBatterySignals(written);
  }

  function scheduleFlush(): void {
    if (stopped || flushTimer !== null) return;
    flushTimer = clock.setTimeout(() => {
      flushTimer = null;
      flush();
    }, coalesceMs);
  }

  /* --------------------------------------------------------------- handlers */

  const onState = (status: HaStatus): void => {
    if (status.state === "connecting") {
      if (sawConnecting) reconnectCount += 1;
      sawConnecting = true;
    }
    try {
      writeIntegrationStatus(
        handle,
        {
          state: toIntegrationState(status.state),
          haVersion: status.haVersion ?? undefined,
          lastError: status.error ?? null,
          lastOkAtMs: status.state === "subscribed" ? status.at : undefined,
          reconnectCount,
          heartbeatAtMs: status.at,
          atMs: status.at,
        },
        token,
      );
    } catch (err) {
      log.error({ err, state: status.state }, "ha bridge: status write failed");
    }
  };

  const onSnapshot = (snapshot: HaSnapshot): void => {
    const at = snapshot.at;
    try {
      // Registry first: the state cache's "is this interesting" question needs the links and the
      // canonical battery pointers to already be right.
      const sync = applySnapshot(handle, snapshot, at);

      const written = writeTx(handle.db, (tx) => {
        const records = applyStatesTx(tx, snapshot.states, at, { onlyInteresting: true });
        if (records.length > 0) {
          publish(
            tx,
            records.map((record) => stateItem(record, at)),
          );
        }
        return records;
      });

      emitBatterySignals(written);
      suggestLocationMappings(handle, at);

      writeIntegrationStatus(
        handle,
        {
          state: "subscribed",
          haVersion: snapshot.haVersion ?? undefined,
          lastOkAtMs: at,
          heartbeatAtMs: at,
          entityCount: snapshot.entities.length,
          lastError: null,
          reconnectCount,
          atMs: at,
        },
        token,
      );

      log.info(
        {
          entities: sync.entitiesSeen,
          devices: sync.devicesSeen,
          renames: sync.renamesDetected,
          removals: sync.removalsDetected,
          statesCached: written.length,
          skipped: snapshot.skipped,
        },
        "ha snapshot applied",
      );
    } catch (err) {
      log.error({ err }, "ha bridge: snapshot apply failed");
    }
  };

  const onRegistry = (refresh: HaRegistryRefresh): void => {
    try {
      applyRegistryList(handle, refresh.registry, refresh.records, refresh.at);
      // A new or renamed area/floor may now match a location by name.
      if (refresh.registry === "area" || refresh.registry === "floor") {
        suggestLocationMappings(handle, refresh.at);
      }
    } catch (err) {
      log.error({ err, registry: refresh.registry }, "ha bridge: registry refresh failed");
    }
  };

  const onStateChanged = (data: HaStateChangedData): void => {
    if (stopped) return;
    buffer.set(data.entity_id, data);
    scheduleFlush();
  };

  socket.on("state", onState);
  socket.on("snapshot", onSnapshot);
  socket.on("registry", onRegistry);
  socket.on("state_changed", onStateChanged);

  /* ------------------------------------------------------- re-list safety net */

  function scheduleRelist(): void {
    if (stopped || relistIntervalMs <= 0) return;
    relistTimer = clock.setTimeout(() => {
      relistTimer = null;
      void relistNow().finally(scheduleRelist);
    }, relistIntervalMs);
  }

  async function relistNow(): Promise<void> {
    if (stopped) return;
    try {
      const lists = await socket.listRegistries();
      applyRegistryLists(handle, lists, clock.now());
      suggestLocationMappings(handle, clock.now());
    } catch (err) {
      // A failed safety net is not an incident: the next signal or reconnect re-syncs anyway.
      log.warn({ err }, "ha bridge: hourly re-list failed");
    }
  }

  scheduleRelist();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      socket.off("state", onState);
      socket.off("snapshot", onSnapshot);
      socket.off("registry", onRegistry);
      socket.off("state_changed", onStateChanged);
      if (flushTimer !== null) {
        clock.clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (relistTimer !== null) {
        clock.clearTimeout(relistTimer);
        relistTimer = null;
      }
      buffer.clear();
    },
    flush,
    get pending() {
      return buffer.size;
    },
  };
}
