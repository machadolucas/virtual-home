/**
 * The notification adapters between `HaSocket` and `src/domain/notify` — both directions, both
 * deliberately thin.
 *
 * Outbound (`createNotifySender`): one `ha_notify_command` row becomes one
 * `notify.mobile_app_<device>` service call, and every failure becomes a member of the domain's
 * `SendOutcome` union. The drain owns retry, backoff and abandonment; this function's only job is
 * to classify honestly — in particular `ha_unavailable` (retry soon, HA is down) must never be
 * reported as `ha_error` (retry, but something is wrong with *us*).
 *
 * Inbound (`startNotificationActionListener`): one `mobile_app_notification_action` event becomes
 * one `handleNotificationAction` call. Nothing in the payload is trusted here — shaping only; the
 * nonce lookup, recipient match, TTL and "was this action offered" checks are the domain's (§4.7).
 *
 * **Nothing in this module throws into the socket.** An exception in an HA event handler would
 * cross an `EventEmitter` boundary and take the process down, losing every other reminder.
 */
import type { DbHandle } from "@/db/client";
import type { SendOutcome } from "@/domain/notify/outbox";
import type { NotifyCommandRow } from "@/domain/notify/recipients";
import {
  handleNotificationAction,
  type ActionDeps,
  type HandleActionResult,
} from "@/domain/notify/actions";
import type { Clock } from "@/domain/time";
import { log } from "@/server/log";
import { normalizeNotifyService, tryParseNotificationAction } from "@/worker/ha/notify";
import {
  HaCommandTimeoutError,
  HaDisconnectedError,
  type HaSocket,
  type Unsubscribe,
} from "@/worker/ha/socket";

/** The HA event type the companion app fires when a notification action is tapped. */
export const NOTIFICATION_ACTION_EVENT = "mobile_app_notification_action";

/* ------------------------------------------------------------------ outbound */

/** The slice of `HaSocket` the sender needs. Anything with these two members will do. */
export interface NotifyCapableSocket {
  readonly state: string;
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface NotifySenderOptions {
  /**
   * Resolved per call, not captured: the socket may not exist yet at wiring time, and HA may be
   * disabled entirely (then this returns `null` forever and every command stays queued).
   */
  socket: () => NotifyCapableSocket | null;
  logger?: Pick<typeof log, "debug" | "warn">;
}

function parseServiceData(json: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("ha_notify_command.payload_json is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Build the `sender` the outbox drain calls.
 *
 * Outcome mapping (the drain turns each of these into backoff, a `delivery_attempt` row and,
 * after `MAX_ATTEMPTS`, an `app_alert`):
 *
 * | situation                                   | outcome          |
 * |---------------------------------------------|------------------|
 * | HA not configured, or socket not `subscribed`| `ha_unavailable` |
 * | `HaDisconnectedError` mid-call               | `ha_unavailable` |
 * | `HaCommandTimeoutError`                      | `timeout`        |
 * | HA rejected the call, or the payload is junk | `ha_error`       |
 * | HA accepted the call                         | `accepted`       |
 *
 * `accepted` means exactly "HA took the service call". It is never "delivered" (§4.9).
 */
export function createNotifySender(
  options: NotifySenderOptions,
): (command: NotifyCommandRow) => Promise<SendOutcome> {
  const logger = options.logger ?? log;

  return async (command: NotifyCommandRow): Promise<SendOutcome> => {
    const socket = options.socket();
    // "Not subscribed" covers disconnected, authenticating, syncing, degraded and auth_failed:
    // in every one of them a service call would either fail or be silently dropped.
    if (!socket || socket.state !== "subscribed") {
      logger.debug(
        { commandId: command.id, kind: command.kind, socketState: socket?.state ?? "absent" },
        "notify send skipped: HA not subscribed",
      );
      return "ha_unavailable";
    }

    let service: string;
    let serviceData: Record<string, unknown>;
    try {
      service = normalizeNotifyService(command.notifyService);
      serviceData = parseServiceData(command.payloadJson);
    } catch (err) {
      // Not retryable in any useful sense, but the drain's backoff is the safest place to park it.
      logger.warn({ commandId: command.id, err }, "notify command payload is unusable");
      return "ha_error";
    }

    try {
      await socket.callService("notify", service, serviceData);
      return "accepted";
    } catch (err) {
      if (err instanceof HaDisconnectedError) return "ha_unavailable";
      if (err instanceof HaCommandTimeoutError) return "timeout";
      logger.warn(
        { commandId: command.id, kind: command.kind, service, err },
        "notify service call failed",
      );
      return "ha_error";
    }
  };
}

/* ------------------------------------------------------------------- inbound */

export interface NotificationActionAdapterOptions {
  handle: DbHandle;
  clock: Clock;
  /** `completeFromAction(...)` from `src/domain/completion.ts`, already bound to handle + tz. */
  completeFromAction?: ActionDeps["completeFromAction"];
  logger?: Pick<typeof log, "debug" | "info" | "warn" | "error">;
}

/** `event.context.id` — the HA context, when the envelope carried one. */
function contextId(event: unknown): string | null {
  if (event === null || typeof event !== "object" || !("context" in event)) return null;
  const context = (event as { context?: unknown }).context;
  if (context === null || typeof context !== "object" || !("id" in context)) return null;
  const id = (context as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Shape one HA event and hand it to the domain. Returns `null` when the event was not even
 * structurally an action (logged at `debug`: a malformed payload from a phone is not an incident)
 * or when the domain call failed (logged at `error`).
 */
export function handleHaNotificationAction(
  options: NotificationActionAdapterOptions,
  event: unknown,
): HandleActionResult | null {
  const logger = options.logger ?? log;
  const parsed = tryParseNotificationAction(event);
  if (!parsed.ok) {
    logger.debug({ err: parsed.error }, "ignoring unparseable notification action");
    return null;
  }

  try {
    const result = handleNotificationAction({
      handle: options.handle,
      clock: options.clock,
      event: {
        action: parsed.value.action,
        actionData: parsed.value.actionData,
        deviceName: parsed.value.sourceDeviceName ?? null,
        haContextId: contextId(event),
        raw: event,
      },
      ...(options.completeFromAction
        ? { deps: { completeFromAction: options.completeFromAction } }
        : {}),
    });
    logger.info(
      {
        action: parsed.value.action,
        validation: result.validation,
        effect: result.appliedEffect,
        eventId: result.eventId,
      },
      "notification action handled",
    );
    return result;
  } catch (err) {
    // Never rethrow: this runs inside an HA socket event handler.
    logger.error({ err, action: parsed.value.action }, "notification action failed");
    return null;
  }
}

/**
 * Subscribe to `mobile_app_notification_action`. The returned function unsubscribes; the socket
 * re-establishes the subscription itself after a reconnect (§8.3).
 */
export function startNotificationActionListener(
  options: NotificationActionAdapterOptions & { socket: HaSocket },
): Unsubscribe {
  return options.socket.subscribeEvents(NOTIFICATION_ACTION_EVENT, (event) => {
    handleHaNotificationAction(options, event);
  });
}
