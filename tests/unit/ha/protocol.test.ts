import { describe, expect, it } from "vitest";
import {
  HaDeviceRegistryEntrySchema,
  HaEntityRegistryEntrySchema,
  callServiceCommand,
  parseIncomingMessage,
  parseListLenient,
} from "@/worker/ha/protocol";

describe("parseIncomingMessage", () => {
  it("parses the frames we model and keeps unknown fields", () => {
    expect(parseIncomingMessage({ type: "auth_required", ha_version: "2026.9.1" })).toEqual({
      type: "auth_required",
      ha_version: "2026.9.1",
    });
    expect(parseIncomingMessage({ id: 4, type: "pong" })).toEqual({ id: 4, type: "pong" });

    const result = parseIncomingMessage({
      id: 7,
      type: "result",
      success: false,
      error: { code: "unknown_command", message: "nope" },
      unexpected_new_field: 1,
    });
    expect(result).toMatchObject({
      id: 7,
      success: false,
      error: { code: "unknown_command" },
      unexpected_new_field: 1,
    });
  });

  it("returns null for frame types we do not model, instead of throwing", () => {
    expect(parseIncomingMessage({ type: "some_future_frame", payload: 1 })).toBeNull();
    expect(parseIncomingMessage("not an object")).toBeNull();
    expect(parseIncomingMessage({ type: "result" })).toBeNull(); // no id/success
  });
});

describe("registry schemas are lenient", () => {
  it("accepts a 2026.9 child device with no hardware fields", () => {
    const parsed = HaDeviceRegistryEntrySchema.safeParse({
      id: "dev_child",
      name: "Filter",
      parent_device_id: "dev_parent",
      primary_config_entry: "cfg",
      brand_new_2027_field: { nested: true },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.manufacturer).toBeUndefined();
    expect(parsed.data?.parent_device_id).toBe("dev_parent");
  });

  it("accepts an entity entry with nulls everywhere but the entity_id", () => {
    const parsed = HaEntityRegistryEntrySchema.safeParse({
      entity_id: "sensor.x",
      id: null,
      unique_id: null,
      platform: null,
      device_id: null,
      options: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("parseListLenient", () => {
  it("drops and counts records that fail even the lenient schema", () => {
    const { records, skipped } = parseListLenient(HaEntityRegistryEntrySchema, [
      { entity_id: "sensor.ok" },
      { no_entity_id: true },
      42,
      { entity_id: "sensor.also_ok" },
    ]);
    expect(records.map((r) => r.entity_id)).toEqual(["sensor.ok", "sensor.also_ok"]);
    expect(skipped).toBe(2);
  });

  it("treats a non-array response as empty", () => {
    expect(parseListLenient(HaEntityRegistryEntrySchema, null)).toEqual({ records: [], skipped: 0 });
  });
});

describe("callServiceCommand", () => {
  it("always pins return_response to false and omits empty parts", () => {
    expect(callServiceCommand("notify", "mobile_app_lucas_iphone", { message: "hi" })).toEqual({
      type: "call_service",
      domain: "notify",
      service: "mobile_app_lucas_iphone",
      return_response: false,
      service_data: { message: "hi" },
    });
    expect(callServiceCommand("fan", "turn_on", {}, { entity_id: "fan.house_hrv" })).toEqual({
      type: "call_service",
      domain: "fan",
      service: "turn_on",
      return_response: false,
      target: { entity_id: "fan.house_hrv" },
    });
  });
});
