"use client";
/**
 * View controls. Every button is a **store write**, never a direct scene mutation — which is why
 * the switches can never desynchronise from the scene: the resolver derives the scene from these
 * fields, in full, on every change.
 */
import { HouseBackgroundControl } from "@/features/settings/HouseBackgroundControl";
import {
  BetweenHorizontalEnd,
  Box,
  BrickWall,
  Building2,
  Eye,
  Gauge,
  House,
  Layers3,
  Map,
  PanelBottom,
  PanelTop,
  PanelsTopLeft,
  Route,
  RotateCcw,
  ScanLine,
  StickyNote,
  Tags,
  Trees,
  type LucideIcon,
} from "lucide-react";
import { ALL_LAYERS, type LayerId, type WallMode } from "@/house/model/types";
import { displayNameForNode } from "@/house/model/labelPreferences";
import { Switch } from "@/ui";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { DaylightControl } from "./DaylightControl";

const LAYER_LABELS: Record<LayerId, string> = {
  structure: "Structure (trusses, footings)",
  scanReferences: "Scan reference",
  yard: "Yard",
  outdoor: "Terrace and steps",
  equipment: "Equipment",
  routes: "Infrastructure routes",
  annotations: "Notes",
};

const LAYER_ICONS: Record<LayerId, LucideIcon> = {
  structure: Building2,
  scanReferences: ScanLine,
  yard: Trees,
  outdoor: Map,
  equipment: Box,
  routes: Route,
  annotations: StickyNote,
};

export function ViewToolbar({ section }: { section: "view" | "layers" | "rendering" | "presets" }) {
  const runtime = useHouseRuntime();
  const state = useHouseStore(
    useShallow((s) => ({
      projection: s.projection,
      roofVisible: s.roofVisible,
      ceilingsVisible: s.ceilingsVisible,
      edgesVisible: s.edgesVisible,
      performanceMode: s.performanceMode,
      background: s.background,
      layers: s.layers,
      explodeGap: s.explode.gap,
      wallMode: s.wallMode,
      areaLabelsVisible: s.areaLabelsVisible,
    })),
  );
  const setRoofVisible = useHouseStore((s) => s.setRoofVisible);
  const setCeilingsVisible = useHouseStore((s) => s.setCeilingsVisible);
  const setEdgesVisible = useHouseStore((s) => s.setEdgesVisible);
  const setPerformanceMode = useHouseStore((s) => s.setPerformanceMode);
  const setBackground = useHouseStore((s) => s.setBackground);
  const setLayer = useHouseStore((s) => s.setLayer);
  const applyDollhouse = useHouseStore((s) => s.applyDollhouse);
  const applyOverview = useHouseStore((s) => s.applyOverview);
  const setProjection = useHouseStore((s) => s.setProjection);
  const setWallMode = useHouseStore((s) => s.setWallMode);
  const setAreaLabelsVisible = useHouseStore((s) => s.setAreaLabelsVisible);

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      {section === "view" ? (
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">Walls</legend>
        <div role="radiogroup" aria-label="Wall display" className="flex flex-wrap gap-1">
          {WALL_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={state.wallMode === mode.value}
              onClick={() => setWallMode(mode.value)}
              title={`${mode.label}: ${mode.description}`}
              className={`inline-flex size-11 items-center justify-center rounded-md border transition-colors md:size-8 [&_svg]:size-4 ${
                state.wallMode === mode.value
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-line bg-surface text-ink hover:bg-surface-3"
              }`}
            >
              <mode.icon aria-hidden="true" />
              <span className="sr-only">{mode.label}</span>
            </button>
          ))}
        </div>
        <p className="max-w-md text-[11px] leading-4 text-ink-3">
          Contextual lowers the walls between the camera and the selected room as you rotate.
        </p>
      </fieldset>

      ) : null}
      {section === "presets" ? (
      <fieldset className="flex flex-col gap-1">
        <legend className="sr-only">
          Presets
        </legend>
        <div className="flex flex-wrap gap-1">
          <ToolbarButton
            onClick={() => {
              applyOverview();
              void runtime.camera?.overview();
            }}
          >
            <span className="inline-flex items-center gap-1">
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Overview (R)
            </span>
          </ToolbarButton>
          <ToolbarButton onClick={applyDollhouse} title="Hide the roof and ceilings, then cut walls around the selected room">
            <span className="inline-flex items-center gap-1"><Eye aria-hidden="true" className="size-3.5" />Show inside (D)</span>
          </ToolbarButton>
          <ToolbarButton
            pressed={state.projection === "ortho"}
            onClick={() => setProjection(state.projection === "ortho" ? "perspective" : "ortho")}
          >
            <span className="inline-flex items-center gap-1">
              <PanelsTopLeft aria-hidden="true" className="size-3.5" />
              Orthographic
            </span>
          </ToolbarButton>
        </div>
      </fieldset>

      ) : null}
      {section === "layers" ? (
      <>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Show
        </legend>
        <Toggle icon={House} checked={state.roofVisible} onChange={setRoofVisible} label="Roof (H)" />
        <Toggle icon={PanelTop} checked={state.ceilingsVisible} onChange={setCeilingsVisible} label="Ceilings (G)" />
        <Toggle icon={PanelsTopLeft} checked={state.edgesVisible} onChange={setEdgesVisible} label="Architectural edges (B)" />
        <Toggle icon={Tags} checked={state.areaLabelsVisible} onChange={setAreaLabelsVisible} label="Area labels" />
        {state.explodeGap > 0 ? (
          <p className="pl-6 text-[11px] text-ink-3">
            Edges are hidden on the structure assets while exploded — their overlay is one object
            per asset and cannot be split by floor.
          </p>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Layers
        </legend>
        <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
        {ALL_LAYERS.map((layer) => (
          <Toggle
            key={layer}
            icon={LAYER_ICONS[layer]}
            checked={state.layers[layer]}
            onChange={(on) => setLayer(layer, on)}
            label={LAYER_LABELS[layer]}
          />
        ))}
        </div>
      </fieldset>

      </>
      ) : null}
      {section === "rendering" ? (
      <fieldset className="grid min-w-0 flex-1 grid-cols-1 items-start gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <legend className="sr-only">
          Rendering
        </legend>
        <Toggle icon={Gauge} checked={state.performanceMode} onChange={setPerformanceMode} label="Performance mode (pixel ratio 1)" />
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-ink-2">Background</p>
          <HouseBackgroundControl value={state.background} onPreview={setBackground} />
        </div>
        <DaylightControl />
      </fieldset>
      ) : null}
    </div>
  );
}

