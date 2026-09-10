import { expect, it } from "vitest";
import { detailedLightBudget, detailedLightHardwareLimit } from "@/house/model/detailedLightBudget";

it("reserves GPU resources for daylight and textured model materials", () => {
  expect(detailedLightHardwareLimit(32, 32)).toBe(26);
  expect(detailedLightHardwareLimit(16, 16)).toBe(10);
  expect(detailedLightHardwareLimit(16, 32, 7)).toBe(8);
  expect(detailedLightHardwareLimit(2, 2)).toBe(0);
});

it("shares a total limit across available fixture types without wasting half on an absent type", () => {
  expect(detailedLightBudget(24, 30, 0)).toEqual({ point: 24, spot: 0 });
  expect(detailedLightBudget(24, 0, 30)).toEqual({ point: 0, spot: 24 });
  expect(detailedLightBudget(16, 30, 2)).toEqual({ point: 14, spot: 2 });
  expect(detailedLightBudget(16, 3, 30)).toEqual({ point: 3, spot: 13 });
  expect(detailedLightBudget(0, 30, 30)).toEqual({ point: 0, spot: 0 });
});

it("supports totals beyond a single shader or slider without allocating more than installed fixtures", () => {
  expect(detailedLightBudget(192, 100, 100)).toEqual({ point: 96, spot: 96 });
  expect(detailedLightBudget(700, 400, 300)).toEqual({ point: 400, spot: 300 });
  expect(detailedLightBudget(256, 60, 20)).toEqual({ point: 60, spot: 20 });
  expect(detailedLightBudget(Number.NaN, 20, 20)).toEqual({ point: 0, spot: 0 });
});
