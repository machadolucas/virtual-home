"use client";
/**
 * View controls. Every button is a **store write**, never a direct scene mutation — which is why
 * the checkboxes can never desynchronise from the scene: the resolver derives the scene from these
 * fields, in full, on every change.
 */
import { HouseBackgroundControl } from "@/features/settings/HouseBackgroundControl";
import { Eye } from "lucide-react";
import { ALL_LAYERS, type LayerId, type WallMode } from "@/house/model/types";
import { Switch } from "@/ui";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";

const LAYER_LABELS: Record<LayerId, string> = {
  structure: "Structure (trusses, footings)",
  scanReferences: "Scan reference",
  yard: "Yard",
  outdoor: "Terrace and steps",
  equipment: "Equipment",
  routes: "Infrastructure routes",
  annotations: "Notes",
};

export function ViewToolbar({ section }: { section: "view" | "layers" | "rendering" | "presets" }) {
  const runtime = useHouseRuntime();
  const state = useHouseStore(
    useShallow((s) => ({
      viewMode: s.viewMode,
      projection: s.projection,
      activeFloorId: s.activeFloorId,
      roofVisible: s.roofVisible,
      ceilingsVisible: s.ceilingsVisible,
      edgesVisible: s.edgesVisible,
      performanceMode: s.performanceMode,
      background: s.background,
      layers: s.layers,
      explodeGap: s.explode.gap,
      wallMode: s.wallMode,
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

  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      {section === "view" ? (
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">Walls</legend>
        <div role="radiogroup" aria-label="Wall display" className="grid grid-cols-2 gap-1">
          {WALL_MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              role="radio"
              aria-checked={state.wallMode === mode.value}
              onClick={() => setWallMode(mode.value)}
              className={`min-h-8 rounded-md border px-2 text-xs font-medium transition-colors ${
                state.wallMode === mode.value
                  ? "border-accent bg-accent-soft text-accent-text"
                  : "border-line bg-surface text-ink hover:bg-surface-3"
              }`}
            >
              {mode.label}
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
            Overview (R)
          </ToolbarButton>
          <ToolbarButton onClick={applyDollhouse} title="Hide the roof and ceilings, then cut walls around the selected room">
            <span className="inline-flex items-center gap-1"><Eye aria-hidden="true" className="size-3.5" />Show inside (D)</span>
          </ToolbarButton>
          <ToolbarButton
            pressed={state.projection === "ortho"}
            onClick={() => setProjection(state.projection === "ortho" ? "perspective" : "ortho")}
          >
            Orthographic
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
        <Toggle checked={state.roofVisible} onChange={setRoofVisible} label="Roof (H)" />
        <Toggle checked={state.ceilingsVisible} onChange={setCeilingsVisible} label="Ceilings (G)" />
        <Toggle checked={state.edgesVisible} onChange={setEdgesVisible} label="Architectural edges (B)" />
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
      <fieldset className="grid min-w-0 flex-1 grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(12rem,0.7fr)_minmax(16rem,1.3fr)]">
        <legend className="sr-only">
          Rendering
        </legend>
        <Toggle checked={state.performanceMode} onChange={setPerformanceMode} label="Performance mode (pixel ratio 1)" />
        <div className="min-w-0">
          <p className="mb-2 text-xs font-medium text-ink-2">Background</p>
          <HouseBackgroundControl value={state.background} onPreview={setBackground} />
        </div>
      </fieldset>
      ) : null}
    </div>
  );
}

const WALL_MODES: ReadonlyArray<{ value: WallMode; label: string }> = [
  { value: "cut", label: "All cut" },
  { value: "contextual", label: "Contextual" },
  { value: "up", label: "All up" },
  { value: "closed", label: "All up + roof/ceiling" },
];

/** Compact floor-by-building controls that stay on the model rather than in the bottom drawer. */
export function FloorControls() {
  const runtime = useHouseRuntime();
  const { index, activeFloorId, isolateFloor, setProjection, setViewMode } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      activeFloorId: s.activeFloorId,
      isolateFloor: s.isolateFloor,
      setProjection: s.setProjection,
      setViewMode: s.setViewMode,
    })),
  );
  if (!index) return null;

  const focusFloor = (floorId: string) => {
    setProjection("ortho");
    isolateFloor(floorId);
    setViewMode("plan");
    void runtime.camera?.planFor(floorId);
  };

  return (
    <section
      aria-label="Floor focus"
      className="pointer-events-auto absolute bottom-2 left-2 z-10 max-w-[calc(100%-1rem)] rounded-lg border border-line bg-surface/95 p-1.5 shadow-pop backdrop-blur"
    >
      <div className="flex items-end gap-2 overflow-x-auto">
        <div className="flex flex-col gap-1">
          <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">Property</span>
          <ToolbarButton
            pressed={activeFloorId === null}
            onClick={() => {
              isolateFloor(null);
              void runtime.camera?.overview();
            }}
          >
            All
          </ToolbarButton>
        </div>
        {[...index.buildings.values()].map((building) => (
          <fieldset key={building.id} className="flex shrink-0 flex-col gap-1">
            <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-ink-3">
              {building.name}
            </legend>
            <div className="flex gap-1">
              {(index.floorsByBuilding.get(building.id) ?? [])
                .slice()
                .sort((a, b) => a.elevation - b.elevation)
                .map((floor) => (
                  <ToolbarButton
                    key={floor.id}
                    pressed={activeFloorId === floor.id}
                    title={`Top-down focus on ${floor.name}; other buildings and supporting floors remain visible`}
                    onClick={() => focusFloor(floor.id)}
                  >
                    {floor.name}
                  </ToolbarButton>
                ))}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
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
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
}) {
  return (
    <Switch checked={checked} onCheckedChange={onChange} label={label} className="min-h-8 py-0 text-xs" />
  );
}
