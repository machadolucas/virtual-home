import type { StateCreator } from "zustand";
import { normalizeHex } from "@/house/model/colorPlan";
import type { SurfaceId } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export type SaveState = "clean" | "saving" | "error" | "local";

export interface ColorSlice {
  overrides: Record<SurfaceId, string>;
  dirty: SurfaceId[];
  saveState: SaveState;
  saveError: string | null;

  setOverride(surfaceId: SurfaceId, hex: string): void;
  clearOverride(surfaceId: SurfaceId): void;
  clearOverrides(surfaceIds: readonly SurfaceId[]): void;
  hydrateOverrides(overrides: Record<SurfaceId, string>): void;
  setSaveState(state: SaveState, error?: string | null): void;
  clearDirty(surfaceIds: readonly SurfaceId[]): void;
}

export const createColorSlice: StateCreator<HouseStore, Mutators, [], ColorSlice> = (set) => ({
  overrides: {},
  dirty: [],
  saveState: "clean",
  saveError: null,

  setOverride: (surfaceId, hex) =>
    set((s) => {
      let normalized: string;
      try {
        normalized = normalizeHex(hex);
      } catch {
        return {};
      }
      if (s.overrides[surfaceId] === normalized) return {};
      return {
        overrides: { ...s.overrides, [surfaceId]: normalized },
        dirty: s.dirty.includes(surfaceId) ? s.dirty : [...s.dirty, surfaceId],
      };
    }),

  clearOverride: (surfaceId) =>
    set((s) => {
      if (!(surfaceId in s.overrides)) return {};
      const next = { ...s.overrides };
      delete next[surfaceId];
      return {
        overrides: next,
        dirty: s.dirty.includes(surfaceId) ? s.dirty : [...s.dirty, surfaceId],
      };
    }),

  clearOverrides: (surfaceIds) =>
    set((s) => {
      const next = { ...s.overrides };
      const dirty = new Set(s.dirty);
      let changed = false;
      for (const id of surfaceIds) {
        if (id in next) {
          delete next[id];
          dirty.add(id);
          changed = true;
        }
      }
      return changed ? { overrides: next, dirty: [...dirty] } : {};
    }),

  hydrateOverrides: (overrides) => set({ overrides, dirty: [] }),

  setSaveState: (saveState, saveError = null) => set({ saveState, saveError }),

  clearDirty: (surfaceIds) =>
    set((s) => ({ dirty: s.dirty.filter((id) => !surfaceIds.includes(id)) })),
});
