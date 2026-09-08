import type { StateCreator } from "zustand";
import { DEFAULT_LAYERS, type LayerId } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface LayerSlice {
  layers: Record<LayerId, boolean>;
  /** ISO date; `null` = today. Filters `removed` routes and renovation history. */
  renovationDate: string | null;

  setLayer(id: LayerId, on: boolean): void;
  toggleLayer(id: LayerId): void;
  setRenovationDate(date: string | null): void;
}

export const createLayerSlice: StateCreator<HouseStore, Mutators, [], LayerSlice> = (set) => ({
  layers: { ...DEFAULT_LAYERS },
  renovationDate: null,
  setLayer: (id, on) => set((s) => ({ layers: { ...s.layers, [id]: on } })),
  toggleLayer: (id) => set((s) => ({ layers: { ...s.layers, [id]: !s.layers[id] } })),
  setRenovationDate: (renovationDate) => set({ renovationDate }),
});
