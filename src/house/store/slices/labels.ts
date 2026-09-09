import type { StateCreator } from "zustand";
import {
  EMPTY_LABEL_PREFERENCES,
  type HouseLabelPreferences,
} from "@/house/model/labelPreferences";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface LabelSlice {
  labelPreferences: HouseLabelPreferences;
  /** A view choice, intentionally session-scoped like the other layer switches. */
  areaLabelsVisible: boolean;
  equipmentOcclusion: boolean;
  setEquipmentOcclusion(enabled: boolean): void;

  hydrateLabelPreferences(preferences: HouseLabelPreferences): void;
  setAreaLabelsVisible(visible: boolean): void;
  setLabelPreference(
    nodeId: string,
    preference: { displayName: string | null; visible: boolean | null },
  ): void;
}

export const createLabelSlice: StateCreator<HouseStore, Mutators, [], LabelSlice> = (set) => ({
  labelPreferences: EMPTY_LABEL_PREFERENCES,
  areaLabelsVisible: true,
  equipmentOcclusion: true,
  setEquipmentOcclusion: (equipmentOcclusion) => set({ equipmentOcclusion }),

  hydrateLabelPreferences: (labelPreferences) => set({ labelPreferences }),
  setAreaLabelsVisible: (areaLabelsVisible) => set({ areaLabelsVisible }),
  setLabelPreference: (nodeId, preference) =>
    set((state) => {
      const next: HouseLabelPreferences = {
        names: { ...state.labelPreferences.names },
        visibility: { ...state.labelPreferences.visibility },
        customNames: { ...state.labelPreferences.customNames },
        customVisibility: { ...state.labelPreferences.customVisibility },
      };
      if (preference.displayName === null) delete next.customNames[nodeId];
      else next.customNames[nodeId] = preference.displayName;
      if (preference.visible === null) delete next.customVisibility[nodeId];
      else next.customVisibility[nodeId] = preference.visible;
      return { labelPreferences: next };
    }),
});