const WALL_MODES: ReadonlyArray<{
  value: WallMode;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  { value: "cut", label: "All cut", description: "Lower every wall", icon: BetweenHorizontalEnd },
  { value: "contextual", label: "Contextual", description: "Lower walls between the camera and the current focus", icon: Eye },
  { value: "up", label: "All up", description: "Raise every wall with the roof and ceilings hidden", icon: BrickWall },
  { value: "closed", label: "All up + roof/ceiling", description: "Show the complete building shell", icon: House },
];

/** Compact floor-by-building controls that stay on the model rather than in the bottom drawer. */
export function FloorControls() {
  const runtime = useHouseRuntime();
  const { index, activeFloorId, isolateFloor, setProjection, labelPreferences } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      activeFloorId: s.activeFloorId,
      isolateFloor: s.isolateFloor,
      setProjection: s.setProjection,
      labelPreferences: s.labelPreferences,
    })),
  );
  if (!index) return null;

  const focusFloor = (floorId: string) => {
    setProjection("perspective");
    isolateFloor(floorId);
    void runtime.camera?.frameFloor(floorId);
  };

  return (
    <section
      aria-label="Floor focus"
      className="pointer-events-auto absolute bottom-2 left-2 z-10 max-w-[calc(100%-1rem)] rounded-lg border border-line bg-surface/95 p-1 shadow-pop backdrop-blur"
    >
      <div className="flex items-end gap-1.5 overflow-x-auto">
        <div className="flex flex-col items-center gap-1">
          <FloorIconButton
            label="All"
            icon={House}
            pressed={activeFloorId === null}
            onClick={() => {
              setProjection("perspective");
              isolateFloor(null);
              void runtime.camera?.overview();
            }}
          />
          <span className="max-w-16 truncate px-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-3">
            Property
          </span>
        </div>
        {[...index.buildings.values()].map((building) => {
          const buildingName = displayNameForNode(building.id, building.name, labelPreferences);
          return (
            <div
              key={building.id}
              role="group"
              aria-label={buildingName}
              className="flex shrink-0 flex-col items-center gap-1"
            >
            <div className="flex flex-col gap-1">
              {(index.floorsByBuilding.get(building.id) ?? [])
                .slice()
                .sort((a, b) => b.elevation - a.elevation)
                .map((floor, floorIndex, floors) => {
                  const floorName = displayNameForNode(floor.id, floor.name, labelPreferences);
                  return (
                    <FloorIconButton
                      key={floor.id}
                      label={floorName}
                      icon={
                        floors.length === 1
                          ? Layers3
                          : floorIndex === 0
                            ? PanelTop
                            : floorIndex === floors.length - 1
                              ? PanelBottom
                              : Layers3
                      }
                      pressed={activeFloorId === floor.id}
                      title={`Focus ${floorName} in 3D; other buildings and supporting floors remain visible`}
                      onClick={() => focusFloor(floor.id)}
                    />
                  );
                })}
            </div>
            <span
              className="max-w-16 truncate px-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-3"
              title={buildingName}
            >
              {buildingName}
            </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FloorIconButton({
  label,
  icon: Icon,
  onClick,
  pressed,
  title,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  pressed?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      onClick={onClick}
      className={`inline-flex size-11 shrink-0 items-center justify-center rounded-md border transition-colors md:size-8 [&_svg]:size-4 ${
        pressed
          ? "border-accent bg-accent-soft text-accent-text"
          : "border-line bg-surface text-ink hover:bg-surface-3"
      }`}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

export function ToolbarButton({
  children,
  onClick,
  pressed,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      className={`min-h-8 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        pressed
          ? "border-accent bg-accent-soft text-accent-text"
          : "border-line bg-surface text-ink hover:bg-surface-3"
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  icon: Icon,
  checked,
  onChange,
  label,
}: {
  icon: LucideIcon;
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      controlPosition="start"
      label={
        <span className="inline-flex items-center gap-1.5">
          <Icon aria-hidden="true" className="size-3.5 text-ink-3" />
          {label}
        </span>
      }
      className="min-h-8 py-0 text-xs"
    />
  );
}
