/**
 * Relink suggestions for broken Home Assistant links (§7.2, the "replacement" case).
 *
 * Two properties matter more than coverage here:
 *  - an **ambiguous** match produces no suggestion, because a coin flip that repoints a link is
 *    worse than an empty state;
 *  - the entity-id fallback is labelled `likely`, not `exact`, because an entity id is renameable
 *    and can be reused by something unrelated.
 */
import { describe, expect, it } from "vitest";
import {
  groupSuggestionsByAsset,
  suggestRelinks,
  type BrokenLink,
  type CandidateEntity,
} from "@/features/assets/haLink";

function link(overrides: Partial<BrokenLink> = {}): BrokenLink {
  return {
    linkId: "link-1",
    assetId: "asset-1",
    assetName: "Hallway smoke alarm",
    role: "battery_level",
    haEntityRegistryId: "old-registry",
    haDeviceId: null,
    platformSnapshot: "zha",
    uniqueIdSnapshot: "00:12:4b:00:1c:aa-1-1",
    entityIdSnapshot: "sensor.hallway_smoke_battery",
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateEntity> = {}): CandidateEntity {
  return {
    registryId: "new-registry",
    entityId: "sensor.hallway_smoke_battery_2",
    platform: "zha",
    uniqueId: "00:12:4b:00:1c:aa-1-1",
    deviceId: "device-1",
    name: null,
    ...overrides,
  };
}

describe("suggestRelinks", () => {
  it("matches on platform + unique id and calls it exact", () => {
    const [suggestion] = suggestRelinks([link()], [candidate()]);
    expect(suggestion).toBeDefined();
    expect(suggestion?.registryId).toBe("new-registry");
    expect(suggestion?.confidence).toBe("exact");
    expect(suggestion?.reason).toContain("re-paired");
  });

  it("offers nothing when two live entries share the same integration id", () => {
    const suggestions = suggestRelinks(
      [link()],
      [candidate({ registryId: "a" }), candidate({ registryId: "b", entityId: "sensor.other" })],
    );
    expect(suggestions).toEqual([]);
  });

  it("falls back to the entity id but marks it as only likely", () => {
    const [suggestion] = suggestRelinks(
      [link({ uniqueIdSnapshot: null })],
      [candidate({ entityId: "sensor.hallway_smoke_battery", uniqueId: null })],
    );
    expect(suggestion?.confidence).toBe("likely");
    expect(suggestion?.reason).toContain("renameable");
  });

  it("prefers the integration id over the entity id when both could match", () => {
    const [suggestion] = suggestRelinks(
      [link()],
      [
        candidate({ registryId: "by-unique" }),
        candidate({
          registryId: "by-entity-id",
          entityId: "sensor.hallway_smoke_battery",
          uniqueId: "something-else",
        }),
      ],
    );
    expect(suggestion?.registryId).toBe("by-unique");
    expect(suggestion?.confidence).toBe("exact");
  });

  it("offers nothing when the link carries no snapshots to match on", () => {
    const suggestions = suggestRelinks(
      [link({ platformSnapshot: null, uniqueIdSnapshot: null, entityIdSnapshot: null })],
      [candidate()],
    );
    expect(suggestions).toEqual([]);
  });

  it("offers nothing when there are no candidates", () => {
    expect(suggestRelinks([link()], [])).toEqual([]);
  });

  it("handles several broken links independently", () => {
    const suggestions = suggestRelinks(
      [
        link({ linkId: "l1", uniqueIdSnapshot: "unique-1" }),
        link({ linkId: "l2", uniqueIdSnapshot: "unique-2" }),
        link({ linkId: "l3", uniqueIdSnapshot: "unique-3", entityIdSnapshot: null }),
      ],
      [
        candidate({ registryId: "r1", uniqueId: "unique-1" }),
        candidate({ registryId: "r2", uniqueId: "unique-2", entityId: "sensor.two" }),
      ],
    );
    expect(suggestions.map((entry) => entry.linkId)).toEqual(["l1", "l2"]);
  });
});

describe("groupSuggestionsByAsset", () => {
  it("groups by asset and sorts by name", () => {
    const suggestions = suggestRelinks(
      [
        link({ linkId: "l1", assetId: "a2", assetName: "Zebra", uniqueIdSnapshot: "u1" }),
        link({ linkId: "l2", assetId: "a1", assetName: "Aardvark", uniqueIdSnapshot: "u2" }),
        link({ linkId: "l3", assetId: "a1", assetName: "Aardvark", uniqueIdSnapshot: "u3" }),
      ],
      [
        candidate({ registryId: "r1", uniqueId: "u1", entityId: "sensor.one" }),
        candidate({ registryId: "r2", uniqueId: "u2", entityId: "sensor.two" }),
        candidate({ registryId: "r3", uniqueId: "u3", entityId: "sensor.three" }),
      ],
    );
    const groups = groupSuggestionsByAsset(suggestions);
    expect(groups.map((group) => group.assetName)).toEqual(["Aardvark", "Zebra"]);
    expect(groups[0]?.suggestions).toHaveLength(2);
  });

  it("returns nothing for nothing", () => {
    expect(groupSuggestionsByAsset([])).toEqual([]);
  });
});
