"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ListTree, SlidersHorizontal, Info } from "lucide-react";
import { Button, Sheet, Switch } from "@/ui";
import { FullscreenButton } from "@/ui/FullscreenSurface";
import { displayNameForNode } from "@/house/model/labelPreferences";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";
import { InfrastructureKindToggles, RenderingControls, FloorControls, ViewToolbar } from "../ViewToolbar";
import { HouseCanvasLazy } from "../HouseCanvasLazy";
import { HouseErrorBoundary } from "../HouseErrorBoundary";
import { PlacementEditor } from "../edit/PlacementEditor";
import { Inspector } from "../inspector/Inspector";
import { DownloadImageButton } from "../DownloadImageButton";
import { LocateSheet } from "./LocateSheet";
import { FurnishingsPanel, FurnitureInspector } from "../furnishings/FurnishingsPanel";
import { useFurnitureEditor } from "../furnishings/FurnitureEditorContext";
import { PropertyTree } from "../PropertyTree";
import { PlaceableList } from "../edit/PlaceableList";
import { ToolPalette } from "../ToolPalette";
import { CameraNavigation } from "../CameraNavigation";
import { CanvasHints } from "../CanvasHints";
import { ExplodeControl } from "../ExplodeControl";
import { CutawayControl } from "../CutawayControl";

import { RouteEditors } from "../routeEditor/RouteEditors";
import { RouteCreateControl } from "../routeEditor/RouteCreateControl";
import { RoutePath3D } from "../routeEditor/RoutePath3D";

type PhonePanel = "browse" | "details" | "view" | null;

