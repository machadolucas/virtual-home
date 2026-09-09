import { describe, expect, it } from "vitest";
import { equipmentLabelReading } from "@/house/model/equipmentLabel";
import type { PlacementLinkedEntity } from "@/house/model/types";
import type { EntityState } from "@/house/store/haStore";

const links: PlacementLinkedEntity[] = [
  { entityId: "sensor.temp", role: "primary", name: "Temperature", deviceClass: "temperature", unit: "°C" },
  { entityId: "sensor.battery", role: "battery_level", name: "Battery", deviceClass: "battery", unit: "%" },
];

const entities: Record<string, EntityState> = {
  "sensor.temp": { entityId: "sensor.temp", state: "21.4", lastUpdated: 1000, unit: "°C" },
  "sensor.battery": { entityId: "sensor.battery", state: "68", lastUpdated: 1000, unit: "%" },
};

describe("equipment label readings", () => {
  it("shows the main reading and a filled battery indicator by default", () => {
    expect(equipmentLabelReading("sensor.temp", links, entities, "open", 1000, false))
      .toMatchObject({ text: "21.4 °C", batteryPercent: 68 });
  });

  it("expands to every linked reading with its friendly name", () => {
    expect(equipmentLabelReading("sensor.temp", links, entities, "open", 1000, true))
      .toMatchObject({ text: "Temperature: 21.4 °C", batteryPercent: 68 });
  });

  it("never turns an unavailable battery into zero percent", () => {
    const unavailable = {
      ...entities,
      "sensor.battery": { ...entities["sensor.battery"]!, state: "unavailable" },
    };
    expect(equipmentLabelReading("sensor.temp", links, unavailable, "open", 1000, false)?.text)
      .toBe("21.4 °C");
  });

  it("does not fall back to an older battery attribute when the explicit battery entity is unavailable", () => {
    const unavailable = {
      ...entities,
      "sensor.temp": { ...entities["sensor.temp"]!, battery: 91 },
      "sensor.battery": { ...entities["sensor.battery"]!, state: "unavailable" },
    };
    expect(equipmentLabelReading("sensor.temp", links, unavailable, "open", 1000, false))
      .not.toHaveProperty("batteryPercent");
  });
});
