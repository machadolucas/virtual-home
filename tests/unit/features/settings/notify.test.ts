/**
 * Notify-service candidates.
 *
 * These are **derived, not discovered**: the registry cache holds identities, not Home Assistant's
 * service registry, so a phone's notify service is worked out from HA's own slug rules. The tests
 * therefore pin the slug rules, and pin what happens when the derivation cannot produce anything —
 * no candidate, rather than a wrong one.
 */
import { describe, expect, it } from "vitest";
import {
  isNotifyService,
  notifyCandidates,
  slugifyDeviceName,
  unclaimedCandidates,
  type MobileAppDevice,
} from "@/features/settings/notify";

describe("slugifyDeviceName", () => {
  it("matches Home Assistant's slug rules", () => {
    expect(slugifyDeviceName("Lucas iPhone")).toBe("lucas_iphone");
    expect(slugifyDeviceName("Marja-Helena's iPhone")).toBe("marja_helena_s_iphone");
    expect(slugifyDeviceName("Pixel 8 Pro")).toBe("pixel_8_pro");
  });

  it("strips diacritics rather than dropping the letter", () => {
    expect(slugifyDeviceName("Sähkö Phone")).toBe("sahko_phone");
  });

  it("collapses and trims separators", () => {
    expect(slugifyDeviceName("  A   B  ")).toBe("a_b");
    expect(slugifyDeviceName("---x---")).toBe("x");
  });

  it("produces nothing for a name with no ASCII letters, rather than a wrong slug", () => {
    expect(slugifyDeviceName("日本語")).toBe("");
    expect(slugifyDeviceName("!!!")).toBe("");
  });
});

describe("isNotifyService", () => {
  it("accepts what Home Assistant accepts", () => {
    expect(isNotifyService("notify.mobile_app_lucas_iphone")).toBe(true);
    expect(isNotifyService("notify.persistent_notification")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isNotifyService("mobile_app_lucas_iphone")).toBe(false);
    expect(isNotifyService("notify.Mobile_App")).toBe(false);
    expect(isNotifyService("notify.")).toBe(false);
    expect(isNotifyService("notify.a b")).toBe(false);
    expect(isNotifyService("")).toBe(false);
  });
});

describe("notifyCandidates", () => {
  function device(overrides: Partial<MobileAppDevice> = {}): MobileAppDevice {
    return { deviceId: "d1", displayName: "Lucas iPhone", model: "iPhone 15", ...overrides };
  }

  it("derives one candidate per phone", () => {
    const candidates = notifyCandidates([
      device(),
      device({ deviceId: "d2", displayName: "Marja-Helena's iPhone" }),
    ]);
    expect(candidates.map((entry) => entry.notifyService)).toEqual([
      "notify.mobile_app_lucas_iphone",
      "notify.mobile_app_marja_helena_s_iphone",
    ]);
  });

  it("keeps the device name, so an inbound action can be matched back", () => {
    const [candidate] = notifyCandidates([device()]);
    expect(candidate?.haDeviceName).toBe("Lucas iPhone");
    expect(candidate?.label).toBe("Lucas iPhone");
  });

  it("skips a phone whose name slugifies to nothing", () => {
    expect(notifyCandidates([device({ displayName: "!!!" })])).toEqual([]);
  });

  it("de-duplicates rather than offering the same service twice", () => {
    const candidates = notifyCandidates([
      device({ deviceId: "d1", displayName: "Lucas iPhone" }),
      device({ deviceId: "d2", displayName: "lucas-iphone" }),
    ]);
    expect(candidates).toHaveLength(1);
  });

  it("sorts by label, so the list is stable between renders", () => {
    const candidates = notifyCandidates([
      device({ deviceId: "d1", displayName: "Zoe Pixel" }),
      device({ deviceId: "d2", displayName: "Aino Pixel" }),
    ]);
    expect(candidates.map((entry) => entry.label)).toEqual(["Aino Pixel", "Zoe Pixel"]);
  });
});

describe("unclaimedCandidates", () => {
  it("hides a service already registered to somebody", () => {
    const all = notifyCandidates([
      { deviceId: "d1", displayName: "Lucas iPhone", model: null },
      { deviceId: "d2", displayName: "Aino Pixel", model: null },
    ]);
    const left = unclaimedCandidates(all, ["notify.mobile_app_lucas_iphone"]);
    expect(left.map((entry) => entry.label)).toEqual(["Aino Pixel"]);
  });

  it("returns everything when nothing is claimed", () => {
    const all = notifyCandidates([{ deviceId: "d1", displayName: "Lucas iPhone", model: null }]);
    expect(unclaimedCandidates(all, [])).toHaveLength(1);
  });
});
