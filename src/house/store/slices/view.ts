import type { StateCreator } from "zustand";
import { DEFAULT_HOUSE_BACKGROUND, type HouseBackground } from "@/house/model/background";
import { DEFAULT_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { DOLLHOUSE_PRESET, OVERVIEW_PRESET } from "@/house/model/visibilityPlan";
import type { FloorId, Projection, VerticalCut, ViewMode } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

/**
 * Which pointer gesture the canvas is in — the "tool" in the Photoshop sense.
 *
 * It exists because one left-drag cannot mean two things. With the camera always on the left
 * button, dragging a marker orbited the house at the same time: `camera-controls` captures the
 * gesture on `pointerdown`, so flipping `controls.enabled` inside the app's own handler was always
 * too late. The mode decides *before* the gesture starts.
 *
 *  - `orbit`  — left-drag moves the camera. The default, and what a first-time visitor expects.
 *  - `select` — left-drag does nothing; clicks pick. For trackpads, where an accidental 3 px drag
 *               used to spin the house instead of selecting the thing under the cursor.
 *  - `place`  — the camera is locked and the pointer positions the thing being placed.
 *
 * Holding **Space** temporarily gives the camera back in every mode, so no tool is a dead end.
 */
export const CANVAS_TOOLS = ["orbit", "select", "place"] as const;
export type CanvasTool = (typeof CANVAS_TOOLS)[number];

export interface ViewSlice {
  viewMode: ViewMode;
  tool: CanvasTool;
  /** True while Space is held: the camera is on loan, whatever the tool says. */
  cameraOverride: boolean;
  activeFloorId: FloorId | null;
  projection: Projection;
  cut: { enabled: boolean; y: number; vertical: VerticalCut | null };
  explode: { enabled: boolean; gap: number; locked: boolean };
  roofVisible: boolean;
  ceilingsVisible: boolean;
  edgesVisible: boolean;
  performanceMode: boolean;
  /**
   * The 3D background. Household-level and persisted, but held here so the control can be
   * optimistic: the canvas host repaints on the keystroke and the write reverts it on failure.
   */
  background: HouseBackground;

  setViewMode(mode: ViewMode): void;
  setTool(tool: CanvasTool): void;
  setCameraOverride(held: boolean): void;
  isolateFloor(floorId: FloorId | null): void;
  setProjection(projection: Projection): void;
  setCut(cut: Partial<ViewSlice["cut"]>): void;
  nudgeCut(delta: number): void;
  setExplode(explode: Partial<ViewSlice["explode"]>): void;
  setRoofVisible(v: boolean): void;
  setCeilingsVisible(v: boolean): void;
  setEdgesVisible(v: boolean): void;
  setPerformanceMode(v: boolean): void;
  setBackground(background: HouseBackground): void;
  /** Presets are *store writes*, so the toolbar checkboxes stay in sync by construction. */
  applyDollhouse(): void;
  applyOverview(): void;
}

export const initialView = {
  viewMode: "overview" as ViewMode,
  tool: "orbit" as CanvasTool,
  cameraOverride: false,
  activeFloorId: null,
  projection: "perspective" as Projection,
  cut: { enabled: false, y: 1.5, vertical: null as VerticalCut | null },
  explode: { enabled: false, gap: DEFAULT_EXPLODE_GAP, locked: false },
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  performanceMode: false,
  background: DEFAULT_HOUSE_BACKGROUND as HouseBackground,
};

export const createViewSlice: StateCreator<HouseStore, Mutators, [], ViewSlice> = (set) => ({
  ...initialView,

  setViewMode: (viewMode) => set({ viewMode }),

  setTool: (tool) => set({ tool }),

  setCameraOverride: (cameraOverride) => set({ cameraOverride }),

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
  setBackground: (background) => set({ background }),

  applyDollhouse: () => set({ ...DOLLHOUSE_PRESET, activeFloorId: null }),

  applyOverview: () =>
    set((s) => ({
      ...OVERVIEW_PRESET,
      cut: { ...s.cut, enabled: false, vertical: null },
      explode: { ...s.explode, enabled: false },
    })),
});
