import { expect, it } from "vitest";
import * as THREE from "three";
import { equipmentBox3 } from "@/house/scene/framing";

it("frames the full height of floor-standing appliances and lamps rather than just their mount", () => {
  for (const [symbol, height] of [["fridge", 1.86], ["freezer", 1.86], ["lamp_post", 1.5], ["floor_lamp", 1.5], ["floor_spot", 1.5]] as const) {
    const box = equipmentBox3({ position: [5, 3, 7], symbol });
    expect(box.containsPoint(new THREE.Vector3(5, 3 + height, 7)), symbol).toBe(true);
    expect(box.min.y).toBeLessThan(3);
  }
});

it("includes resizable LED bars and solar panels in the frame", () => {
  const led = equipmentBox3({ position: [0, 0, 0], symbol: "led_bar_vertical", ledLengthM: 4 });
  expect(led.max.y).toBeGreaterThan(4);
  const panel = equipmentBox3({ position: [0, 0, 0], symbol: "solar_panel", solarPanel: { widthM: 2, lengthM: 4, thicknessM: 0.04, tiltDeg: 0 } });
  expect(panel.getSize(new THREE.Vector3()).z).toBeGreaterThan(4);
});