/** A single persistent canvas; sheets keep written locating aids within reach. */
export function PhoneHouse({ workspaceRef }: { workspaceRef: RefObject<HTMLDivElement | null> }) {
  const runtime = useHouseRuntime();
  const browseButton = useRef<HTMLButtonElement>(null);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const viewButton = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<PhonePanel>(null);
  const [query, setQuery] = useState("");
  const furniture = useFurnitureEditor();
  const state = useHouseStore(useShallow((s) => ({
    index: s.index, floor: s.activeFloorId, selection: s.selection, background: s.background,
    placements: s.placements, editing: s.editing !== null, routeDraft: s.routeDraft, saving: s.editorSaving,
    announcement: s.announcement, labels: s.labelPreferences, layers: s.layers,
    equipmentOcclusion: s.equipmentOcclusion, areaLabelsVisible: s.areaLabelsVisible,
  })));
  useEffect(() => runtime.store.subscribe((next, previous) => {
    if ((next.editing && !previous.editing) || (next.routeDraft && !previous.routeDraft) || (next.selection !== previous.selection && next.selection?.kind === "equipment")) setPanel("details");
  }), [runtime]);
  const equipmentId = state.selection?.kind === "equipment" ? state.selection.id : null;
  const floor = state.floor ? state.index?.floors.get(state.floor) : null;
  const name = floor ? displayNameForNode(floor.id, floor.name, state.labels) : "All floors";
  const editOpen = state.editing || !!state.routeDraft || !!furniture.draft;
  const toggleLayer = (key: "equipment" | "furnishings" | "routes", on: boolean) => runtime.store.getState().setLayer(key, on);
  return <div ref={workspaceRef} tabIndex={-1} className="relative flex h-full min-h-0 flex-col bg-paper" data-testid="vh-phone-workspace">
    <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-2 py-1">
      <button type="button" onClick={() => setPanel("browse")} className="min-h-11 min-w-0 flex-1 truncate text-left text-sm font-medium">{state.index?.manifest.name ?? "House"}<span className="block text-xs font-normal text-ink-3">{name}</span></button>
      <FullscreenButton />
    </header>
    <div className="relative min-h-0 flex-1" role="application" tabIndex={0} aria-label="House 3D view">
      <HouseErrorBoundary><HouseCanvasLazy background={state.background} /></HouseErrorBoundary>
      <ToolPalette />
      <div className="pointer-events-auto absolute right-2 top-2 rounded-md border border-line bg-surface/95"><CameraNavigation /></div>
      <CanvasHints compact />
      {state.routeDraft ? <RoutePath3D /> : null}
    </div>
    <nav aria-label="House tools" className="grid shrink-0 grid-cols-3 gap-1 border-t border-line bg-surface px-2 py-1">
      <Button ref={browseButton} variant="ghost" icon={<ListTree />} onClick={() => setPanel("browse")}>Browse</Button>
      <Button ref={detailsButton} variant="ghost" icon={<Info />} onClick={() => setPanel("details")}>{editOpen ? "Edit details" : "Details"}</Button>
      <Button ref={viewButton} variant="ghost" icon={<SlidersHorizontal />} onClick={() => setPanel("view")}>View</Button>
    </nav>
    <Sheet keepMounted returnFocusRef={browseButton} open={panel === "browse"} onOpenChange={(open) => { if (!open) setPanel(null); }} title="Browse the house" description="Find rooms, equipment and furniture.">
      <input type="search" aria-label="Find equipment" placeholder="Find equipment…" value={query} onChange={(e) => setQuery(e.target.value)} className="mb-3 min-h-11 w-full rounded-md border border-line bg-surface px-3 text-ink" />
      {query ? <ul>{state.placements.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).map((p) => <li key={p.id}><button type="button" onClick={() => { runtime.select({ kind: "equipment", id: p.id }, { focus: true }); setPanel("details"); }} className="min-h-11 w-full text-left">{p.name}</button></li>)}</ul> : <PropertyTree />}
      <PlaceableList />
      <FurnishingsPanel />
      {furniture.draft ? <Button onClick={() => setPanel("details")}>Edit furniture details</Button> : null}
    </Sheet>
    <Sheet keepMounted returnFocusRef={detailsButton} open={panel === "details"} onOpenChange={(open) => { if (!open && !state.saving) setPanel(null); }} title={editOpen ? "Edit details" : "Details"} description={editOpen ? "Close to keep your draft. Save or Cancel finishes the edit." : "Location, instructions and equipment information."}>
      {equipmentId && !state.editing ? <LocateSheet placementId={equipmentId} /> : null}
      {furniture.draft ? <FurnitureInspector /> : state.editing ? <PlacementEditor /> : <>{state.routeDraft ? <RouteEditors /> : <Inspector />}<RouteCreateControl /></>}
    </Sheet>
    <Sheet keepMounted returnFocusRef={viewButton} open={panel === "view"} onOpenChange={(open) => { if (!open) setPanel(null); }} title="View settings" description="Adjust the camera, visible layers and rendering.">
      <CameraNavigation input />
      <ViewToolbar section="presets" />
      <details className="border-b border-line py-2" open><summary className="min-h-11 cursor-pointer font-medium">Floors and walls</summary><FloorControls inline /><CutawayControl /><ExplodeControl /></details>
      <details className="border-b border-line py-2" open><summary className="min-h-11 cursor-pointer font-medium">Layers</summary>
        <Switch checked={state.layers.equipment} onCheckedChange={(on) => toggleLayer("equipment", on)} label="Show equipment" />
        <Switch checked={state.layers.furnishings} onCheckedChange={(on) => toggleLayer("furnishings", on)} label="Show furniture" />
        <Switch checked={state.layers.routes} onCheckedChange={(on) => toggleLayer("routes", on)} label="Show infrastructure routes" />
        <InfrastructureKindToggles phone />
        <Switch checked={state.equipmentOcclusion} onCheckedChange={(on) => runtime.store.getState().setEquipmentOcclusion(on)} label="Hide occluded equipment" />
        <Switch checked={state.areaLabelsVisible} onCheckedChange={(on) => runtime.store.getState().setAreaLabelsVisible(on)} label="Area labels" />
      </details>
      <details className="py-2"><summary className="min-h-11 cursor-pointer font-medium">Rendering</summary><RenderingControls /></details>
      <DownloadImageButton />
    </Sheet>
    <p aria-live="polite" className="sr-only">{state.announcement}</p>
  </div>;
}
