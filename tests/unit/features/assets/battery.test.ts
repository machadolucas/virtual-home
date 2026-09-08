/**
 * Battery display.
 *
 * The invariant these tests exist to defend is CLAUDE.md rule 8: **`unknown`/`unavailable` is
 * never a value, and never 0 %.** A smoke alarm we have no reading for needs a different reaction
 * from one with a flat battery, and a UI that shows both as "0 %" makes the difference invisible.
 *
 * Every branch is asserted to produce a *word* rather than a number, so a future refactor that
 * reaches for `?? 0` fails here instead of in the hallway at 3 a.m.
 */
import { describe, expect, it } from "vitest";
import { batteryDisplay, type BatteryInput } from "@/features/assets/battery";

const NOW = Date.parse("2026-09-08T09:00:00Z");

function input(overrides: Partial<BatteryInput> = {}): BatteryInput {
  return {
    rawState: "80",
    lastUpdatedMs: NOW - 60_000,
    thresholdPct: 15,
    staleHours: 48,
    nowMs: NOW,
    ...overrides,
  };
}

describe("batteryDisplay — never 0 % for a missing reading", () => {
  it("reports unknown when there is no reading at all", () => {
    const result = batteryDisplay(input({ rawState: null, lastUpdatedMs: null }));
    expect(result.state).toBe("unknown");
    expect(result.status).toBe("unknown");
    expect(result.label).toBe("Battery unknown");
    expect(result).not.toHaveProperty("percent");
  });

  it("reports unknown for HA's `unavailable`, not zero", () => {
    const result = batteryDisplay(input({ rawState: "unavailable" }));
    expect(result.state).toBe("unknown");
    expect(result.label).not.toContain("0");
    if (result.state === "unknown") expect(result.reason).toBe("unavailable");
  });

  it("reports unknown for HA's `unknown`, not zero", () => {
    const result = batteryDisplay(input({ rawState: "unknown" }));
    expect(result.state).toBe("unknown");
    if (result.state === "unknown") expect(result.reason).toBe("unknown");
  });

  it("reports unknown for a non-numeric reading", () => {
    for (const raw of ["", "  ", "none", "null", "NaN", "low", "ok"]) {
      const result = batteryDisplay(input({ rawState: raw }));
      expect(result.state, `raw=${JSON.stringify(raw)}`).toBe("unknown");
    }
  });

  it("case-folds the non-values, because integrations are inconsistent", () => {
    expect(batteryDisplay(input({ rawState: "Unavailable" })).state).toBe("unknown");
    expect(batteryDisplay(input({ rawState: "UNKNOWN" })).state).toBe("unknown");
  });

  it("does show a real zero, because that is a reading", () => {
    const result = batteryDisplay(input({ rawState: "0" }));
    expect(result.state).toBe("value");
    if (result.state === "value") {
      expect(result.percent).toBe(0);
      expect(result.low).toBe(true);
      expect(result.status).toBe("due");
    }
  });
});

describe("batteryDisplay — thresholds", () => {
  it("is low at or under the household threshold", () => {
    const at = batteryDisplay(input({ rawState: "15" }));
    expect(at.state === "value" && at.low).toBe(true);
    const above = batteryDisplay(input({ rawState: "16" }));
    expect(above.state === "value" && above.low).toBe(false);
    expect(above.status).toBe("ok");
  });

  it("rounds a fractional reading rather than showing false precision", () => {
    const result = batteryDisplay(input({ rawState: "82.4" }));
    expect(result.state === "value" && result.percent).toBe(82);
    expect(result.label).toBe("82 %");
  });
});

describe("batteryDisplay — staleness", () => {
  it("marks an old reading stale and labels it as history", () => {
    const result = batteryDisplay(
      input({ rawState: "40", lastUpdatedMs: NOW - 49 * 3_600_000 }),
    );
    expect(result.state).toBe("stale");
    expect(result.status).toBe("stale");
    expect(result.label).toBe("Last read 40 %");
  });

  it("trusts the condition engine's own stale flag", () => {
    const result = batteryDisplay(input({ rawState: "40", isStale: true }));
    expect(result.state).toBe("stale");
  });

  it("keeps a reading inside the window", () => {
    const result = batteryDisplay(
      input({ rawState: "40", lastUpdatedMs: NOW - 47 * 3_600_000 }),
    );
    expect(result.state).toBe("value");
  });

  it("treats stale and unknown as different states, on purpose", () => {
    const stale = batteryDisplay(input({ rawState: "40", isStale: true }));
    const unknown = batteryDisplay(input({ rawState: null, lastUpdatedMs: null }));
    expect(stale.status).not.toBe(unknown.status);
    expect(stale.label).not.toBe(unknown.label);
  });
});
