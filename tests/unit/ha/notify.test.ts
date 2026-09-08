import { describe, expect, it } from "vitest";
import {
  CLEAR_NOTIFICATION_MESSAGE,
  HaNotificationActionError,
  HaNotifyError,
  buildClearNotification,
  buildNotifyServiceCall,
  normalizeNotifyService,
  parseNotificationAction,
  tryParseNotificationAction,
} from "@/worker/ha/notify";
import { SAMPLE_NOTIFY_SERVICES } from "../../helpers/fakeHa";

describe("normalizeNotifyService", () => {
  it("accepts both the bare slug and the full notify.<slug> form", () => {
    for (const service of SAMPLE_NOTIFY_SERVICES) {
      expect(normalizeNotifyService(service)).toBe(service.slice("notify.".length));
    }
    expect(normalizeNotifyService("mobile_app_lucas_iphone")).toBe("mobile_app_lucas_iphone");
  });

  it("rejects anything that is not a service slug", () => {
    for (const bad of ["notify.Mobile App", "mobile app", "notify.a.b", ""]) {
      expect(() => normalizeNotifyService(bad)).toThrow(HaNotifyError);
    }
  });
});

describe("buildNotifyServiceCall", () => {
  it("builds the full maintenance-reminder payload", () => {
    const call = buildNotifyServiceCall({
      service: "notify.mobile_app_lucas_iphone",
      title: "Replace battery: Bedroom door sensor",
      message: "Due today",
      tag: "vh:occ:occ_123:user_lucas",
      url: "https://home.example/tasks/occ_123",
      group: "virtual-home-maintenance",
      threadId: "virtual-home",
      actions: [
        { action: "URI", title: "Open", uri: "https://home.example/tasks/occ_123" },
        { action: "vh_snooze", title: "Snooze 1 day" },
        { action: "vh_done", title: "Done" },
      ],
      actionData: { v: 1, occurrenceId: "occ_123", nonce: "n_abc" },
    });

    expect(call.domain).toBe("notify");
    expect(call.service).toBe("mobile_app_lucas_iphone");
    expect(call.service_data).toEqual({
      title: "Replace battery: Bedroom door sensor",
      message: "Due today",
      data: {
        tag: "vh:occ:occ_123:user_lucas",
        url: "https://home.example/tasks/occ_123",
        group: "virtual-home-maintenance",
        push: { "thread-id": "virtual-home" },
        actions: [
          { action: "URI", title: "Open", uri: "https://home.example/tasks/occ_123" },
          { action: "vh_snooze", title: "Snooze 1 day" },
          { action: "vh_done", title: "Done" },
        ],
        action_data: { v: 1, occurrenceId: "occ_123", nonce: "n_abc" },
      },
    });
  });

  it("omits the data envelope entirely for a bare message", () => {
    expect(buildNotifyServiceCall({ service: "mobile_app_x", message: "hello" })).toEqual({
      domain: "notify",
      service: "mobile_app_x",
      service_data: { message: "hello" },
    });
  });

  it("rejects malformed action lists", () => {
    expect(() =>
      buildNotifyServiceCall({
        service: "mobile_app_x",
        message: "m",
        actions: [{ action: "URI", title: "Open" }],
      }),
    ).toThrow(/URI action requires a uri/);

    expect(() =>
      buildNotifyServiceCall({
        service: "mobile_app_x",
        message: "m",
        actions: [
          { action: "vh_done", title: "Done" },
          { action: "vh_done", title: "Done again" },
        ],
      }),
    ).toThrow(/duplicate action id/);

    // Two URI actions are legitimate: they never round-trip to us.
    expect(() =>
      buildNotifyServiceCall({
        service: "mobile_app_x",
        message: "m",
        actions: [
          { action: "URI", title: "Open", uri: "https://a" },
          { action: "URI", title: "Complete", uri: "https://b" },
        ],
      }),
    ).not.toThrow();
  });

  it("refuses an empty message and the clear_notification sentinel", () => {
    expect(() => buildNotifyServiceCall({ service: "mobile_app_x", message: "" })).toThrow();
    expect(() =>
      buildNotifyServiceCall({ service: "mobile_app_x", message: CLEAR_NOTIFICATION_MESSAGE }),
    ).toThrow(/buildClearNotification/);
  });
});

describe("buildClearNotification", () => {
  it("sends the clear_notification sentinel with the tag", () => {
    expect(
      buildClearNotification({
        service: "notify.mobile_app_marja_helenas_iphone",
        tag: "vh:occ:occ_123:user_marja",
      }),
    ).toEqual({
      domain: "notify",
      service: "mobile_app_marja_helenas_iphone",
      service_data: {
        message: "clear_notification",
        data: { tag: "vh:occ:occ_123:user_marja" },
      },
    });
  });

  it("requires a tag: clearing without one would clear the wrong notification", () => {
    expect(() => buildClearNotification({ service: "mobile_app_x", tag: "" })).toThrow();
  });
});

describe("parseNotificationAction", () => {
  const event = {
    event_type: "mobile_app_notification_action",
    data: {
      action: "vh_done",
      action_data: { v: 1, occurrenceId: "occ_123", nonce: "n_abc" },
      reply_text: "already done",
      tag: "vh:occ:occ_123:user_lucas",
      device_name: "Lucas iPhone",
    },
    origin: "REMOTE",
    time_fired: "2026-09-08T06:00:00.000Z",
    context: { id: "ctx_1", parent_id: null, user_id: "ha_user_lucas" },
  };

  it("shapes the full event envelope, including the HA context user", () => {
    const parsed = parseNotificationAction(event);
    expect(parsed).toMatchObject({
      action: "vh_done",
      actionData: { v: 1, occurrenceId: "occ_123", nonce: "n_abc" },
      replyText: "already done",
      tag: "vh:occ:occ_123:user_lucas",
      contextUserId: "ha_user_lucas",
      sourceDeviceName: "Lucas iPhone",
    });
    expect(parsed.raw.action).toBe("vh_done");
  });

  it("accepts the bare event data, with no context available", () => {
    const parsed = parseNotificationAction({ action: "vh_snooze" });
    expect(parsed).toMatchObject({
      action: "vh_snooze",
      actionData: undefined,
      replyText: null,
      tag: null,
      contextUserId: null,
    });
    expect(parsed.sourceDeviceName).toBeUndefined();
  });

  it("leaves action_data completely unvalidated - the domain layer owns the nonce check", () => {
    const parsed = parseNotificationAction({
      action: "vh_done",
      action_data: "not even an object",
    });
    expect(parsed.actionData).toBe("not even an object");
  });

  it("throws on a different event type or a missing action", () => {
    expect(() => parseNotificationAction({ event_type: "state_changed", data: {} })).toThrow(
      HaNotificationActionError,
    );
    expect(() => parseNotificationAction({ tag: "x" })).toThrow(HaNotificationActionError);
    expect(() => parseNotificationAction({ action: "   " })).toThrow(/empty action/);
    expect(() => parseNotificationAction(null)).toThrow(HaNotificationActionError);
  });

  it("tryParseNotificationAction reports malformed payloads instead of throwing", () => {
    expect(tryParseNotificationAction({ action: "vh_done" }).ok).toBe(true);
    const failed = tryParseNotificationAction({ nope: true });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBeInstanceOf(HaNotificationActionError);
  });
});
