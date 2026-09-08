# Home Assistant integration

How virtual-home talks to Home Assistant, and the rules that keep the integration honest.

Target instance: HA **2026.9.1**, ~3300 entities, 471 devices, 30 areas, 5 floors. WebSocket API at
`ws://<host>:8123/api/websocket`.

The original design pass is `docs/design-notes/auth-security-operations.md` §8 (transport) and
`docs/design-notes/domain-scheduling-inventory.md` §6.2 / §7 (batteries, registry cache). This page
is what the code actually does; where they differ, this page and the code win.

## Ownership

The **worker process alone** holds `HA_TOKEN` and the WebSocket. The web process reads HA state from
SQLite, and calls HA REST only for request-scoped history (`VH_HA_HISTORY_ENABLED`). The token is
never in a client bundle, never in a `NEXT_PUBLIC_*` var, never in an SSR payload, and never in a log
line or an error message — every error path in `src/worker/ha` goes through `redactSecrets()`.

## Files

| File | Contents |
|---|---|
| `src/worker/ha/protocol.ts` | zod schemas + types for every WS frame and command we use; lenient registry/state records; command builders; `parseListLenient()` |
| `src/worker/ha/socket.ts` | `HaSocket` — the connection state machine, heartbeat, backoff, subscriptions, snapshots |
| `src/worker/ha/registry.ts` | pure normalisation, `diffRegistry()`, battery selection, `classifyBatteryReading()` |
| `src/worker/ha/notify.ts` | notification payload builders and inbound action parsing |
| `src/worker/ha/rest.ts` | `fetchHistory()`, `checkToken()` |
| `src/worker/ha/redact.ts` | `redactSecrets()` / `errorText()` |
| `tests/helpers/fakeHa.ts` | the fake HA server, `ManualClock`, and the sample registry |

There is **no database access** in this layer. `HaSocket` emits typed events and the persistence
layer subscribes; that keeps HA parsing out of SQL and makes the whole transport testable without a
schema.

## Connection lifecycle

```
disconnected --start()--> connecting --auth_required--> authenticating --auth_ok--> syncing --> subscribed
                              |                              |                        |            |
                              | ws error/close               | auth_invalid           |            | 2 missed pongs
                              |                              v                        |            v
                              |                          auth_failed                  |         degraded
                              |                        (>= 5 min floor)               |            |
                              +----------------------------> backoff <----------------+------------+
                                                                | full-jitter delay
                                                                +--> connecting
```

- **connecting** — `new WebSocket(haWsUrl)` with a **10 s handshake budget** that covers both the
  TCP/WS handshake and the auth exchange. HA speaks first (`auth_required`); we do not send anything
  on `open`.
- **authenticating** — send `{type:"auth", access_token}`. `auth_ok` captures `ha_version`.
- **auth_failed** — `auth_invalid` means a bad or revoked token. We do **not** fast-retry: the delay
  is floored at **5 minutes**, the state stays `auth_failed` (so `/settings/system` can show a red
  "rotate HA_TOKEN" banner rather than a generic "reconnecting"), and it is logged at `error`.
  Hammering a rejected token only fills HA's log.
- **syncing** — `get_states` plus the four `config/*_registry/list` commands, **in parallel**, then
  one `'snapshot'` event carrying all five lists. The persistence layer writes that as a single
  `BEGIN IMMEDIATE` transaction so the web never sees a half-updated registry.
- **subscribed** — steady state.
- **degraded** — two consecutive missed pongs. The socket is terminated (`terminate()`, never
  `close()`: a half-open TCP socket otherwise hangs for minutes) and we re-enter backoff.
- **backoff** — full-jitter exponential: `random() * min(60_000, 1000 * 2 ** min(attempt, 6))`.
  The jitter is not cosmetic — without it an HA restart makes every retry land in the same tight,
  perfectly aligned rhythm. The attempt counter resets once a connection reaches `subscribed`.

Other invariants:

- **Command ids are per connection**, monotonic from 1, reset on every socket.
- Pending commands live in a map with a **30 s timeout** (`HaCommandTimeoutError`), and **every**
  pending command is rejected with `HaDisconnectedError` on disconnect. No caller can hang forever.
- **Every reconnect re-subscribes and re-snapshots.** Subscription ids do not survive a new socket,
  and `state_changed` only describes the future — skipping the re-snapshot is the classic "the app
  shows yesterday's state after a network blip" bug.
