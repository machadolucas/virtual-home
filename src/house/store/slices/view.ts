import { DETAILED_LIGHT_SLIDER_MAX, SINGLE_PASS_LIGHT_MAX } from "@/house/model/detailedLightBudget";
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
  /** Stable HA registry identity plus its current renameable event address. */
  outdoorLuxRegistryId: string | null;
  outdoorLuxEntityId: string | null;
  weatherRegistryId: string | null;
  weatherEntityId: string | null;
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
  /** Split detailed equipment lights across conservative shader-sized render passes. */
  detailedLightBatched: boolean;
  /** Requested detailed equipment-light budget, remembered on this device. */
  detailedLightLimit: number;
  /** In batched mode, allocate only as many slots as installed visible light fixtures need. */
  detailedLightAll: boolean;
  /** Conservative shader-resource recommendation; initialized until WebGL is ready. */
  detailedLightHardwareMax: number;
  detailedLightExperimental: boolean;
  detailedLightError: string | null;
  detailedLightCapabilities: { textures: number; varyings: number } | null;
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
  setDetailedLightBatched(enabled: boolean): void;
  setDetailedLightLimit(limit: number): void;
  setDetailedLightAll(enabled: boolean): void;
  setDetailedLightHardwareMax(limit: number): void;
  setDetailedLightExperimental(enabled: boolean): void;
  setDetailedLightError(message: string | null): void;
  setDetailedLightCapabilities(capabilities: { textures: number; varyings: number }): void;
  setBackground(background: HouseBackground): void;
  /** Presets are *store writes*, so the toolbar checkboxes stay in sync by construction. */
  applyDollhouse(): void;
  applyOverview(): void;
}

export const initialView = {
  illumination: {
    mode: "live",
    atMs: null,
    latitude: null,
    longitude: null,
    northDeg: null,
    softShadows: true,
    intensity: 1,
    outdoorLuxRegistryId: null,
    outdoorLuxEntityId: null,
    weatherRegistryId: null,
    weatherEntityId: null,
  } as IlluminationSettings,
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
  detailedLightBatched: true,
  detailedLightLimit: 64,
  detailedLightAll: false,
  detailedLightHardwareMax: 12,
  detailedLightExperimental: false,
  detailedLightError: null as string | null,
  detailedLightCapabilities: null as { textures: number; varyings: number } | null,
  background: DEFAULT_HOUSE_BACKGROUND as HouseBackground,
};

export const createViewSlice: StateCreator<HouseStore, Mutators, [], ViewSlice> = (set) => ({
  ...initialView,

  setIllumination: (settings) => set((s) => ({ illumination: { ...s.illumination, ...settings } })),

  setViewMode: (viewMode) => set({ viewMode }),

  setTool: (tool) => set({ tool, hover: null }),

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
    set((s) => ({
      ...(wallMode === "closed" ? completePropertyView(s) : {}),
      wallMode,
      wallModeExplicit,
      roofVisible: wallMode === "closed",
      ceilingsVisible: wallMode === "closed",
    })),

  setCut: (cut) => set((s) => ({ cut: { ...s.cut, ...cut } })),

  nudgeCut: (delta) =>
    set((s) => ({
      cut: { ...s.cut, enabled: true, y: Math.round((s.cut.y + delta) * 1000) / 1000 },
    })),

  setExplode: (explode) =>
    set((s) => (s.explode.locked && explode.gap !== 0 ? {} : { explode: { ...s.explode, ...explode } })),

  setRoofVisible: (visible) =>
    set((s) => {
      const closesShell = visible && s.ceilingsVisible;
      return {
        ...(visible ? completePropertyView(s) : {}),
        roofVisible: visible,
        wallMode: closesShell ? "closed" : s.wallMode === "closed" ? "up" : s.wallMode,
        wallModeExplicit: true,
      };
    }),
  setCeilingsVisible: (visible) =>
    set((s) => {
      const closesShell = visible && s.roofVisible;
      return {
        ...(closesShell ? completePropertyView(s) : {}),
        ceilingsVisible: visible,
        wallMode: closesShell ? "closed" : s.wallMode === "closed" ? "up" : s.wallMode,
        wallModeExplicit: true,
      };
    }),
  setEdgesVisible: (edgesVisible) => set({ edgesVisible }),
  setPerformanceMode: (performanceMode) => set({ performanceMode }),
  setDetailedLightBatched: (detailedLightBatched) =>
    set((s) =>
      detailedLightBatched
        ? { detailedLightBatched }
        : {
            detailedLightBatched,
            detailedLightLimit: Math.min(s.detailedLightLimit, s.detailedLightHardwareMax),
            detailedLightExperimental: false,
            detailedLightAll: false,
            detailedLightError: null,
          },
    ),
  setDetailedLightAll: (detailedLightAll) => set((s) => ({ detailedLightAll: detailedLightAll && s.detailedLightBatched })),
  setDetailedLightLimit: (detailedLightLimit) =>
    set({ detailedLightLimit: boundedLightCount(detailedLightLimit), detailedLightError: null }),
  setDetailedLightHardwareMax: (detailedLightHardwareMax) =>
    set({ detailedLightHardwareMax: Math.min(SINGLE_PASS_LIGHT_MAX, boundedLightCount(detailedLightHardwareMax)) }),
  setDetailedLightExperimental: (detailedLightExperimental) => set((s) => ({ detailedLightExperimental, detailedLightLimit: Math.min(s.detailedLightLimit, s.detailedLightHardwareMax), detailedLightError: null })),
  setDetailedLightError: (detailedLightError) => set({ detailedLightError }),
  setDetailedLightCapabilities: (detailedLightCapabilities) => set({ detailedLightCapabilities }),
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
  return Math.min(DETAILED_LIGHT_SLIDER_MAX, Math.max(0, Math.round(value)));
}

/** A closed shell represents the complete property, never a roof over a hidden upper floor. */
function completePropertyView(state: HouseStore) {
  return {
    activeFloorId: null,
    focusSelection: null,
    selection: state.selection?.kind === "floor" ? null : state.selection,
    viewMode: "overview" as ViewMode,
  };
}
