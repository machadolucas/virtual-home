/**
 * Home Assistant WebSocket protocol: the exact subset of messages virtual-home speaks.
 *
 * Design rules (see docs/home-assistant.md and docs/design-notes/auth-security-operations.md §8):
 *  - Every inbound payload is parsed with zod before it reaches domain code: HA is external input.
 *  - Registry records are parsed **leniently** (`z.looseObject`, optional/nullable everywhere except
 *    the primary key). HA adds and removes fields between minor releases (2026.8 deprecated
 *    `config_entries` in favour of `primary_config_entry`; 2026.9 introduced child devices carrying
 *    `parent_device_id` with no hardware/firmware fields). An HA upgrade must never crash the worker,
 *    and unknown keys are preserved so a later reader can pick them up without a protocol change.
 *  - Nothing in here logs or formats the access token. See `redactSecrets()` in socket.ts.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ shared */

/** HA attaches a context to states and events; `user_id` is the acting HA user (null for automations). */
export const HaContextSchema = z.looseObject({
  id: z.string().nullish(),
  parent_id: z.string().nullish(),
  user_id: z.string().nullish(),
});
export type HaContext = z.infer<typeof HaContextSchema>;

/** A state object as delivered by `get_states` and inside `state_changed`. */
export const HaStateSchema = z.looseObject({
  entity_id: z.string(),
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  last_changed: z.string().nullish(),
  last_updated: z.string().nullish(),
  /** Added in 2024.8: bumped even when the value did not change. */
  last_reported: z.string().nullish(),
  context: HaContextSchema.nullish(),
});
export type HaState = z.infer<typeof HaStateSchema>;

/** Identifier/connection tuples are `[domain, value]`; be tolerant about the value's JSON type. */
const TupleListSchema = z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])));

/* -------------------------------------------------------- registry records */

/**
 * `config/entity_registry/list` record.
 *
 * `id` is the entity **registry entry id** — the stable identity we key everything on (§7.2).
 * Note that the list variant of this command does not always carry `device_class` /
 * `unit_of_measurement`; when overridden by the user they arrive under
 * `options["sensor"]["unit_of_measurement"]`, and otherwise only the state's attributes have them.
 * `resolveEntityMeta()` in registry.ts implements that fallback chain.
 */
export const HaEntityRegistryEntrySchema = z.looseObject({
  entity_id: z.string(),
  id: z.string().nullish(),
  unique_id: z.string().nullish(),
  platform: z.string().nullish(),
  config_entry_id: z.string().nullish(),
  config_subentry_id: z.string().nullish(),
  device_id: z.string().nullish(),
  area_id: z.string().nullish(),
  disabled_by: z.string().nullish(),
  hidden_by: z.string().nullish(),
  entity_category: z.string().nullish(),
  name: z.string().nullish(),
  original_name: z.string().nullish(),
  device_class: z.string().nullish(),
  original_device_class: z.string().nullish(),
  unit_of_measurement: z.string().nullish(),
  translation_key: z.string().nullish(),
  icon: z.string().nullish(),
  original_icon: z.string().nullish(),
  has_entity_name: z.boolean().nullish(),
  aliases: z.array(z.string()).nullish(),
  labels: z.array(z.string()).nullish(),
  options: z.record(z.string(), z.unknown()).nullish(),
});
export type HaEntityRegistryEntry = z.infer<typeof HaEntityRegistryEntrySchema>;

/**
 * `config/device_registry/list` record.
 *
 * Tolerates the 2026.8–2026.9 shape changes: `config_entries` is deprecated in favour of
 * `primary_config_entry`/`config_entry_id`, and child devices carry `parent_device_id` while
 * omitting `manufacturer`/`model`/`sw_version`/`hw_version` entirely.
 */
export const HaDeviceRegistryEntrySchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  name_by_user: z.string().nullish(),
  manufacturer: z.string().nullish(),
  model: z.string().nullish(),
  model_id: z.string().nullish(),
  sw_version: z.string().nullish(),
  hw_version: z.string().nullish(),
  serial_number: z.string().nullish(),
  area_id: z.string().nullish(),
  via_device_id: z.string().nullish(),
  /** 2026.9 child devices. */
  parent_device_id: z.string().nullish(),
  identifiers: TupleListSchema.nullish(),
  connections: TupleListSchema.nullish(),
  entry_type: z.string().nullish(),
  disabled_by: z.string().nullish(),
  /** @deprecated by HA — kept only as a fallback for `primary_config_entry`. */
  config_entries: z.array(z.string()).nullish(),
  config_entries_subentries: z.record(z.string(), z.unknown()).nullish(),
  primary_config_entry: z.string().nullish(),
  config_entry_id: z.string().nullish(),
  configuration_url: z.string().nullish(),
  suggested_area: z.string().nullish(),
  labels: z.array(z.string()).nullish(),
});
export type HaDeviceRegistryEntry = z.infer<typeof HaDeviceRegistryEntrySchema>;