- **Heartbeat**: `ping` every 30 s, `pong` expected within 10 s, two consecutive misses ⇒ `degraded`.
  This is essential, not optional: a Wi-Fi or router hiccup leaves a TCP socket that looks open and
  delivers nothing, and without the ping the worker would sit "connected" and silently stale for
  hours.

### Public API

```ts
const socket = new HaSocket({ url: env.haWsUrl, token: env.HA_TOKEN });
socket.on("state",      (s) => persistIntegrationStatus(s));   // {state, haVersion?, error?, retryInMs?}
socket.on("snapshot",   (s) => writeSnapshot(s));              // {states, entities, devices, areas, floors}
socket.on("state_changed", (d) => onStateChanged(d));          // raw HA event data
socket.on("registry",   (r) => replaceRegistry(r));            // fresh list after a re-list
socket.on("registry_updated", ({ registry }) => {});           // the invalidation signal itself
socket.start();

const off = socket.subscribeEvents("mobile_app_notification_action", handleTap);
await socket.callService("notify", "mobile_app_lucas_iphone", serviceData);
await socket.getStates();
await socket.listRegistries();
socket.stop();
```

`'error'` is emitted **only when a listener is attached**, so an unhandled EventEmitter `'error'`
can never take the worker down. Failures always show up in the `'state'` payload as well.

Timers, the `WebSocket` constructor, `Date.now` and `random` are all injectable via `deps` — that is
what makes the tests deterministic.

## What we subscribe to

Six always-on subscriptions (`HA_DEFAULT_EVENT_TYPES`):

- `state_changed` — every state change on the instance, filtered client-side against the linked
  entity set. At household scale this is one JSON parse per event.
- `mobile_app_notification_action` — action-button taps from notifications.
- `entity_registry_updated`, `device_registry_updated`, `area_registry_updated`,
  `floor_registry_updated` — cache-invalidation signals only (below).

`subscribeEvents(type, handler)` adds handlers; the socket keeps **one HA subscription per event
type** regardless of how many handlers there are, and re-establishes all of them after a reconnect.

**Documented upgrade path** if CPU ever shows up in the metrics: switch `state_changed` to
`subscribe_trigger` with a state trigger enumerating the linked `entity_id`s, which filters
server-side. The trade-off is that the subscription must be torn down and re-established whenever the
linked set changes, which is why it is not the default. `subscribe_entities` (compressed diffs) is a
third option but its payload format is less stable.

## Registry refresh policy

On any `*_registry_updated` event: **debounce 2 s, then re-run the corresponding
`config/*_registry/list` and replace the local table wholesale.** No polling.

