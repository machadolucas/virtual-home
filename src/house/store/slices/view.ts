import type { StateCreator } from "zustand";
import { DEFAULT_HOUSE_BACKGROUND, type HouseBackground } from "@/house/model/background";
import { DEFAULT_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { DOLLHOUSE_PRESET, OVERVIEW_PRESET } from "@/house/model/visibilityPlan";
import type { FloorId, Projection, VerticalCut, ViewMode, WallMode } from "@/house/model/types";
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

export interface IlluminationSettings {
  mode: "live" | "manual" | "studio";
  atMs: number | null;
  latitude: number | null;
  longitude: number | null;
  northDeg: number | null;
  softShadows: boolean;
  intensity: number;
}

export interface ViewSlice {
  illumination: IlluminationSettings;
  setIllumination(settings: Partial<IlluminationSettings>): void;
  viewMode: ViewMode;
  tool: CanvasTool;
  /** True while Space is held: the camera is on loan, whatever the tool says. */
  cameraOverride: boolean;
  activeFloorId: FloorId | null;
  projection: Projection;
  wallMode: WallMode;
  wallModeExplicit: boolean;
  cut: { enabled: boolean; y: number; vertical: VerticalCut | null };
  explode: { enabled: boolean; gap: number; locked: boolean };
  roofVisible: boolean;
  ceilingsVisible: boolean;
  edgesVisible: boolean;
  performanceMode: boolean;
  /** Requested detailed equipment-light budget for this viewer session. */
  detailedLightLimit: number;
  /** Renderer-reported safe ceiling; initialized conservatively until WebGL is ready. */
  detailedLightHardwareMax: number;
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
  setWallMode(mode: WallMode, explicit?: boolean): void;
  setCut(cut: Partial<ViewSlice["cut"]>): void;
  nudgeCut(delta: number): void;
  setExplode(explode: Partial<ViewSlice["explode"]>): void;
  setRoofVisible(v: boolean): void;
  setCeilingsVisible(v: boolean): void;
  setEdgesVisible(v: boolean): void;
  setPerformanceMode(v: boolean): void;
  setDetailedLightLimit(limit: number): void;
  setDetailedLightHardwareMax(limit: number): void;
  setBackground(background: HouseBackground): void;
  /** Presets are *store writes*, so the toolbar checkboxes stay in sync by construction. */
  applyDollhouse(): void;
  applyOverview(): void;
}

export const initialView = {
  illumination: { mode: "live", atMs: null, latitude: null, longitude: null, northDeg: null, softShadows: true, intensity: 1 } as IlluminationSettings,
  viewMode: "overview" as ViewMode,
  tool: "orbit" as CanvasTool,
  cameraOverride: false,
  activeFloorId: null,
  projection: "perspective" as Projection,
  wallMode: "closed" as WallMode,
  wallModeExplicit: false,
  cut: { enabled: false, y: 1.5, vertical: null as VerticalCut | null },
  explode: { enabled: false, gap: DEFAULT_EXPLODE_GAP, locked: false },
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  performanceMode: false,
  detailedLightLimit: 16,
  detailedLightHardwareMax: 12,
  background: DEFAULT_HOUSE_BACKGROUND as HouseBackground,
};

export const createViewSlice: StateCreator<HouseStore, Mutators, [], ViewSlice> = (set) => ({
  ...initialView,

  setIllumination: (settings) => set((s) => ({ illumination: { ...s.illumination, ...settings } })),

  setViewMode: (viewMode) => set({ viewMode }),

  setTool: (tool) => set({ tool }),

  setCameraOverride: (cameraOverride) => set({ cameraOverride }),

  isolateFloor: (activeFloorId) =>
    set(() =>
      activeFloorId
        ? {
            activeFloorId,
            // A floor shortcut becomes the new reveal context. Keeping a previously framed room
            // or piece of equipment here lets that older floor win in `focusContextFor`, so the
            // requested storey can remain hidden even though its floor button is active.
            focusSelection: null,
            // Keep the inspector and shareable URL aligned with the shortcut too. Otherwise an
            // upstairs room remains selected and a reload frames it again over this floor choice.
            selection: { kind: "floor" as const, id: activeFloorId },
            viewMode: "floor" as ViewMode,
            wallMode: "contextual" as WallMode,
            wallModeExplicit: false,
            roofVisible: false,
            ceilingsVisible: false,
          }
        : {
            activeFloorId: null,
            selection: null,
            focusSelection: null,
            viewMode: "overview" as ViewMode,
          },
    ),

  setProjection: (projection) => set({ projection }),

  setWallMode: (wallMode, wallModeExplicit = true) =>
    set({
      wallMode,
      wallModeExplicit,
      roofVisible: wallMode === "closed",
      ceilingsVisible: wallMode === "closed",
    }),

  setCut: (cut) => set((s) => ({ cut: { ...s.cut, ...cut } })),

  nudgeCut: (delta) =>
    set((s) => ({
      cut: { ...s.cut, enabled: true, y: Math.round((s.cut.y + delta) * 1000) / 1000 },
    })),

  setExplode: (explode) =>
    set((s) => (s.explode.locked && explode.gap !== 0 ? {} : { explode: { ...s.explode, ...explode } })),

  setRoofVisible: (visible) =>
    set((s) => ({
      roofVisible: visible,
      wallMode: visible && s.ceilingsVisible ? "closed" : s.wallMode === "closed" ? "up" : s.wallMode,
      wallModeExplicit: true,
    })),
  setCeilingsVisible: (visible) =>
    set((s) => ({
      ceilingsVisible: visible,
      wallMode: visible && s.roofVisible ? "closed" : s.wallMode === "closed" ? "up" : s.wallMode,
      wallModeExplicit: true,
    })),
  setEdgesVisible: (edgesVisible) => set({ edgesVisible }),
  setPerformanceMode: (performanceMode) => set({ performanceMode }),
  setDetailedLightLimit: (detailedLightLimit) =>
    set({ detailedLightLimit: boundedLightCount(detailedLightLimit) }),
  setDetailedLightHardwareMax: (detailedLightHardwareMax) =>
    set({ detailedLightHardwareMax: boundedLightCount(detailedLightHardwareMax) }),
  setBackground: (background) => set({ background }),

  applyDollhouse: () => set({ ...DOLLHOUSE_PRESET, wallMode: "contextual", wallModeExplicit: true, activeFloorId: null }),

  applyOverview: () =>
    set((s) => ({
      ...OVERVIEW_PRESET,
      wallMode: "closed",
      wallModeExplicit: false,
      focusSelection: null,
      cut: { ...s.cut, enabled: false, vertical: null },
      explode: { ...s.explode, enabled: false },
    })),
});

/** Keep renderer-facing counts integral and bounded even when a DOM/test caller supplies junk. */
export function boundedLightCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(64, Math.max(0, Math.round(value)));
}