/** `config/area_registry/list` record. */
export const HaAreaRegistryEntrySchema = z.looseObject({
  area_id: z.string(),
  name: z.string(),
  floor_id: z.string().nullish(),
  icon: z.string().nullish(),
  picture: z.string().nullish(),
  aliases: z.array(z.string()).nullish(),
  labels: z.array(z.string()).nullish(),
  humidity_entity_id: z.string().nullish(),
  temperature_entity_id: z.string().nullish(),
});
export type HaAreaRegistryEntry = z.infer<typeof HaAreaRegistryEntrySchema>;

/** `config/floor_registry/list` record. */
export const HaFloorRegistryEntrySchema = z.looseObject({
  floor_id: z.string(),
  name: z.string(),
  level: z.number().nullish(),
  icon: z.string().nullish(),
  aliases: z.array(z.string()).nullish(),
  labels: z.array(z.string()).nullish(),
});
export type HaFloorRegistryEntry = z.infer<typeof HaFloorRegistryEntrySchema>;

/* --------------------------------------------------------- inbound frames */

export const HaAuthRequiredSchema = z.looseObject({
  type: z.literal("auth_required"),
  ha_version: z.string().nullish(),
});
export const HaAuthOkSchema = z.looseObject({
  type: z.literal("auth_ok"),
  ha_version: z.string().nullish(),
});
export const HaAuthInvalidSchema = z.looseObject({
  type: z.literal("auth_invalid"),
  message: z.string().nullish(),
});

export const HaResultErrorSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).nullish(),
  message: z.string().nullish(),
});
export type HaResultError = z.infer<typeof HaResultErrorSchema>;

export const HaResultSchema = z.looseObject({
  id: z.number().int(),
  type: z.literal("result"),
  success: z.boolean(),
  result: z.unknown().optional(),
  error: HaResultErrorSchema.nullish(),
});

/** The `event` field of an `event` frame. `data` stays `unknown` — callers parse what they need. */
export const HaEventSchema = z.looseObject({
  event_type: z.string(),
  data: z.unknown().optional(),
  origin: z.string().nullish(),
  time_fired: z.string().nullish(),
  context: HaContextSchema.nullish(),
});
export type HaEvent = z.infer<typeof HaEventSchema>;

export const HaEventMessageSchema = z.looseObject({
  id: z.number().int(),
  type: z.literal("event"),
  event: HaEventSchema,
});

export const HaPongSchema = z.looseObject({
  id: z.number().int(),
  type: z.literal("pong"),
});

export const HaIncomingMessageSchema = z.discriminatedUnion("type", [
  HaAuthRequiredSchema,
  HaAuthOkSchema,
  HaAuthInvalidSchema,
  HaResultSchema,
  HaEventMessageSchema,
  HaPongSchema,
]);
export type HaIncomingMessage = z.infer<typeof HaIncomingMessageSchema>;