**The event payload is never applied.** `entity_registry_updated` reports the *old* values under
`changes` (HA core issues #134613, #152288), so applying it writes stale data into the cache — for a
rename it would write back the pre-rename `entity_id`. The HA frontend itself responds to these
events with a full list refresh, and matching that behaviour is the only correct approach. These
events are strictly invalidation signals. This is worth stating loudly because the payload looks
temptingly usable; `tests/unit/ha/socket.test.ts` asserts the stale payload is ignored and that N
signals inside the debounce window coalesce into exactly one re-list.

Registry parsing is deliberately lenient (`z.looseObject`, everything but the primary key optional
and nullable, unknown keys preserved). An HA upgrade that adds or removes fields must never crash the
worker. Two shapes we specifically tolerate:

- `config_entries` is deprecated; `primary_config_entry` / `config_entry_id` win when present.
- 2026.9 **child devices** carry `parent_device_id` and have no `manufacturer` / `model` /
  `sw_version` / `hw_version` at all.

A record that fails even the lenient schema is dropped and counted (`skipped` on the snapshot and
refresh payloads) rather than failing the whole sync. A non-zero `skipped` means: read the HA release
notes.

`config/entity_registry/list` does not reliably carry `device_class` or `unit_of_measurement`; a
user override lands in `options["sensor"]` and otherwise only the state's attributes have them.
`resolveEntityMeta(entity, state)` implements that fallback chain (registry field → registry option
→ state attribute), and battery selection goes through it.

## Identity rules

Precedence when matching a synced record to a cached row (`entityIdentity()`):

1. **`id`** — the entity registry entry id. This is the primary identity and what every link stores.
2. **`(platform, unique_id)`** — used only when HA gave us no registry id.
3. **`entity_id`** — last resort, and the caller logs it as weak: an `entity_id` is user-renameable,
   so a link keyed on it silently breaks.

Never link by display name.

`diffRegistry(prev, next)` returns `{added, removed, renamed, changed}`:

- **`renamed`** — same identity *and* that identity is a real registry id, with a different
  `entityId`. Nothing breaks on a rename (every link stores the registry id), but the user is told.
  A renamed record is reported only in `renamed`, and its `fields` list carries its other edits too.
- An `entity_id` change on a record identified only by `(platform, unique_id)` is **not** a rename —
  rename and replacement cannot be distinguished there, so it lands in `changed`.
- **`removed`** means "present before, absent now". Callers **soft-delete** (`removed_at_ms`) and
  never hard-delete: links point at these rows.

## Battery dedupe

HA typically exposes several related entities per battery device:

| entity | device_class | unit | state | meaning |
|---|---|---|---|---|
| `sensor.x_battery` | `battery` | `%` | `68` | the level — **the only one we use** |
| `sensor.x_battery_type` | `enum` | — | `AAA` | the chemistry, useful for the part suggestion |
| `sensor.x_battery_voltage` | `voltage` | `V` | `2.9` | not a level |
| `sensor.x_battery_state` | `enum` | — | `Charging` | not a level (phones) |

`selectCanonicalBatteryEntities(entities, states, overrides)` returns
`Map<deviceId, entityRegistryId>` plus `batteryTypeEntityByDevice`:

1. **Candidates** — effective `device_class = battery` **and** unit `%`, not disabled or hidden,
   attached to a device.
2. **Hard exclusions** — `voltage` / `enum` device classes; `V` / `mV` units; `entity_id` ending
   `_battery_type`, `_battery_voltage`, `_battery_state` or containing `_battery_plugged`; and a
   latest state that is a real non-numeric value (this is what filters the `"AAA"` sensor even if it
   were mislabelled).
3. **Ranking** — manual override → a numerically verified state before a merely unavailable one →
   `_battery` / `_battery_level` suffix → shortest `entity_id` → lowest registry id.

One deliberate softening of §6.2: a state of `unknown` / `unavailable` / missing is **not** a hard
exclusion, only a demotion. It is transient, and excluding on it would make
`canonical_battery_entity_id` flap on every reconnect — and each change is audited.

A manual `asset_ha_link` with `role='battery_level'` (passed in as `overrides`) **wins outright**,
including over an entity these rules would have rejected. That is also how multi-battery devices are
handled; default behaviour stays one entity per device.

`classifyBatteryReading(raw, lastUpdatedMs, nowMs, staleHours)` returns
`{valid, value?, invalidReason?, stale}`:

- `unknown`, `unavailable`, `none`, `""`, `"AAA"` and anything non-numeric are **invalid, with no
  value** — they are the absence of a reading, **never 0 %** (hard rule #8). Treating them as 0 would
  invent low-battery tasks out of connectivity blips.
- `0` itself is a legitimate reading and survives.
- Values outside 0–100 are `out_of_range` rather than clamped.
- `stale` is `now - lastUpdated > staleHours`, and `true` when the timestamp is missing. A stale
  reading opens and closes no episode; it raises a data-quality alert instead of a maintenance task.

## Notifications

Outbound (`buildNotifyServiceCall`) produces a `notify.mobile_app_<slug>` call:

```jsonc
{
  "domain": "notify",
  "service": "mobile_app_lucas_iphone",
  "service_data": {
    "title": "Replace battery: Bedroom door sensor",
    "message": "Due today",
    "data": {
      "tag": "vh:occ:occ_123:user_lucas",     // replace-in-place
      "url": "https://home.example/tasks/occ_123",
      "group": "virtual-home-maintenance",     // stacking
      "push": { "thread-id": "virtual-home" },
      "actions": [
        { "action": "URI", "title": "Open", "uri": "https://home.example/tasks/occ_123" },
        { "action": "vh_snooze", "title": "Snooze 1 day" },
        { "action": "vh_done", "title": "Done" }
      ],
      "action_data": { "v": 1, "occurrenceId": "occ_123", "nonce": "n_abc" }
    }
  }
}
```

Conventions:

- **Tag** — `vh:occ:<occurrenceId>:<recipientUserId>`, digests `vh:digest:<userId>`. iOS replaces a
  notification with the same tag, so week 3's reminder overwrites week 2's automatically.
- **Actions** — `action: "URI"` with a `uri` opens the link in the app and never round-trips to us
  (several are fine). Any other action id comes back as a `mobile_app_notification_action` event and
  must be unique within a notification. Per-user service slugs live in the DB
  (`household_member.notifyService`), not in env, so adding a phone needs no restart.
- **`action_data`** is echoed back verbatim on a tap. Keep it small and always carry a nonce.
- **`url`** deep-links into `VH_BASE_URL`, which is why the session cookie must be `sameSite: 'lax'`.
- **Clearing** — `buildClearNotification({service, tag})` sends the `message: "clear_notification"`
  sentinel. `buildNotifyServiceCall` refuses that string as a body so a clear can never be sent by
  accident. Clears are queued for both users on completion, skip and cancel; if HA is down they drain
  on reconnect, clears before notifies.
- We record `sent`, never `delivered`.

Inbound (`parseNotificationAction(event)` / `tryParseNotificationAction`) shapes one
`mobile_app_notification_action` into
`{action, actionData, replyText, tag, contextUserId, sourceDeviceName?, raw}`. It accepts the full
event envelope (preferred — that is where `context.user_id` lives) or the bare `event.data`.

**This module only shapes the data; it authorises nothing.** Everything in the event originates
outside the app, possibly from a weeks-old notification on a phone. Nonce lookup, recipient match,
TTL, "was this action actually offered", and the two-layer replay guard all live in the domain layer
(`domain-scheduling-inventory.md` §4.7). `actionData` stays `unknown` on purpose.

## REST usage

Only two calls, both in `rest.ts`, both with the token in the `Authorization` header and never in a
URL, log line or error message:

- `fetchHistory({haUrl, token, entityId, startIso, endIso, fetchImpl, timeoutMs})` —
  `GET /api/history/period/<start>?filter_entity_id=&end_time=&minimal_response=true&no_attributes=true`.
  `minimal_response` + `no_attributes` are not niceties: without them a month of a one-minute sensor
  is megabytes of duplicated attributes. Non-numeric states come back as `value: null`, never 0.
  `entityId` must match `^[a-z0-9_]+\.[a-z0-9_]+$`, which also blocks query-parameter injection.
- `checkToken({haUrl, token})` — `GET /api/`, returning
  `authorized | unauthorized | unreachable | unexpected`. Never throws. This is what distinguishes
  "bad token" from "HA is down" in `/settings/system`.

**The entity allowlist is the important control, and it is the caller's job.** Without it the history
route is an open proxy letting any logged-in user read any entity's history from HA, cameras and
device trackers included. `rest.ts` deliberately knows nothing about links so it cannot be mistaken
for the control point. `VH_HA_HISTORY_ENABLED=false` removes the feature entirely.

## Running the fake HA in tests

`tests/helpers/fakeHa.ts` starts a real `ws` server on an ephemeral port, so the tests exercise
actual framing, JSON round-trips, half-open sockets and `terminate()`. Determinism comes from
`ManualClock`: nothing in `HaSocket` fires until a test advances it.

```ts
const server = await FakeHa.start();          // ws://127.0.0.1:<port>/api/websocket
const clock = new ManualClock();
const socket = new HaSocket({
  url: server.url,
  token: server.token,
  deps: {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    random: () => 1,                          // full-jitter delay becomes the whole window
  },
});
socket.start();
await nextState(socket, "subscribed");
// ...
socket.stop();
await server.close();
```

Controls: `setToken(valid)`, `setPongEnabled(false)`, `setCallServiceError({code, message})`,
`setStalled(commandType, true)` (accept a command and never answer it), `emitEvent(type, data)`,
`emitStateChanged(entityId, newState, oldState?)`,
`renameEntity(registryId, newEntityId)` (renames in the registry **and** emits a deliberately stale
`changes` payload), `dropAllClients()`, `close()`. Observables: `registry` (mutable),
`serviceCalls`, `commandCount(type)`, `connectionCount`, `clientCount`, `notifyServices`.

`buildSampleRegistry()` is exported separately so pure tests can use the sample data without
starting a server. It contains a Parmair MAC 120 with 12 entities (including
`binary_sensor.ventilation_filter_state`, `fan.house_hrv` and three `%` sensors that are *not*
batteries), a 2026.9 child device with no hardware fields, a `service`-type Zigbee bridge, an IKEA
MYGGBETT door sensor with the full battery/battery_type/battery_voltage trio, and the two phones that
own `notify.mobile_app_lucas_iphone` and `notify.mobile_app_marja_helenas_iphone`.

Advance the clock by *exactly* the delay you mean (`status.retryInMs` is on every `backoff` /
`auth_failed` status event). `ManualClock.advance` runs timers in due order and leaves later ones
alone, so an over-generous advance would trip the next handshake timeout on a connection that has not
finished opening yet.

Run them with:

```sh
pnpm exec vitest run tests/unit/ha
```
