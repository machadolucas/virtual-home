/**
 * Notification payload builders and inbound action parsing for the HA companion app.
 *
 * Outbound: `notify.mobile_app_<device_slug>` service calls (§8.6). The payload conventions —
 * `tag` for replace-in-place, `group` for stacking, `push.thread-id`, `action_data` echoed back on
 * a tap — are documented in docs/home-assistant.md and in domain-scheduling-inventory.md §4.6.
 *
 * Inbound: `mobile_app_notification_action` events. Everything in them originates outside the app
 * (a phone, possibly a stale notification from weeks ago), so this module only *shapes* the data.
 * All authorisation — nonce lookup, recipient match, TTL, "was this action actually offered" —
 * belongs to the domain layer (§4.7). Nothing here may be treated as trusted.
 */
import { z } from "zod";
import {
  HaMobileAppNotificationActionDataSchema,
  type HaEvent,
  type HaMobileAppNotificationActionData,
} from "./protocol";

/** The magic message that clears a notification instead of showing one. */
export const CLEAR_NOTIFICATION_MESSAGE = "clear_notification";

/** Service names look like `mobile_app_lucas_iphone`; a full `notify.x` is accepted and trimmed. */
const SERVICE_NAME = /^[a-z0-9_]+$/;

export class HaNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaNotifyError";
  }
}

/**
 * One action button. `action: 'URI'` opens `uri` directly in the app and never round-trips to us;
 * any other action id comes back as a `mobile_app_notification_action` event.
 */
export const NotifyActionSchema = z.object({
  action: z.string().min(1).max(64),
  title: z.string().min(1).max(64),
  uri: z.string().min(1).optional(),
  destructive: z.boolean().optional(),
  authenticationRequired: z.boolean().optional(),
  behavior: z.enum(["default", "textInput"]).optional(),
  textInputButtonTitle: z.string().min(1).optional(),
  textInputPlaceholder: z.string().min(1).optional(),
  icon: z.string().min(1).optional(),
});
export type NotifyAction = z.infer<typeof NotifyActionSchema>;

export const BuildNotifyInputSchema = z.object({
  /** `mobile_app_lucas_iphone` or `notify.mobile_app_lucas_iphone`. */
  service: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  message: z.string().min(1).max(2000),
  /** Replace-in-place key. `vh:occ:<occurrenceId>:<recipientUserId>` (§4.6). */
  tag: z.string().min(1).max(200).optional(),
  /** Deep link into VH_BASE_URL; tapping the body opens it. */
  url: z.string().min(1).optional(),
  actions: z.array(NotifyActionSchema).max(10).optional(),
  /** Echoed back verbatim in the action event. Keep it small and carry a nonce. */
  actionData: z.unknown().optional(),
  group: z.string().min(1).max(200).optional(),
  /** iOS `push.thread-id`. */
  threadId: z.string().min(1).max(200).optional(),
});
export type BuildNotifyInput = z.input<typeof BuildNotifyInputSchema>;

export interface HaNotifyServiceCall {
  domain: "notify";
  service: string;
  service_data: Record<string, unknown>;
}

/** Strip an optional `notify.` prefix and validate the slug. */
export function normalizeNotifyService(service: string): string {
  const trimmed = service.trim();
  const slug = trimmed.startsWith("notify.") ? trimmed.slice("notify.".length) : trimmed;
  if (!SERVICE_NAME.test(slug)) {
    throw new HaNotifyError(`invalid notify service name: ${JSON.stringify(trimmed)}`);
  }
  return slug;
}

/**
 * Build a `notify.<service>` call.
 *
 * Empty optional pieces are omitted rather than sent as null: the companion app treats an
 * explicit null `tag` differently from an absent one.
 */
export function buildNotifyServiceCall(input: BuildNotifyInput): HaNotifyServiceCall {
  const parsed = BuildNotifyInputSchema.parse(input);
  const service = normalizeNotifyService(parsed.service);

  if (parsed.message === CLEAR_NOTIFICATION_MESSAGE) {
    throw new HaNotifyError(
      `refusing to send ${CLEAR_NOTIFICATION_MESSAGE} as a notification body — use buildClearNotification()`,
    );
  }

  const actions = parsed.actions ?? [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.action === "URI" && !action.uri) {
      throw new HaNotifyError("a URI action requires a uri");
    }
    if (action.action !== "URI") {
      if (seen.has(action.action)) {
        throw new HaNotifyError(`duplicate action id: ${action.action}`);
      }
      seen.add(action.action);
    }
  }

  const data: Record<string, unknown> = {};
  if (parsed.tag !== undefined) data.tag = parsed.tag;
  if (parsed.url !== undefined) data.url = parsed.url;
  if (parsed.group !== undefined) data.group = parsed.group;
  if (parsed.threadId !== undefined) data.push = { "thread-id": parsed.threadId };
  if (actions.length > 0) data.actions = actions;
  if (parsed.actionData !== undefined) data.action_data = parsed.actionData;

  const serviceData: Record<string, unknown> = { message: parsed.message };
  if (parsed.title !== undefined) serviceData.title = parsed.title;
  if (Object.keys(data).length > 0) serviceData.data = data;

  return { domain: "notify", service, service_data: serviceData };
}

