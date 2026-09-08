"use client";
/**
 * View controls. Every button is a **store write**, never a direct scene mutation — which is why
 * the checkboxes can never desynchronise from the scene: the resolver derives the scene from these
 * fields, in full, on every change.
 */
import { HouseBackgroundControl } from "@/features/settings/HouseBackgroundControl";
import { ALL_LAYERS, type LayerId } from "@/house/model/types";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";

// Stable empty result: a selector that returns a fresh array makes useSyncExternalStore loop.
const NO_FLOORS: readonly string[] = [];

const LAYER_LABELS: Record<LayerId, string> = {
  structure: "Structure (trusses, footings)",
  scanReferences: "Scan reference",
  yard: "Yard",
  outdoor: "Terrace and steps",
  equipment: "Equipment",
  routes: "Infrastructure routes",
  annotations: "Notes",
};

export function ViewToolbar() {
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
  const setViewMode = useHouseStore((s) => s.setViewMode);
  const floors = useHouseStore((s) => s.index?.floorOrder ?? NO_FLOORS);
  const floorNames = useHouseStore((s) => s.index?.floors ?? null);
  const isolateFloor = useHouseStore((s) => s.isolateFloor);

  const planFor = (floorId: string) => {
    setViewMode("plan");
    setProjection("ortho");
    isolateFloor(floorId);
    void runtime.camera?.planFor(floorId);
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Floors
        </legend>
        <div className="flex flex-wrap gap-1">
          <ToolbarButton
            pressed={state.activeFloorId === null}
            onClick={() => {
              isolateFloor(null);
              void runtime.camera?.overview();
            }}
          >
            All
          </ToolbarButton>
          {floors.map((floorId) => (
            <ToolbarButton
              key={floorId}
              pressed={state.activeFloorId === floorId}
              onClick={() => {
                isolateFloor(floorId);
                void runtime.camera?.frameFloor(floorId);
              }}
            >
              {floorNames?.get(floorId)?.name ?? floorId}
            </ToolbarButton>
          ))}
        </div>
        {state.activeFloorId ? (
          <ToolbarButton pressed={state.viewMode === "plan"} onClick={() => planFor(state.activeFloorId as string)}>
            Plan view (P)
          </ToolbarButton>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">
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
          <ToolbarButton onClick={applyDollhouse}>Dollhouse (D)</ToolbarButton>
          <ToolbarButton
            pressed={state.projection === "ortho"}
            onClick={() => setProjection(state.projection === "ortho" ? "perspective" : "ortho")}
          >
            Orthographic
          </ToolbarButton>
        </div>
      </fieldset>

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
        {ALL_LAYERS.map((layer) => (
          <Toggle
            key={layer}
            checked={state.layers[layer]}
            onChange={(on) => setLayer(layer, on)}
            label={LAYER_LABELS[layer]}
          />
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Rendering
        </legend>
        <Toggle
          checked={state.performanceMode}
          onChange={setPerformanceMode}
          label="Performance mode (pixel ratio 1)"
        />
        <p className="mt-2 text-xs font-medium text-ink-2">Background</p>
        <HouseBackgroundControl value={state.background} onPreview={setBackground} />
      </fieldset>
    </div>
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
    <label className="flex min-h-8 items-center gap-2 text-xs text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}
