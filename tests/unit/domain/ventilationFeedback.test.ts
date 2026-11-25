import { expect, it } from "vitest";
import { classifyVentilationFeedback, fanForAirStream } from "@/domain/ventilationFeedback";

const config = { supply: "supply-registry", extract: null, staleAfterSeconds: 180 };
const now = 1_000_000;
const reading = {
  state: "38.5", unit: "%", observedAt: now - 1_000,
  lastUpdated: now - 200_000, lastReported: now - 10_000,
};

it("uses fresh unchanged reports, keeps stopped distinct from missing, and rejects invalid values", () => {
  const classify = (changes = {}) => classifyVentilationFeedback(config, "supply", { ...reading, ...changes }, true, now);
  expect(classify()).toEqual({ status: "live", percentage: 38.5 });
  expect(classify({ state: "0" })).toEqual({ status: "stopped", percentage: 0 });
  expect(classify({ state: "unavailable" })).toEqual({ status: "unavailable" });
  expect(classify({ state: "unknown" })).toEqual({ status: "unknown" });
  expect(classify({ state: "" })).toEqual({ status: "invalid" });
  expect(classify({ state: "-1" })).toEqual({ status: "invalid" });
  expect(classify({ state: "101" })).toEqual({ status: "invalid" });
  expect(classify({ unit: "rpm" })).toEqual({ status: "invalid" });
  expect(classify({ lastReported: null })).toEqual({ status: "stale" });
  expect(classify({ observedAt: now - 66_000 })).toEqual({ status: "disconnected" });
  expect(classifyVentilationFeedback(config, "supply", reading, false, now)).toEqual({ status: "disconnected" });
  expect(classifyVentilationFeedback(config, "extract", undefined, false, now)).toEqual({ status: "illustrative" });
  expect(classifyVentilationFeedback(config, "supply", undefined, true, now)).toEqual({ status: "unavailable" });
});

it("maps intake and supply to the supply fan and extract and exhaust to the extract fan", () => {
  expect(fanForAirStream("outdoor_intake")).toBe("supply");
  expect(fanForAirStream("room_supply")).toBe("supply");
  expect(fanForAirStream("room_extract")).toBe("extract");
  expect(fanForAirStream("outdoor_discharge")).toBe("extract");
});
