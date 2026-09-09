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
      .toMatchObject({
        text: "21.4 °C",
        batteryPercent: 68,
        expandable: false,
        details: [{ label: "Temperature", value: "21.4 °C", icon: "temperature" }],
      });
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

  it("marks retained battery data as offline when Home Assistant disconnects", () => {
    expect(equipmentLabelReading("sensor.temp", links, entities, "closed", 1000, false))
      .toMatchObject({ text: "HA offline", batteryPercent: 68, className: "vh-label-disconnected" });
  });

  it("shows only directly linked useful readings in the expanded card", () => {
    const allLinks: PlacementLinkedEntity[] = [
      ...links,
      { entityId: "binary_sensor.occupied", role: "status", source: "entity", name: "Occupancy", deviceClass: "occupancy", unit: null },
      { entityId: "binary_sensor.contact", role: "status", source: "entity", name: "Door", deviceClass: "door", unit: null },
      { entityId: "sensor.illuminance", role: "status", source: "entity", name: "Illuminance", deviceClass: "illuminance", unit: "lx" },
      { entityId: "button.identify", role: "primary", source: "device", name: "Identify", deviceClass: null, unit: null },
      { entityId: "update.firmware", role: "status", source: "entity", name: "Firmware", deviceClass: null, unit: null },
      { entityId: "button.restart", role: "status", source: "entity", name: "Restart", deviceClass: null, unit: null },
    ];
    const allEntities: Record<string, EntityState> = {
      ...entities,
      "binary_sensor.occupied": { entityId: "binary_sensor.occupied", state: "off", lastUpdated: 1000, deviceClass: "occupancy" },
      "binary_sensor.contact": { entityId: "binary_sensor.contact", state: "off", lastUpdated: 1000, deviceClass: "door" },
      "sensor.illuminance": { entityId: "sensor.illuminance", state: "120", lastUpdated: 1000, deviceClass: "illuminance", unit: "lx" },
      "button.identify": { entityId: "button.identify", state: "unknown", lastUpdated: 1000 },
      "update.firmware": { entityId: "update.firmware", state: "on", lastUpdated: 1000 },
      "button.restart": { entityId: "button.restart", state: "unknown", lastUpdated: 1000 },
    };

    expect(equipmentLabelReading("sensor.temp", allLinks, allEntities, "open", 1000, true))
      .toMatchObject({
        text: "21.4 °C",
        expandable: true,
        details: [
          { label: "Temperature", value: "21.4 °C" },
          { label: "Occupancy", value: "Unoccupied", icon: "occupancy" },
          { label: "Door", value: "Closed", icon: "contact" },
          { label: "Illuminance", value: "120 lx", icon: "illuminance" },
        ],
      });
  });
});

describe("climate readings", () => {
  const climate: EntityState = { entityId: "climate.pump", state: "heat", hvacAction: "heating", currentTemperature: 21.5, targetTemperature: 23, temperatureUnit: "°C", fanMode: "auto", lastUpdated: 1 };
  const climateLinks: PlacementLinkedEntity[] = [{ entityId: climate.entityId, role: "primary", name: "Heat pump", deviceClass: null, unit: null }];
  it("shows climate operation and temperatures with only one linked climate entity", () => {
    const reading = equipmentLabelReading(climate.entityId, climateLinks, { [climate.entityId]: climate }, "open", 1000, true)!;
    expect(reading.text).toBe("heating · 21.5 °C");
    expect(reading.expandable).toBe(true);
    expect(reading.details).toContainEqual(expect.objectContaining({ label: "Target temperature", value: "23 °C" }));
  });
  it("does not treat unavailable climate attributes as current values", () => {
    const reading = equipmentLabelReading(climate.entityId, climateLinks, { [climate.entityId]: { ...climate, state: "unavailable" } }, "open", 1000, true)!;
    expect(reading.text).toBe("Unavailable");
    expect(reading.details.some((detail) => detail.label === "Target temperature")).toBe(false);
  });
});
