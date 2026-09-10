"use client";
/**
 * The workspace shell: three landmark regions (tree · canvas · inspector) around one store and one
 * runtime, plus everything that has to happen exactly once — package discovery, data hydration,
 * the HA stream, the URL sync and the keyboard map.
 *
 * The 3D canvas is a lazily-imported leaf behind an error boundary, so a WebGL failure or an
 * invalid package degrades to `<SetupState>` and never takes the rest of the app with it. Every
 * 3D-only capability has a non-3D route: the tree focuses floors and selects rooms, search finds
 * equipment, the inspector edits placements numerically, and the colour picker lists a room's
 * surfaces by name.
 *
 * `F6` cycles the regions; the shortcut map (§11.2) is registered on this element, not on
 * `window`, so the rest of the app is unaffected when the workspace is not focused.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { cutRange } from "@/house/model/framingBoxes";
import { DEFAULT_HOUSE_BACKGROUND, type HouseBackground } from "@/house/model/background";
import { displayNameForNode } from "@/house/model/labelPreferences";
import type { DaylightHaEntity } from "@/house/model/daylight";
import type { FloorId, Selection } from "@/house/model/types";
import { createRuntime, type HouseRuntime } from "@/house/runtime";
import type { CanvasTool } from "@/house/store/slices/view";
import { createHouseStore } from "@/house/store/createHouseStore";
import {
  createMemoryDataApi,
  createResilientDataApi,
  createRestDataApi,
  NotPersistedError,
  type ColorOverrideWrite,
  type PlaceableEquipment,
} from "@/house/store/dataApi";
import { connectHaSse } from "@/house/store/haSse";
import { readUrlState, syncUrl } from "@/house/store/urlSync";
import {
  floorIdByIndex,
  isTypingTarget,
  SHORTCUTS,
  useKeyboardShortcuts,
  type ShortcutHandlers,
} from "../hooks/useKeyboardShortcuts";
import { HouseRuntimeContext, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useModelPackage } from "../hooks/useModelPackage";
import { useIsPhone } from "../hooks/useReducedMotion";
import { setPanelCollapsed, usePanelLayout } from "../hooks/usePanelLayout";
import { HouseCanvasLazy } from "./HouseCanvasLazy";
import { HouseErrorBoundary } from "./HouseErrorBoundary";
import { CanvasHints, setHintsSeen } from "./CanvasHints";
import { PropertyTree } from "./PropertyTree";
import { ToolPalette } from "./ToolPalette";
import { SetupState } from "./SetupState";
import { ViewControls } from "./ViewControls";
import { FloorControls } from "./ViewToolbar";
import { rememberRenderingPreferences } from "../store/renderingPreferences";
import { PlaceableList } from "./edit/PlaceableList";
import { RouteCreateControl } from "./routeEditor/RouteCreateControl";
import { RoutePath3D } from "./routeEditor/RoutePath3D";
import { startPlacement } from "./edit/startPlacement";
import { PlacementEditor } from "./edit/PlacementEditor";
import { SnapReadoutOverlay } from "./edit/SnapIndicator";
import { Inspector } from "./inspector/Inspector";
import { PhoneHouse } from "./phone/PhoneHouse";
import { IconButton, Input } from "@/ui";
import { cn } from "@/ui/cn";
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { PlanEditor2D } from "./routeEditor/PlanEditor2D";
import { WallElevationEditor2D } from "./routeEditor/WallElevationEditor2D";
import { FurnishingsProvider, useFurnishings } from "./furnishings/FurnishingsProvider";
import { FurnishingsPanel, FurnitureInspector } from "./furnishings/FurnishingsPanel";
import { FurnitureEditorProvider, useFurnitureEditor } from "./furnishings/FurnitureEditorContext";
import { DaylightHaProvider } from "./DaylightHaContext";

export interface HouseWorkspaceProps {
  /** From the server: the installed package's model id, or `null` when nothing is installed. */
  modelId: string | null;
  /**
   * From the server: the household's 3D background. Passed in rather than fetched so the very
   * first paint of the canvas host is already the chosen background — a default painted for one
   * frame and then replaced is a visible flash.
   */
  background?: HouseBackground;
  /** Rename-safe HA identities that already have a worker-maintained live state cache. */
  daylightHaEntities?: readonly DaylightHaEntity[];
}

/** Colour edits are batched: one PATCH after the picker settles, not one per pointer move. */
const COLOR_SAVE_DEBOUNCE_MS = 600;

