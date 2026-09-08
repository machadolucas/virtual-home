import type { StateCreator } from "zustand";
import { DEFAULT_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { DOLLHOUSE_PRESET, OVERVIEW_PRESET } from "@/house/model/visibilityPlan";
import type { FloorId, Projection, VerticalCut, ViewMode } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface ViewSlice {
  viewMode: ViewMode;
  activeFloorId: FloorId | null;
  projection: Projection;
  cut: { enabled: boolean; y: number; vertical: VerticalCut | null };
  explode: { enabled: boolean; gap: number; locked: boolean };
  roofVisible: boolean;
  ceilingsVisible: boolean;
  edgesVisible: boolean;
  performanceMode: boolean;

  setViewMode(mode: ViewMode): void;
  isolateFloor(floorId: FloorId | null): void;
  setProjection(projection: Projection): void;
  setCut(cut: Partial<ViewSlice["cut"]>): void;
  nudgeCut(delta: number): void;
  setExplode(explode: Partial<ViewSlice["explode"]>): void;
  setRoofVisible(v: boolean): void;
  setCeilingsVisible(v: boolean): void;
  setEdgesVisible(v: boolean): void;
  setPerformanceMode(v: boolean): void;
  /** Presets are *store writes*, so the toolbar checkboxes stay in sync by construction. */
  applyDollhouse(): void;
  applyOverview(): void;
}

export const initialView = {
  viewMode: "overview" as ViewMode,
  activeFloorId: null,
  projection: "perspective" as Projection,
  cut: { enabled: false, y: 1.5, vertical: null as VerticalCut | null },
  explode: { enabled: false, gap: DEFAULT_EXPLODE_GAP, locked: false },
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  performanceMode: false,
};

export const createViewSlice: StateCreator<HouseStore, Mutators, [], ViewSlice> = (set) => ({
  ...initialView,

  setViewMode: (viewMode) => set({ viewMode }),

  isolateFloor: (activeFloorId) =>
    set(() =>
      activeFloorId
        ? { activeFloorId, viewMode: "floor" as ViewMode }
        : { activeFloorId: null, viewMode: "overview" as ViewMode },
    ),

  setProjection: (projection) => set({ projection }),

  setCut: (cut) => set((s) => ({ cut: { ...s.cut, ...cut } })),

  nudgeCut: (delta) =>
    set((s) => ({
      cut: { ...s.cut, enabled: true, y: Math.round((s.cut.y + delta) * 1000) / 1000 },
    })),

  setExplode: (explode) =>
    set((s) => (s.explode.locked && explode.gap !== 0 ? {} : { explode: { ...s.explode, ...explode } })),

  setRoofVisible: (roofVisible) => set({ roofVisible }),
  setCeilingsVisible: (ceilingsVisible) => set({ ceilingsVisible }),
  setEdgesVisible: (edgesVisible) => set({ edgesVisible }),
  setPerformanceMode: (performanceMode) => set({ performanceMode }),

  applyDollhouse: () => set({ ...DOLLHOUSE_PRESET, activeFloorId: null }),

  applyOverview: () =>
    set((s) => ({
      ...OVERVIEW_PRESET,
      cut: { ...s.cut, enabled: false, vertical: null },
      explode: { ...s.explode, enabled: false },
    })),
});
