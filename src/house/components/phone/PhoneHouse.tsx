"use client";
/**
 * Phone layout: single column, the 3D view present but **demoted and simplified**.
 *
 * Simplifications (§12), all of them decisions rather than accidents:
 *  - the structure and scan layers are neither loaded nor offered (`planTiers` already drops them
 *    on a phone), so the layer list here is short on purpose;
 *  - drag placement is not offered — the numeric sheet is the editor;
 *  - the exploded view is unavailable: it needs precise orbiting to be legible;
 *  - the 2D route editors are read-only.
 *
 * The order is task-first: header, Locate card, then the written note and the photo. A user
 * finishing an ordinary maintenance job never has to touch the canvas.
 */
import {
  House,
  Armchair,
  Box,
  Layers3,
  EyeOff,
  PanelBottom,
  PanelTop,
  Sun,
  Tags,
  type LucideIcon,
} from "lucide-react";
import { displayNameForNode } from "@/house/model/labelPreferences";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { DaylightControl } from "../DaylightControl";
import { DetailedLightControl } from "../DetailedLightControl";
import { HouseCanvasLazy } from "../HouseCanvasLazy";
import { HouseErrorBoundary } from "../HouseErrorBoundary";
import { PlacementEditor } from "../edit/PlacementEditor";
import { Inspector } from "../inspector/Inspector";
import { DownloadImageButton } from "../DownloadImageButton";
import { LocateSheet } from "./LocateSheet";
import { Switch } from "@/ui";
import { FurnishingsPanel } from "../furnishings/FurnishingsPanel";

export function PhoneHouse() {
  const runtime = useHouseRuntime();
  const { index, activeFloorId, selection, background, placements, editing, announcement, labelPreferences, areaLabelsVisible } =
    useHouseStore(
    useShallow((s) => ({
      index: s.index,
      activeFloorId: s.activeFloorId,
      selection: s.selection,
      background: s.background,
      placements: s.placements,
      editing: s.editing !== null,
      announcement: s.announcement,
      labelPreferences: s.labelPreferences,
      areaLabelsVisible: s.areaLabelsVisible,
    })),
  );
  const isolateFloor = useHouseStore((s) => s.isolateFloor);
  const equipmentOcclusion = useHouseStore((s) => s.equipmentOcclusion);
  const setEquipmentOcclusion = useHouseStore((s) => s.setEquipmentOcclusion);
  const equipmentVisible = useHouseStore((s) => s.layers.equipment);
  const furnishingsVisible = useHouseStore((s) => s.layers.furnishings);
  const setLayer = useHouseStore((s) => s.setLayer);
  const setAreaLabelsVisible = useHouseStore((s) => s.setAreaLabelsVisible);

  const setProjection = useHouseStore((s) => s.setProjection);
  const setViewMode = useHouseStore((s) => s.setViewMode);
  const equipmentId = selection?.kind === "equipment" ? selection.id : null;
  const floorEquipment = placements.filter(
    (p) => !activeFloorId || p.floorId === activeFloorId,
  );

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto bg-paper p-3">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-semibold text-ink">
          {index?.manifest.name ?? "House"}
        </h1>
        <p className="text-xs text-ink-3">
          The plan is context. The written note and the photo are what find the thing.
        </p>
      </header>

      <nav aria-label="Floors" className="flex flex-wrap gap-1">
        <FloorChip
          icon={House}
          label="All"
          active={activeFloorId === null}
          onClick={() => isolateFloor(null)}
        />
        {[...(index?.buildings.values() ?? [])].map((building) => (
          <fieldset key={building.id} className="min-w-0">
            <legend className="px-1 text-[11px] text-ink-3">
              {displayNameForNode(building.id, building.name, labelPreferences)}
            </legend>
            <div className="flex flex-wrap gap-1">
              {(index?.floorsByBuilding.get(building.id) ?? [])
                .slice()
                .sort((a, b) => a.elevation - b.elevation)
                .map((floor, floorIndex, floors) => (
                <FloorChip
                  key={floor.id}
                  icon={
                    floors.length === 1
                      ? Layers3
                      : floorIndex === 0
                        ? PanelBottom
                        : floorIndex === floors.length - 1
                          ? PanelTop
                          : Layers3
                  }
                  label={displayNameForNode(floor.id, floor.name, labelPreferences)}
                  active={activeFloorId === floor.id}
                  onClick={() => {
                    setProjection("perspective");
                    isolateFloor(floor.id);
                    setViewMode("floor");
                    void runtime.camera?.frameFloor(floor.id);
                  }}
                />
                ))}
            </div>
          </fieldset>
        ))}
      </nav>

      <div className="relative h-64 shrink-0">
        <HouseErrorBoundary>
          <HouseCanvasLazy background={background} />
        </HouseErrorBoundary>
      </div>

      <div className="flex justify-end"><DownloadImageButton /></div>

      <Switch checked={equipmentVisible} onCheckedChange={(on) => setLayer("equipment", on)} controlPosition="start" label={<span className="inline-flex items-center gap-1.5"><Box className="size-4" aria-hidden="true" />Show equipment</span>} />

      <Switch checked={furnishingsVisible} onCheckedChange={(on) => setLayer("furnishings", on)} controlPosition="start" label={<span className="inline-flex items-center gap-1.5"><Armchair className="size-4" aria-hidden="true" />Show furniture</span>} />

      <Switch checked={equipmentOcclusion} onCheckedChange={setEquipmentOcclusion} controlPosition="start" label={<span className="inline-flex items-center gap-1.5"><EyeOff className="size-4" aria-hidden="true" />Hide occluded equipment</span>} />

      <Switch
        checked={areaLabelsVisible}
        onCheckedChange={setAreaLabelsVisible}
        controlPosition="start"
        label={
          <span className="inline-flex items-center gap-1.5">
            <Tags aria-hidden="true" className="size-4 text-ink-3" />
            Area labels
          </span>
        }
        className="min-h-11 rounded-lg border border-line bg-surface px-3 text-sm"
      />

      <details className="rounded-lg border border-line bg-surface">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm font-medium text-ink">
          <Sun aria-hidden="true" className="size-4 text-ink-3" />
          Rendering
        </summary>
        <div className="flex flex-col gap-4 border-t border-line p-3">
          <DetailedLightControl />
          <DaylightControl />
        </div>
      </details>

      <FurnishingsPanel />

      {equipmentId ? <LocateSheet placementId={equipmentId} /> : null}

      <section className="rounded-lg border border-line bg-surface p-3">
        {editing ? <PlacementEditor /> : <Inspector />}
      </section>

      <section className="rounded-lg border border-line bg-surface p-3">
        <h2 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Equipment on this floor
        </h2>
        {floorEquipment.length === 0 ? (
          <p className="mt-1 text-sm text-ink-3">Nothing placed here yet.</p>
        ) : (
          <ul className="mt-1 flex flex-col">
            {floorEquipment.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => runtime.select({ kind: "equipment", id: p.id })}
                  className="min-h-11 w-full truncate text-left text-sm text-ink"
                >
                  {p.name}
                  <span className="ml-1 text-xs text-ink-3">
                    {p.roomId ? (index?.rooms.get(p.roomId)?.name ?? p.roomId) : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}

function FloorChip({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-medium ${
        active
          ? "border-accent bg-accent text-on-accent"
          : "border-line bg-surface text-ink"
      }`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {label}
    </button>
  );
}