export function HouseWorkspace({
  modelId,
  background = DEFAULT_HOUSE_BACKGROUND,
  daylightHaEntities = [],
}: HouseWorkspaceProps) {
  const runtime = useMemo<HouseRuntime>(() => {
    const store = createHouseStore({ background });
    const local = createMemoryDataApi();
    const dataApi = createResilientDataApi(createRestDataApi(), local, (reason) =>
      store.getState().setSaveState("local", reason),
    );
    return createRuntime({
      store,
      dataApi,
      base: modelId ? `/api/house-model/${encodeURIComponent(modelId)}` : "",
    });
    // `background` seeds the store once; later changes come from the control, not from a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  if (!modelId)
    return (
      <div className="h-full p-4">
        <SetupState
          phase="idle"
          modelId={null}
          fingerprint={null}
          diagnostics={[]}
          issues={[]}
          missingAssetIds={[]}
          failedAssetIds={[]}
          fatal={null}
        />
      </div>
    );

  return (
    <HouseRuntimeContext.Provider value={runtime}>
      <DaylightHaProvider entities={daylightHaEntities}>
        <FurnishingsProvider>
          <FurnitureEditorProvider><WorkspaceBody runtime={runtime} /></FurnitureEditorProvider>
        </FurnishingsProvider>
      </DaylightHaProvider>
    </HouseRuntimeContext.Provider>
  );
}

function WorkspaceBody({ runtime }: { runtime: HouseRuntime }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const canvasRegionRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const phone = useIsPhone();
  const { busy: furnishingsBusy } = useFurnishings();
  const furnitureEditor = useFurnitureEditor();
  const furnitureOpen = !!furnitureEditor.draft || furnitureEditor.catalogOpen;

  useEffect(() => {
    try { return rememberRenderingPreferences(runtime.store, window.localStorage); }
    catch { /* Some browsers deny access to localStorage entirely. */ }
  }, [runtime]);

  const { reload } = useModelPackage(runtime);
  useDataHydration(runtime);
  useColorPersistence(runtime);
  useHaStream(runtime);
  useUrlSync(runtime);
  useSelectionAnnouncement(runtime);

  const state = useHouseStore(
    useShallow((s) => ({
      phase: s.phase,
      modelId: s.modelId,
      fingerprint: s.fingerprint,
      diagnostics: s.diagnostics,
      issues: s.issues,
      missingAssetIds: s.missingAssetIds,
      failedAssetIds: s.failedAssetIds,
      fatal: s.fatal,
      loaded: s.loadedAssetIds.length,
      announcement: s.announcement,
      editing: s.editing !== null,
      adjusting: !!s.editing?.placementId,
      editorSaving: s.editorSaving,
      routeDraft: s.routeDraft !== null,
      tool: s.tool,
      cameraOverride: s.cameraOverride,
    })),
  );

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const showHelp = useCallback(() => setHelpOpen((v) => !v), []);
  const handlers = useShortcutHandlers(runtime, focusSearch, showHelp);
  useKeyboardShortcuts(rootRef, handlers, !state.fatal);
  useRegionCycling(rootRef, [treeRef, canvasRegionRef, inspectorRef]);
  useToolCamera(runtime);
  const panels = usePanelLayout();
  useEffect(() => runtime.store.subscribe((next, previous) => {
    if ((next.editing && !previous.editing) || (next.routeDraft && !previous.routeDraft))
      setPanelCollapsed("inspector", false);
  }), [runtime]);

  if (state.phase === "failed" || state.fatal)
    return (
      <div className="h-full p-4">
        <SetupState
          phase={state.phase}
          modelId={state.modelId}
          fingerprint={state.fingerprint}
          diagnostics={state.diagnostics}
          issues={state.issues}
          missingAssetIds={state.missingAssetIds}
          failedAssetIds={state.failedAssetIds}
          fatal={state.fatal}
          onRetry={reload}
        />
      </div>
    );

  if (phone) return <PhoneHouse />;

  return (
    <div
      ref={rootRef}
      data-testid="vh-workspace"
      className="flex h-full min-h-0 gap-3 bg-paper p-3"
      // The shortcut listener lives here; the element is focusable so F6 has somewhere to land.
      tabIndex={-1}
    >
      {panels.collapsed.tree ? (
        <PanelRail
          side="left"
          label="Show the property tree"
          onExpand={() => panels.toggle("tree")}
        />
      ) : (
        <aside
          ref={treeRef}
          aria-label="Property tree"
          className="flex w-64 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
        >
          <PanelHeader
            title="Property"
            collapseLabel="Collapse the property tree"
            icon={<PanelLeftClose aria-hidden="true" />}
            disabled={furnishingsBusy}
            onCollapse={() => panels.toggle("tree")}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-ink-2">Search rooms and equipment (/)</span>
              <SearchBox runtime={runtime} inputRef={searchRef} />
            </label>
            <PropertyTree />
            <PlaceableList />
            <FurnishingsPanel />
          </div>
        </aside>
      )}

      <section
        ref={canvasRegionRef}
        role="application"
        tabIndex={0}
        aria-label="House 3D view"
        aria-describedby="vh-canvas-help"
        className="flex min-w-0 flex-1 flex-col gap-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <p id="vh-canvas-help" className="sr-only">
          Arrow keys orbit the camera, Shift and the arrow keys pan, plus and minus zoom. Press 1,
          2 or 3 to focus a floor in 3D, 0 for the whole property, P for a top-down plan, and question
          mark for the full list of shortcuts.
        </p>
        <div
          className={cn(
            "relative min-h-0 flex-1",
            // The pointer says what the tool will do before the user commits to a gesture.
            state.cameraOverride || state.tool === "orbit"
              ? "[&_canvas]:cursor-grab [&_canvas]:active:cursor-grabbing"
              : state.tool === "place"
                ? "[&_canvas]:cursor-crosshair"
                : "[&_canvas]:cursor-default",
          )}
        >
          <HouseErrorBoundary>
            <CanvasWithBackground />
          </HouseErrorBoundary>
          <ToolPalette />
          <FloorControls />
          <SnapReadoutOverlay />
          {state.routeDraft ? <RoutePath3D /> : null}
          <CanvasHints />
          <LoadProgress />
        </div>
        <ViewControls collapsed={panels.collapsed.controls} onToggle={() => panels.toggle("controls")} />
      </section>

      {/* An editor with nowhere to render is a trap: with the inspector collapsed (a choice that
          persists across reloads) pressing `E` locked the explode view and offered no Save, no
          Cancel and no numeric fields — only Esc got out. Editing forces the panel open. */}
      {panels.collapsed.inspector && !state.editing && !state.routeDraft && !furnitureOpen ? (
        <PanelRail
          side="right"
          label="Show the inspector"
          onExpand={() => panels.toggle("inspector")}
        />
      ) : (
        <aside
          ref={inspectorRef}
          aria-label="Inspector"
          className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface"
        >
          <PanelHeader
            title={furnitureOpen ? (furnitureEditor.draft ? "Furniture details" : "Furniture catalog") : state.editing ? (state.adjusting ? "Adjust placement" : "Place equipment") : state.routeDraft ? "Edit route" : "Details"}
            collapseLabel="Collapse the inspector"
            icon={<PanelRightClose aria-hidden="true" />}
            disabled={state.editorSaving || furnishingsBusy}
            onCollapse={() => {
              const current = runtime.store.getState();
              if (current.editorSaving || furnishingsBusy) return;
              furnitureEditor.cancel();
              furnitureEditor.setCatalogOpen(false);
              current.cancelEdit();
              current.cancelRouteDraft();
              runtime.setSnapIndicator(null);
              panels.setCollapsed("inspector", true);
              canvasRegionRef.current?.focus();
            }}
          />
          <section
            aria-label={state.editing ? "Equipment placement" : state.routeDraft ? "Route editing" : "Selected item details"}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3"
          >
            {furnitureOpen ? <FurnitureInspector /> : state.editing ? <PlacementEditor /> : state.routeDraft ? (
              <>
                <RouteEditors />
                <RouteCreateControl />
              </>
            ) : (
              <>
                <Inspector />
                <RouteCreateControl />
              </>
            )}
          </section>
        </aside>
      )}

      <p aria-live="polite" className="sr-only">
        {state.announcement}
      </p>

      {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

/**
 * Hydrate the persisted overlays once the package is known. A `NotPersistedError` is not a
 * failure: the endpoint does not exist yet, and the workspace says so instead of pretending.
 */
function useDataHydration(runtime: HouseRuntime): void {
  const modelId = useHouseStore((s) => s.modelId);
  const fingerprint = useHouseStore((s) => s.fingerprint);

  useEffect(() => {
    if (!modelId || !fingerprint) return;
    let cancelled = false;
    const store = runtime.store;

    void (async () => {
      try {
        const labelPreferences = await runtime.dataApi.listLabelPreferences(modelId);
        if (!cancelled) store.getState().hydrateLabelPreferences(labelPreferences);
      } catch (err) {
        if (!cancelled && !(err instanceof NotPersistedError))
          store.getState().setDataError(messageOf(err));
      }
      try {
        const overrides = await runtime.dataApi.listColorOverrides(modelId);
        if (!cancelled) store.getState().hydrateOverrides(overrides);
      } catch (err) {
        if (!cancelled && !(err instanceof NotPersistedError))
          store.getState().setSaveState("error", messageOf(err));
      }
      try {
        const placements = await runtime.dataApi.listPlacements(modelId);
        if (!cancelled) store.getState().setPlacements(placements);
      } catch (err) {
        if (!cancelled && !(err instanceof NotPersistedError))
          store.getState().setDataError(messageOf(err));
      }
      try {
        const placeable = await runtime.dataApi.listPlaceableEquipment(modelId);
        if (!cancelled) store.getState().setPlaceable(placeable);
      } catch (err) {
        // Not fatal: the workspace still shows everything already placed. Only the "not placed
        // yet" list goes missing, so it says nothing rather than claiming the list is empty.
        if (!cancelled && !(err instanceof NotPersistedError))
          store.getState().setDataError(messageOf(err));
      }
      try {
        const routes = await runtime.dataApi.listRoutes(modelId);
        if (!cancelled) store.getState().setRoutes(routes);
      } catch (err) {
        if (!cancelled && err instanceof NotPersistedError)
          store.getState().setDataError(
            "Infrastructure routes are not stored yet — anything drawn here lasts for this session.",
          );
        else if (!cancelled) store.getState().setDataError(messageOf(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runtime, modelId, fingerprint]);
}

/**
 * Colour persistence: optimistic local apply (the scene already followed the store), then one
 * debounced PATCH per settled edit. On a real failure the store is reverted to the last persisted
 * snapshot, because a colour that looks saved and is not is worse than a colour that snaps back.
 */
function useColorPersistence(runtime: HouseRuntime): void {
  const persisted = useRef<Record<string, string>>({});

  useEffect(() => {
    const store = runtime.store;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = async () => {
      timer = null;
      const s = store.getState();
      if (s.dirty.length === 0 || !s.modelId || !s.fingerprint) return;
      const dirty = [...s.dirty];
      const writes: ColorOverrideWrite[] = dirty.map((surfaceId) => ({
        surfaceId,
        roomId: s.index?.surfaces.get(surfaceId)?.roomId ?? null,
        colorHex: s.overrides[surfaceId] ?? null,
      }));
      store.getState().setSaveState("saving");
      try {
        const next = await runtime.dataApi.saveColorOverrides(s.modelId, s.fingerprint, writes);
        persisted.current = next;
        store.getState().clearDirty(dirty);
        if (store.getState().saveState === "saving") store.getState().setSaveState("clean");
      } catch (err) {
        if (err instanceof NotPersistedError) {
          store.getState().clearDirty(dirty);
          store.getState().setSaveState("local", err.reason);
          return;
        }
        store.getState().hydrateOverrides(persisted.current);
        store.getState().setSaveState("error", messageOf(err));
      }
    };

    const unsubscribeOverrides = store.subscribe(
      (s) => s.overrides,
      (next) => {
        if (store.getState().dirty.length === 0) persisted.current = next;
      },
    );

    const unsubscribeDirty = store.subscribe(
      (s) => s.dirty,
      (dirty) => {
        if (dirty.length === 0) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), COLOR_SAVE_DEBOUNCE_MS);
      },
    );

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribeOverrides();
      unsubscribeDirty();
    };
  }, [runtime]);
}

/**
 * One `EventSource`, subscribed to the entities this model's placements actually link to — never
 * the whole registry. The stream endpoint may not exist yet; that degrades to "HA layer
 * unavailable" and never breaks the workspace.
 */
function useHaStream(runtime: HouseRuntime): void {
  const daylightEntityKey = useHouseStore((s) =>
    [s.illumination.outdoorLuxEntityId, s.illumination.weatherEntityId]
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort()
      .join(","),
  );
  const entityKey = useHouseStore((s) =>
    s.placements
      .flatMap((p) => [p.entityId, ...(p.linkedEntities ?? []).map((entity) => entity.entityId)])
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort()
      .join(","),
  );

  useEffect(() => {
    const entityIds = [...new Set([entityKey, daylightEntityKey].filter(Boolean).join(",").split(",").filter(Boolean))];
    if (entityIds.length === 0) return;
    const handle = connectHaSse({ entityIds });
    return () => handle.close();
  }, [daylightEntityKey, entityKey, runtime]);
}

/**
 * `?sel=` / `?floor=` / `?view=` / `?proj=`, via `history.replaceState`. A selection is not a
 * navigation step, so it never enters the back stack — but it does survive a reload, which is what
 * makes a selection shareable between the two household members.
 */
function useUrlSync(runtime: HouseRuntime): void {
  const applied = useRef(false);
  const phase = useHouseStore((s) => s.phase);

  useEffect(() => {
    if (applied.current) return;
    if (phase !== "interactive" && phase !== "ready" && phase !== "degraded") return;
    applied.current = true;
    const url = readUrlState(window.location.search);
    const store = runtime.store;
    const index = store.getState().index;
    if (url.activeFloorId && index?.floors.has(url.activeFloorId))
      store.getState().isolateFloor(url.activeFloorId);
    if (url.viewMode) store.getState().setViewMode(url.viewMode);
    if (url.projection) store.getState().setProjection(url.projection);
    if (url.selection && selectionExists(store.getState().index, url.selection))
      runtime.select(url.selection, { frame: true });
  }, [runtime, phase]);

  useEffect(() => {
    const store = runtime.store;
    return store.subscribe(
      (s) => ({
        selection: s.selection,
        activeFloorId: s.activeFloorId,
        viewMode: s.viewMode,
        projection: s.projection,
      }),
      (next) => syncUrl(next),
      {
        equalityFn: (a, b) =>
          a.activeFloorId === b.activeFloorId &&
          a.viewMode === b.viewMode &&
          a.projection === b.projection &&
          a.selection?.kind === b.selection?.kind &&
          a.selection?.id === b.selection?.id,
      },
    );
  }, [runtime]);
}

/** Selection is never announced by colour alone; the polite live region says what happened. */
function useSelectionAnnouncement(runtime: HouseRuntime): void {
  const selection = useHouseStore((s) => s.selection);

  useEffect(() => {
    if (!selection) return;
    const s = runtime.store.getState();
    const index = s.index;
    if (!index) return;
    const text = describeSelection(s, selection);
    if (text) s.announce(text);
  }, [runtime, selection]);
}

function describeSelection(
  s: ReturnType<HouseRuntime["store"]["getState"]>,
  selection: Selection,
): string | null {
  const index = s.index;
  if (!index) return null;
  const floorName = (floorId: string | undefined) =>
    floorId ? (index.floors.get(floorId)?.name ?? floorId) : "";
  switch (selection.kind) {
    case "room": {
      const room = index.rooms.get(selection.id);
      if (!room) return null;
      const walls = (index.roomSurfaces.get(room.id) ?? []).filter(
        (id) => index.surfaces.get(id)?.kind === "wall",
      ).length;
      return [
        room.name,
        floorName(room.floorId),
        room.area !== undefined ? `${room.area.toFixed(2)} square metres` : null,
        `${walls} wall surfaces`,
      ]
        .filter(Boolean)
        .join(", ");
    }
    case "surface": {
      const surface = index.surfaces.get(selection.id);
      if (!surface) return null;
      const room = surface.roomId ? index.rooms.get(surface.roomId) : undefined;
      return [surface.kind, surface.role, room?.name].filter(Boolean).join(", ");
    }
    case "equipment": {
      const placement = s.placements.find((p) => p.id === selection.id);
      if (!placement) return null;
      const room = placement.roomId ? index.rooms.get(placement.roomId) : undefined;
      return [placement.name, room?.name, floorName(placement.floorId)].filter(Boolean).join(", ");
    }
    case "route": {
      const route = s.routes.find((r) => r.id === selection.id);
      return route ? `${route.name}, ${route.system}, confidence ${route.certainty}` : null;
    }
    case "floor":
      return index.floors.get(selection.id)?.name ?? null;
    case "building":
      return index.buildings.get(selection.id)?.name ?? null;
    default:
      return null;
  }
}

function selectionExists(
  index: ReturnType<HouseRuntime["store"]["getState"]>["index"],
  selection: Selection,
): boolean {
  if (!index) return false;
  switch (selection.kind) {
    case "room":
      return index.rooms.has(selection.id);
    case "surface":
      return index.surfaces.has(selection.id);
    case "element":
      return index.elements.has(selection.id);
    case "floor":
      return index.floors.has(selection.id);
    case "building":
      return index.buildings.has(selection.id);
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// keyboard
// ---------------------------------------------------------------------------

function useShortcutHandlers(
  runtime: HouseRuntime,
  focusSearch: () => void,
  showHelp: () => void,
): ShortcutHandlers {
  return useMemo<ShortcutHandlers>(() => {
    const get = () => runtime.store.getState();
    return {
      isolateFloorByIndex(n) {
        const s = get();
        const floorId = floorIdByIndex(s.index?.floorOrder ?? [], n);
        if (!floorId) return;
        s.setProjection("perspective");
        s.isolateFloor(floorId);
        s.setViewMode("floor");
        void runtime.camera?.frameFloor(floorId);
      },
      allFloors() {
        get().isolateFloor(null);
        get().applyOverview();
        void runtime.camera?.overview();
      },
      resetOverview() {
        get().applyOverview();
        void runtime.camera?.overview();
      },
      frameSelection() {
        void runtime.camera?.frameSelection();
      },
      escape() {
        const s = get();
        if (s.editorSaving) return;
        if (s.editing) {
          // Esc once on a clean draft cancels; on a dirty one it asks, and a second Esc discards.
          if (!s.editing.dirty || s.editError === DISCARD_PROMPT) s.cancelEdit();
          else s.setEditError(DISCARD_PROMPT);
          return;
        }
        if (s.routeDraft) {
          s.cancelRouteDraft();
          return;
        }
        runtime.select(null);
      },
      toggleEdit() {
        const s = get();
        if (s.editorSaving) return;
        if (s.editing) {
          s.cancelEdit();
          return;
        }
        // Silence here read as "E is broken". It is not: edit mode acts on one piece of
        // equipment, so it needs one selected — and equipment that has never been placed is
        // started from the "Not placed yet" list instead, since there is no marker to select.
        if (s.selection?.kind !== "equipment") {
          s.announce(
            s.placeable.length > 0
              ? "Select a placed piece of equipment to adjust it, or use “Not placed yet” in the property panel to place one."
              : "Select a piece of equipment first — E adjusts the selected placement.",
          );
          return;
        }
        const placement = s.placements.find((p) => p.id === s.selection?.id);
        if (!placement) {
          s.announce("That equipment has no placement to adjust yet.");
          return;
        }
        s.beginEdit({
          placementId: placement.id,
          equipmentId: placement.equipmentId,
          modelId: placement.modelId,
          name: placement.name,
              category: placement.category,
              entityId: placement.entityId,
          physical: [...placement.position],
          rotationYDeg: placement.rotationYDeg,
          lightAim: placement.lightAim ?? null,
              solarPanel: placement.solarPanel ?? null,
              ledLengthM: placement.ledLengthM ?? null,
              detectionRangeM: placement.detectionRangeM ?? null,
              treeHeightM: placement.treeHeightM ?? null,
          mount: placement.mount,
          floorId: placement.floorId,
          roomId: placement.roomId,
          surfaceId: placement.surfaceId,
          locationNote: placement.locationNote,
          photoId: placement.photoId,
          symbol: placement.symbol,
          dirty: false,
        });
      },
      setTool(tool) {
        get().setTool(tool);
      },
      planView() {
        const s = get();
        const floorId = s.activeFloorId ?? s.index?.floorOrder[0] ?? null;
        if (!floorId) return;
        s.setViewMode("plan");
        s.setProjection("ortho");
        s.isolateFloor(floorId);
        s.setViewMode("plan");
        void runtime.camera?.planFor(floorId);
      },
      toggleSection() {
        const s = get();
        if (s.cut.enabled) {
          s.setCut({ enabled: false });
          if (s.viewMode === "section") s.setViewMode("overview");
          return;
        }
        const index = s.index;
        const range = index ? cutRange(index) : null;
        const floor = s.activeFloorId ? index?.floors.get(s.activeFloorId) : undefined;
        const y = floor ? floor.elevation + 1.2 : range ? (range.min + range.max) / 2 : 1.5;
        s.setCut({ enabled: true, y });
        s.setViewMode("section");
      },
      toggleExplode() {
        const s = get();
        if (s.explode.locked) return;
        s.setExplode({
          enabled: !s.explode.enabled,
          gap: s.explode.gap > 0 ? Math.min(s.explode.gap, MAX_EXPLODE_GAP) : 2.5,
        });
      },
      toggleRoof() {
        get().setRoofVisible(!get().roofVisible);
      },
      toggleCeilings() {
        get().setCeilingsVisible(!get().ceilingsVisible);
      },
      toggleEdges() {
        get().setEdgesVisible(!get().edgesVisible);
      },
      dollhouse() {
        get().applyDollhouse();
      },
      nudgeCut(delta) {
        get().nudgeCut(delta);
      },
      rotateSelection(delta) {
        const s = get();
        if (!s.editing) return;
        s.updateDraft({ rotationYDeg: s.editing.rotationYDeg + delta }, { coalesce: true });
      },
      orbit(azimuth, polar) {
        runtime.camera?.orbit(azimuth, polar);
      },
      truck(dx, dy) {
        runtime.camera?.truck(dx, dy);
      },
      dolly(delta) {
        runtime.camera?.dolly(delta);
      },
      focusSearch,
      showHelp,
    };
  }, [runtime, focusSearch, showHelp]);
}

const DISCARD_PROMPT = "Press Esc again to discard the unsaved placement.";

/**
 * Who owns the left button, decided **before** the gesture starts.
 *
 * This is the fix for "the camera moves while I drag the marker". `camera-controls` binds its own
 * `pointerdown` on the canvas, and a gesture it has already captured keeps running even if
 * `enabled` is flipped mid-drag — so the old code, which disabled the controls inside the app's
 * own `pointerdown`, was always one handler too late. Deciding from the tool means the controls
 * are already off when the pointer goes down.
 *
 * Space is the escape hatch: held, the camera is on loan whatever the tool says, so no mode is a
 * dead end. It is released on blur too — a window that loses focus mid-hold must not keep the
 * camera stuck on.
 *
 * The flag itself is applied by `Rig`, as a prop on the controls: drei rebuilds the controls
 * instance when the default camera changes, so writing `enabled` onto a captured instance silently
 * disabled a dead object while the live one kept orbiting.
 */
function useToolCamera(runtime: HouseRuntime): void {
  const { editing, setCameraOverride, setTool } = useHouseStore(
    useShallow((s) => ({
      // A route draft aims with the pointer just like a placement does, so it takes the camera
      // off the left button on the same terms.
      editing: s.editing !== null || s.routeDraft !== null,
      setCameraOverride: s.setCameraOverride,
      setTool: s.setTool,
    })),
  );

  // Entering the placement editor switches to the place tool, and leaving it hands the camera
  // back. Without this, edit mode opened with the camera still on the left button and the first
  // drag spun the house.
  const previous = useRef<CanvasTool | null>(null);
  useEffect(() => {
    if (editing) {
      previous.current = runtime.store.getState().tool;
      setTool("place");
      return;
    }
    const restore = previous.current;
    previous.current = null;
    if (restore && restore !== "place") setTool(restore);
  }, [editing, setTool, runtime]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest('button, a[href], [role="tab"], [role="radio"], [role="switch"]')) return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      setCameraOverride(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      setCameraOverride(false);
    };
    const onBlur = () => setCameraOverride(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [setCameraOverride]);
}

/** `F6` cycles the landmark regions forwards, `Shift+F6` backwards. */
function useRegionCycling(
  rootRef: React.RefObject<HTMLElement | null>,
  regions: ReadonlyArray<React.RefObject<HTMLElement | null>>,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F6") return;
      event.preventDefault();
      const elements = regions.map((r) => r.current).filter((el): el is HTMLElement => !!el);
      if (elements.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const current = elements.findIndex((el) => el === active || el.contains(active));
      const delta = event.shiftKey ? -1 : 1;
      const next = elements[(current + delta + elements.length) % elements.length];
      if (!next) return;
      const focusable = next.querySelector<HTMLElement>(
        '[tabindex]:not([tabindex="-1"]), button:not([disabled]), input:not([disabled]), a[href]',
      );
      (focusable ?? next).focus();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [rootRef, regions]);
}

// ---------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------

function LoadProgress() {
  const { phase, loaded, total } = useHouseStore(
    useShallow((s) => ({
      phase: s.phase,
      loaded: s.loadedAssetIds.length,
      total: s.tier0AssetIds.length || s.index?.defaultAssetIds.length || 0,
    })),
  );
  if (phase === "ready" || phase === "interactive" || phase === "degraded") return null;
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 p-3"
      role="status"
      aria-live="polite"
    >
      <div className="rounded-md border border-line bg-surface/85 text-ink shadow-pop backdrop-blur-sm px-3 py-2 text-xs">
        {phase === "validating" ? "Checking the model package…" : `Loading the house… ${pct}%`}
      </div>
    </div>
  );
}

/**
 * The canvas, subscribed to the one piece of store state it needs.
 *
 * A separate component so a background change re-renders *this* and not the whole workspace — the
 * tree, the toolbar and the inspector have nothing to do with it.
 */
function CanvasWithBackground() {
  const background = useHouseStore((s) => s.background);
  return <HouseCanvasLazy background={background} />;
}

/**
 * The 2D route editors. Both are bijections to and from the stored physical polyline, so which one
 * is open never changes what is saved.
 */
function RouteEditors() {
  const { routeDraft, activeFloorId, selection, index } = useHouseStore(
    useShallow((s) => ({
      routeDraft: s.routeDraft,
      activeFloorId: s.activeFloorId,
      selection: s.selection,
      index: s.index,
    })),
  );
  const cancelRouteDraft = useHouseStore((s) => s.cancelRouteDraft);
  const saving = useHouseStore((s) => s.editorSaving);
  const phone = useIsPhone();
  if (!routeDraft || !index) return null;

  const floorId: FloorId | null =
    activeFloorId ?? routeDraft.segments.find((seg) => seg.floorId)?.floorId ?? null;
  const wallSurfaceId =
    selection?.kind === "surface" && index.surfaces.get(selection.id)?.kind === "wall"
      ? selection.id
      : null;

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-ink-3">
          Route path — {routeDraft.name}
        </h3>
        <button
          type="button"
          disabled={saving}
          onClick={cancelRouteDraft}
          className="min-h-8 rounded-md border border-line bg-surface px-2 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Close editor
        </button>
      </header>
      {phone ? (
        <p className="rounded-md border border-line bg-surface-2 p-2 text-xs text-ink-2">
          The 2D route editors are read-only on a phone. Edit on a desktop.
        </p>
      ) : null}
      {floorId ? <PlanEditor2D floorId={floorId} /> : null}
      {wallSurfaceId ? <WallElevationEditor2D surfaceId={wallSurfaceId} /> : (
        <p className="text-[11px] text-ink-3">
          Select a wall surface to edit this route in that wall&rsquo;s elevation.
        </p>
      )}
    </section>
  );
}

/**
 * Search → frame, as one orchestrated action so it cannot half-apply: isolate the floor, set the
 * selection, wait for the visibility resolver, fit the box, then announce.
 */
function SearchBox({
  runtime,
  inputRef,
}: {
  runtime: HouseRuntime;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const { index, placements, placeable, labelPreferences } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      placements: s.placements,
      placeable: s.placeable,
      labelPreferences: s.labelPreferences,
    })),
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !index) return [];
    // A result either selects something in the model, or starts placing equipment that is not in
    // the model yet — the union rather than two lists, so one Enter does the obvious thing.
    const out: Array<
      { label: string; secondary: string } & (
        | { selection: Selection; placeable?: undefined }
        | { placeable: PlaceableEquipment; selection?: undefined }
      )
    > = [];
    for (const room of index.rooms.values()) {
      const displayName = displayNameForNode(room.id, room.name, labelPreferences);
      const haystack = [displayName, room.name, room.nameFi ?? "", ...room.aliases]
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q))
        out.push({
          selection: { kind: "room", id: room.id },
          label: displayName,
          secondary: (() => {
            const floor = index.floors.get(room.floorId);
            return floor
              ? displayNameForNode(floor.id, floor.name, labelPreferences)
              : room.floorId;
          })(),
        });
    }
    for (const p of placements) {
      if (!p.name.toLowerCase().includes(q)) continue;
      out.push({
        selection: { kind: "equipment", id: p.id },
        label: p.name,
        secondary: p.roomId
          ? (() => {
              const room = index.rooms.get(p.roomId);
              return room
                ? displayNameForNode(room.id, room.name, labelPreferences)
                : p.roomId;
            })()
          : "outside",
      });
    }
    // Equipment with no placement yet. Without these, searching for something just imported from
    // Home Assistant found nothing, which reads as "the import did not work".
    for (const e of placeable) {
      if (!e.name.toLowerCase().includes(q)) continue;
      out.push({
        placeable: e,
        label: e.name,
        secondary: e.locationName ? `not placed · ${e.locationName}` : "not placed",
      });
    }
    return out.slice(0, 8);
  }, [query, index, placements, placeable, labelPreferences]);

  const focus = useCallback(
    async (selection: Selection) => {
      const s = runtime.store.getState();
      const manifest = s.index;
      if (!manifest) return;
      runtime.select(selection, { focus: true });
      // The visibility resolver runs in a store subscription. One frame lets its transient focus
      // context reach the scene before the camera fits, without changing the manual floor mode.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await runtime.camera?.frameSelection();
      const text = describeSelection(runtime.store.getState(), selection);
      if (text) runtime.store.getState().announce(text);
    },
    [runtime],
  );

  const activate = useCallback(
    async (result: (typeof results)[number]) => {
      if (result.placeable) {
        if (!startPlacement(runtime, result.placeable)) {
          runtime.store
            .getState()
            .announce("There is no house model loaded, so there is nowhere to place it yet.");
        }
        return;
      }
      await focus(result.selection);
    },
    [runtime, focus],
  );

  return (
    <div className="relative">
      {/* The design system's field, not a bespoke input: `fieldSurface` is what carries the
          readable ink, the token surface and a `placeholder:text-ink-3` that survives dark mode. */}
      <Input
        ref={inputRef}
        type="search"
        inputSize="sm"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const first = results[0];
          if (first) void activate(first);
        }}
        placeholder="Kitchen, door sensor…"
        aria-label="Search rooms and equipment"
      />
      {results.length ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {results.map((r) => (
            <li key={r.selection ? `${r.selection.kind}:${r.selection.id}` : `asset:${r.placeable.assetId}`}>
              <button
                type="button"
                onClick={() => void activate(r)}
                className="min-h-8 w-full truncate rounded px-1 text-left text-xs text-ink hover:bg-surface-3"
              >
                {r.label}
                <span className="ml-1 text-[10px] text-ink-3">{r.secondary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The header strip every expanded side panel carries, with its collapse control. */
function PanelHeader({
  title,
  collapseLabel,
  icon,
  onCollapse,
  disabled = false,
}: {
  title: string;
  collapseLabel: string;
  icon: React.ReactNode;
  onCollapse: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-line px-2 py-1">
      <span className="text-xs font-medium text-ink-2">{title}</span>
      <IconButton label={collapseLabel} size="sm" icon={icon} onClick={onCollapse} disabled={disabled} />
    </div>
  );
}

/**
 * What a collapsed panel leaves behind: a rail narrow enough to be worth collapsing for, wide
 * enough to hold a real 32 px target. The label is on the button, so the only affordance is also
 * the accessible name.
 */
function PanelRail({
  side,
  label,
  onExpand,
}: {
  side: "left" | "right";
  label: string;
  onExpand: () => void;
}) {
  return (
    <div className="flex w-10 shrink-0 flex-col items-center rounded-lg border border-line bg-surface py-1">
      <IconButton
        label={label}
        size="sm"
        icon={
          side === "left" ? (
            <PanelLeftOpen aria-hidden="true" />
          ) : (
            <PanelRightOpen aria-hidden="true" />
          )
        }
        onClick={onExpand}
      />
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-20 flex items-center justify-center bg-scrim p-6"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-surface p-4 shadow-overlay"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-ink">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-8 rounded-md border border-line px-2 text-xs font-medium"
          >
            Close
          </button>
        </div>
        <button
          type="button"
          onClick={() => {
            setHintsSeen(false);
            onClose();
          }}
          className="mt-2 min-h-8 rounded-md border border-line px-2 text-xs font-medium text-ink hover:bg-surface-3"
        >
          Show the “working the 3D view” hint again
        </button>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="col-span-2 grid grid-cols-subgrid">
              <dt className="font-mono text-ink-3">{s.keys}</dt>
              <dd className="text-ink">{s.action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : "Something went wrong.";
