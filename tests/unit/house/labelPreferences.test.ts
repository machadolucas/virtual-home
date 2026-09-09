import { describe, expect, it } from "vitest";
import {
  displayNameForNode,
  defaultRoomLabelVisibility,
  EMPTY_LABEL_PREFERENCES,
  inferFloorDisplayNames,
  labelVisibleForNode,
} from "@/house/model/labelPreferences";
import { createMemoryDataApi } from "@/house/store/dataApi";

describe("house label preferences", () => {
  it("uses a resolved household name without changing the semantic model id", () => {
    const preferences = {
      ...EMPTY_LABEL_PREFERENCES,
      names: { "r-upper-office": "Lucas Office" },
    };
    expect(displayNameForNode("r-upper-office", "L Office", preferences)).toBe("Lucas Office");
    expect(displayNameForNode("r-kitchen", "Kitchen", preferences)).toBe("Kitchen");
  });

  it("treats only an explicit false visibility as hidden", () => {
    const preferences = {
      ...EMPTY_LABEL_PREFERENCES,
      visibility: { "r-attic": false, "r-office": true },
    };
    expect(labelVisibleForNode("r-attic", preferences)).toBe(false);
    expect(labelVisibleForNode("r-office", preferences)).toBe(true);
    expect(labelVisibleForNode("r-kitchen", preferences)).toBe(true);
    expect(labelVisibleForNode("r-unlisted-attic", preferences, false)).toBe(false);
  });

  it("hides semantically closed rooms without relying on private model names", () => {
    expect(
      defaultRoomLabelVisibility([
        { id: "r-attic", kind: "attic" },
        { id: "r-void", kind: "void" },
        { id: "r-closet", kind: "closet" },
        { id: "r-office", kind: "room" },
      ]),
    ).toEqual({ "r-attic": false, "r-void": false });
  });

  it("round-trips and resets session preferences through the data API seam", async () => {
    const api = createMemoryDataApi({
      labelPreferences: {
        names: { "r-office": "Lucas Office" },
        visibility: { "r-attic": false },
        customNames: {},
        customVisibility: {},
      },
    });
    const saved = await api.saveLabelPreference("house", "fingerprint", {
      nodeId: "r-office",
      displayName: "Work room",
      visible: false,
    });
    expect(saved.names["r-office"]).toBe("Work room");
    expect(saved.customNames["r-office"]).toBe("Work room");
    expect(saved.visibility["r-office"]).toBe(false);

    const reset = await api.saveLabelPreference("house", "fingerprint", {
      nodeId: "r-office",
      displayName: null,
      visible: null,
    });
    expect(reset.names["r-office"]).toBeUndefined();
    expect(reset.customNames["r-office"]).toBeUndefined();
    expect(reset.visibility["r-office"]).toBeUndefined();
  });

  it("infers a floor name only when confirmed room areas agree", () => {
    const floors = new Map([
      ["ha-down", "Downstairs"],
      ["ha-up", "Upstairs"],
    ]);
    expect(
      inferFloorDisplayNames(
        [
          { floorNodeId: "f-ground", haFloorId: "ha-down" },
          { floorNodeId: "f-ground", haFloorId: "ha-down" },
          { floorNodeId: "f-ambiguous", haFloorId: "ha-down" },
          { floorNodeId: "f-ambiguous", haFloorId: "ha-up" },
        ],
        floors,
      ),
    ).toEqual({ "f-ground": "Downstairs" });

    expect(
      inferFloorDisplayNames(
        [{ floorNodeId: "f-ground", haFloorId: "ha-down" }],
        floors,
        new Set(["f-ground"]),
      ),
    ).toEqual({});
  });
});