export const BuildClearNotificationInputSchema = z.object({
  service: z.string().min(1),
  tag: z.string().min(1).max(200),
});
export type BuildClearNotificationInput = z.input<typeof BuildClearNotificationInputSchema>;

/**
 * Clear a previously sent notification by tag. Queued on completion for both users regardless of
 * who completed (§4.8); if HA is down it drains on reconnect, and clears drain before notifies.
 */
export function buildClearNotification(
  input: BuildClearNotificationInput,
): HaNotifyServiceCall {
  const parsed = BuildClearNotificationInputSchema.parse(input);
  return {
    domain: "notify",
    service: normalizeNotifyService(parsed.service),
    service_data: {
      message: CLEAR_NOTIFICATION_MESSAGE,
      data: { tag: parsed.tag },
    },
  };
}

/* ------------------------------------------------------------------ inbound */

export interface ParsedNotificationAction {
  /** The action id the phone reported, e.g. `vh_done`. Untrusted. */
  action: string;
  /** Whatever we put in `action_data` when sending, echoed back. Untrusted, unvalidated. */
  actionData: unknown;
  /** Text typed into a `behavior: 'textInput'` action. */
  replyText: string | null;
  tag: string | null;
  /** `event.context.user_id`: the HA user the companion app authenticated as, or null. */
  contextUserId: string | null;
  /** The phone that sent it, when the companion app included it. */
  sourceDeviceName?: string;
  /** The whole event data, for the pessimistic `notification_action_event.raw` column. */
  raw: HaMobileAppNotificationActionData;
}

export class HaNotificationActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaNotificationActionError";
  }
}

function actionEventData(event: unknown): unknown {
  if (event && typeof event === "object" && "event_type" in event) {
    const envelope = event as HaEvent;
    if (envelope.event_type !== "mobile_app_notification_action") {
      throw new HaNotificationActionError(
        `expected a mobile_app_notification_action event, got ${envelope.event_type}`,
      );
    }
    return envelope.data;
  }
  return event;
}

function contextUserId(event: unknown): string | null {
  if (event && typeof event === "object" && "context" in event) {
    const context = (event as HaEvent).context;
    if (context && typeof context === "object" && typeof context.user_id === "string") {
      return context.user_id;
    }
  }
  return null;
}

/**
 * Shape one `mobile_app_notification_action` event. Accepts the full event envelope (preferred,
 * so `context.user_id` is available) or the bare `event.data`.
 *
 * Throws `HaNotificationActionError` when the payload is not even structurally an action — the
 * caller records that as `validation='malformed'` and does nothing else.
 */
export function parseNotificationAction(event: unknown): ParsedNotificationAction {
  const data = actionEventData(event);
  const parsed = HaMobileAppNotificationActionDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new HaNotificationActionError(
      "mobile_app_notification_action payload has no usable action field",
    );
  }
  const value = parsed.data;
  const action = value.action.trim();
  if (action.length === 0) {
    throw new HaNotificationActionError("mobile_app_notification_action has an empty action");
  }
  const sourceDeviceName = value.sourceDeviceName ?? value.device_name ?? undefined;
  return {
    action,
    actionData: value.action_data,
    replyText: value.reply_text ?? null,
    tag: value.tag ?? null,
    contextUserId: contextUserId(event),
    ...(sourceDeviceName ? { sourceDeviceName } : {}),
    raw: value,
  };
}

export type NotificationActionParseResult =
  | { ok: true; value: ParsedNotificationAction }
  | { ok: false; error: HaNotificationActionError };

/** Non-throwing variant, for the worker's event handler. */
export function tryParseNotificationAction(event: unknown): NotificationActionParseResult {
  try {
    return { ok: true, value: parseNotificationAction(event) };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof HaNotificationActionError
          ? err
          : new HaNotificationActionError("unparseable mobile_app_notification_action"),
    };
  }
}
