/**
 * The two lossy-looking translations, pinned down so they are not lossy in practice:
 *
 *  - `medium` ⇄ the workspace's `system`/`kind`, where the round trip must not turn hot water into
 *    cold water;
 *  - a numeric size ⇄ `nominal_size` text, where a human's "DN20" must survive untouched.
 *
 * Plus the money parser, because a budget is stored in integer cents and a Finnish keyboard types
 * "1 234,50".
 */
import { describe, expect, it } from "vitest";
import { INFRA_MEDIA } from "@/db/schema/infrastructure";
import {
  DEFAULT_MEDIUM_OF_SYSTEM,
  kindOfMedium,
  mediaOfSystem,
  mediumForSystem,
  systemOfMedium,
} from "@/features/projects/infraMedium";
import { formatNominalSize, parseNominalSize } from "@/features/projects/nominalSize";
import { costVariance, formatCents, parseCents } from "@/features/projects/labels";
import { MEDIA } from "@/features/projects/wire";

describe("medium ⇄ system", () => {
  it("mirrors every medium the schema allows", () => {
    expect([...MEDIA].sort()).toEqual([...INFRA_MEDIA].sort());
  });

  it("gives every medium exactly one system and one kind", () => {
    for (const medium of INFRA_MEDIA) {
      expect(systemOfMedium(medium)).toBeTruthy();
      expect(kindOfMedium(medium)).toBeTruthy();
    }
  });

  it("round-trips every system through its default medium", () => {
    for (const [system, medium] of Object.entries(DEFAULT_MEDIUM_OF_SYSTEM))
      expect(systemOfMedium(medium)).toBe(system);
  });

  it("keeps a specific medium when the system still fits — hot water stays hot", () => {
    expect(mediumForSystem("water", "hot_water")).toBe("hot_water");
    expect(mediumForSystem("water", "cold_water")).toBe("cold_water");
    expect(mediumForSystem("network", "fiber")).toBe("fiber");
  });

  it("falls back to the system default when the previous medium no longer belongs", () => {
    expect(mediumForSystem("network", "hot_water")).toBe("ethernet");
    expect(mediumForSystem("water", null)).toBe("cold_water");
  });

  it("lists the media of a system", () => {
    expect(mediaOfSystem("water")).toEqual(["cold_water", "hot_water"]);
    expect(mediaOfSystem("ventilation")).toEqual(["supply_air", "extract_air"]);
  });
});

describe("nominal size", () => {
  it("round-trips a diameter through the canonical text", () => {
    const text = formatNominalSize({ diameterM: 0.125 });
    expect(text).toBe("Ø125 mm");
    expect(parseNominalSize(text)).toEqual({ diameterM: 0.125 });
  });

  it("round-trips a width", () => {
    const text = formatNominalSize({ widthM: 0.6 });
    expect(text).toBe("W600 mm");
    expect(parseNominalSize(text)).toEqual({ widthM: 0.6 });
  });

  it("never mangles text a human typed, and reads no number out of it", () => {
    expect(formatNominalSize({ nominalSize: "DN20", diameterM: 0.02 })).toBe("DN20");
    expect(parseNominalSize("DN20")).toEqual({});
    expect(parseNominalSize("Cat6a")).toEqual({});
    expect(parseNominalSize(null)).toEqual({});
  });

  it("refuses a nonsense size rather than storing a zero", () => {
    expect(formatNominalSize({ diameterM: 0 })).toBeNull();
    expect(formatNominalSize({ diameterM: -1 })).toBeNull();
    expect(formatNominalSize({})).toBeNull();
  });
});

describe("money", () => {
  it("parses what a person actually types", () => {
    expect(parseCents("1 234,50")).toBe(123450);
    expect(parseCents("1.234,50 €")).toBe(123450);
    expect(parseCents("1234.5")).toBe(123450);
    expect(parseCents("1234")).toBe(123400);
    expect(parseCents("0,05")).toBe(5);
  });

  it("returns null rather than a zero for something that is not an amount", () => {
    expect(parseCents("")).toBeNull();
    expect(parseCents("about four hundred")).toBeNull();
    expect(parseCents("-")).toBeNull();
  });

  it("shows an unrecorded amount as unknown, never as zero", () => {
    expect(formatCents(null)).toBe("—");
    expect(formatCents(0)).not.toBe("—");
  });

  it("states the overrun as a difference, and nothing at all when a side is unknown", () => {
    expect(costVariance(100000, 124000)).toEqual({ overspend: true, deltaCents: 24000 });
    expect(costVariance(100000, 90000)).toEqual({ overspend: false, deltaCents: 10000 });
    expect(costVariance(null, 90000)).toBeNull();
    expect(costVariance(100000, null)).toBeNull();
  });
});