/** Parse one inbound frame. Returns `null` for anything we do not model (HA adds frame types). */
export function parseIncomingMessage(raw: unknown): HaIncomingMessage | null {
  const parsed = HaIncomingMessageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/* ----------------------------------------------------------- event payloads */

/** `state_changed`: either side is null on entity creation/removal. */
export const HaStateChangedDataSchema = z.looseObject({
  entity_id: z.string(),
  new_state: HaStateSchema.nullable().optional(),
  old_state: HaStateSchema.nullable().optional(),
});
export type HaStateChangedData = z.infer<typeof HaStateChangedDataSchema>;

/**
 * `*_registry_updated` payload. **Treated strictly as a cache-invalidation signal.**
 * `changes` reports the *old* values (HA core #134613, #152288), so applying it corrupts the cache.
 * The socket debounces and re-lists instead; see HaSocket's registry handling.
 */
export const HaRegistryUpdatedDataSchema = z.looseObject({
  action: z.string().nullish(),
  entity_id: z.string().nullish(),
  device_id: z.string().nullish(),
  area_id: z.string().nullish(),
  floor_id: z.string().nullish(),
  changes: z.unknown().optional(),
});
export type HaRegistryUpdatedData = z.infer<typeof HaRegistryUpdatedDataSchema>;

/** `mobile_app_notification_action` — an action button tap from the companion app. */
export const HaMobileAppNotificationActionDataSchema = z.looseObject({
  action: z.string(),
  action_data: z.unknown().optional(),
  reply_text: z.string().nullish(),
  tag: z.string().nullish(),
  message: z.string().nullish(),
  device_name: z.string().nullish(),
  device_id: z.string().nullish(),
  sourceDeviceName: z.string().nullish(),
  sourceDeviceID: z.string().nullish(),
});
export type HaMobileAppNotificationActionData = z.infer<
  typeof HaMobileAppNotificationActionDataSchema
>;

/* ---------------------------------------------------------------- commands */

/** WS command types we send. Anything not listed here is not part of our contract with HA. */
export const HA_COMMAND = {
  auth: "auth",
  ping: "ping",
  getStates: "get_states",
  subscribeEvents: "subscribe_events",
  unsubscribeEvents: "unsubscribe_events",
  callService: "call_service",
  entityRegistryList: "config/entity_registry/list",
  deviceRegistryList: "config/device_registry/list",
  areaRegistryList: "config/area_registry/list",
  floorRegistryList: "config/floor_registry/list",
} as const;

export type HaRegistryName = "entity" | "device" | "area" | "floor";

/** The four registry-updated event types, mapped to the registry they invalidate. */
export const HA_REGISTRY_EVENT: Readonly<Record<string, HaRegistryName>> = {
  entity_registry_updated: "entity",
  device_registry_updated: "device",
  area_registry_updated: "area",
  floor_registry_updated: "floor",
};

/** `config/<x>_registry/list` command type per registry. */
export const HA_REGISTRY_LIST_COMMAND: Readonly<Record<HaRegistryName, string>> = {
  entity: HA_COMMAND.entityRegistryList,
  device: HA_COMMAND.deviceRegistryList,
  area: HA_COMMAND.areaRegistryList,
  floor: HA_COMMAND.floorRegistryList,
};

/** Event types the socket always subscribes to, in addition to caller subscriptions. */
export const HA_DEFAULT_EVENT_TYPES: readonly string[] = [
  "state_changed",
  "mobile_app_notification_action",
  "entity_registry_updated",
  "device_registry_updated",
  "area_registry_updated",
  "floor_registry_updated",
];

/** A service target (`entity_id` / `device_id` / `area_id` / `floor_id` / `label_id`). */
export interface HaServiceTarget {
  entity_id?: string | string[];
  device_id?: string | string[];
  area_id?: string | string[];
  floor_id?: string | string[];
  label_id?: string | string[];
}

/** An outbound command without its id; `HaSocket.send()` assigns the per-connection id. */
export type HaCommandBody = { type: string } & Record<string, unknown>;

/** Same, with the id the socket assigned. */
export type HaCommand = HaCommandBody & { id: number };

export function authCommand(token: string): { type: "auth"; access_token: string } {
  return { type: "auth", access_token: token };
}
export function pingCommand(): HaCommandBody {
  return { type: HA_COMMAND.ping };
}
export function getStatesCommand(): HaCommandBody {
  return { type: HA_COMMAND.getStates };
}
export function subscribeEventsCommand(eventType?: string): HaCommandBody {
  return eventType
    ? { type: HA_COMMAND.subscribeEvents, event_type: eventType }
    : { type: HA_COMMAND.subscribeEvents };
}
export function unsubscribeEventsCommand(subscription: number): HaCommandBody {
  return { type: HA_COMMAND.unsubscribeEvents, subscription };
}
export function registryListCommand(registry: HaRegistryName): HaCommandBody {
  return { type: HA_REGISTRY_LIST_COMMAND[registry] };
}

/**
 * `call_service` with `return_response: false`.
 * We never consume a service response, and asking for one makes HA reject services that
 * cannot supply it — so it is pinned false rather than omitted.
 */
export function callServiceCommand(
  domain: string,
  service: string,
  serviceData?: Record<string, unknown>,
  target?: HaServiceTarget,
): HaCommandBody {
  const cmd: HaCommandBody = {
    type: HA_COMMAND.callService,
    domain,
    service,
    return_response: false,
  };
  if (serviceData && Object.keys(serviceData).length > 0) cmd.service_data = serviceData;
  if (target && Object.keys(target).length > 0) cmd.target = target;
  return cmd;
}

/* ------------------------------------------------------------ list parsing */

export interface LenientParseResult<T> {
  records: T[];
  /** Records HA sent that did not satisfy even the lenient schema. Never fatal. */
  skipped: number;
}

/**
 * Parse an array response record-by-record. One malformed row out of ~3300 entities must not
 * fail a whole sync, so bad rows are counted and dropped rather than thrown.
 */
export function parseListLenient<T>(schema: z.ZodType<T>, raw: unknown): LenientParseResult<T> {
  if (!Array.isArray(raw)) return { records: [], skipped: 0 };
  const records: T[] = [];
  let skipped = 0;
  for (const item of raw) {
    const parsed = schema.safeParse(item);
    if (parsed.success) records.push(parsed.data);
    else skipped += 1;
  }
  return { records, skipped };
}
