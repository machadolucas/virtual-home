"use client";
/**
 * The workspace shell: three landmark regions (tree · canvas · inspector) around one store and one
 * runtime, plus everything that has to happen exactly once — package discovery, data hydration,
 * the HA stream, the URL sync and the keyboard map.
 *
 * The 3D canvas is a lazily-imported leaf behind an error boundary, so a WebGL failure or an
 * invalid package degrades to `<SetupState>` and never takes the rest of the app with it. Every
 * 3D-only capability has a non-3D route: the tree isolates floors and selects rooms, search finds
 * equipment, the inspector edits placements numerically, and the colour picker lists a room's
 * surfaces by name.
 *
 * `F6` cycles the regions; the shortcut map (§11.2) is registered on this element, not on
 * `window`, so the rest of the app is unaffected when the workspace is not focused.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boxForSelection, floorBox3 } from "@/house/scene/framing";
import { MAX_EXPLODE_GAP } from "@/house/model/explodeGroups";
import { cutRange } from "@/house/model/framingBoxes";
import type { FloorId, Selection } from "@/house/model/types";
import { createRuntime, type HouseRuntime } from "@/house/runtime";
import { createHouseStore } from "@/house/store/createHouseStore";
import {
  createMemoryDataApi,
  createResilientDataApi,
  createRestDataApi,
  NotPersistedError,
  type ColorOverrideWrite,
} from "@/house/store/dataApi";
import { connectHaSse } from "@/house/store/haSse";
import { readUrlState, syncUrl } from "@/house/store/urlSync";
import {
  floorIdByIndex,
  SHORTCUTS,
  useKeyboardShortcuts,
  type ShortcutHandlers,
} from "../hooks/useKeyboardShortcuts";
import { HouseRuntimeContext, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useModelPackage } from "../hooks/useModelPackage";
import { useIsPhone } from "../hooks/useReducedMotion";
import { CutawayControl } from "./CutawayControl";
import { ExplodeControl } from "./ExplodeControl";
import { HouseCanvasLazy } from "./HouseCanvasLazy";
import { HouseErrorBoundary } from "./HouseErrorBoundary";
import { PropertyTree } from "./PropertyTree";
import { RouteLegend } from "./RouteLayer";
import { SetupState } from "./SetupState";
import { ViewToolbar } from "./ViewToolbar";
import { PlacementEditor } from "./edit/PlacementEditor";
import { Inspector } from "./inspector/Inspector";
import { PhoneHouse } from "./phone/PhoneHouse";
import { PlanEditor2D } from "./routeEditor/PlanEditor2D";
import { WallElevationEditor2D } from "./routeEditor/WallElevationEditor2D";

export interface HouseWorkspaceProps {
  /** From the server: the installed package's model id, or `null` when nothing is installed. */
  modelId: string | null;
}

/** Colour edits are batched: one PATCH after the picker settles, not one per pointer move. */
const COLOR_SAVE_DEBOUNCE_MS = 600;

export function HouseWorkspace({ modelId }: HouseWorkspaceProps) {
  const runtime = useMemo<HouseRuntime>(() => {
    const store = createHouseStore();
    const local = createMemoryDataApi();
    const dataApi = createResilientDataApi(createRestDataApi(), local, (reason) =>
      store.getState().setSaveState("local", reason),
    );
    return createRuntime({
      store,
      dataApi,
      base: modelId ? `/api/house-model/${encodeURIComponent(modelId)}` : "",
    });
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
      <WorkspaceBody runtime={runtime} />
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
      routeDraft: s.routeDraft !== null,
    })),
  );

  const focusSearch = useCallback(() => searchRef.current?.focus(), []);
  const showHelp = useCallback(() => setHelpOpen((v) => !v), []);
  const handlers = useShortcutHandlers(runtime, focusSearch, showHelp);
  useKeyboardShortcuts(rootRef, handlers, !state.fatal);
  useRegionCycling(rootRef, [treeRef, canvasRegionRef, inspectorRef]);

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
      className="flex h-full min-h-0 gap-3 p-3"
      // The shortcut listener lives here; the element is focusable so F6 has somewhere to land.
      tabIndex={-1}
    >
      <aside
        ref={treeRef}
        aria-label="Property tree"
        className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3"
      >
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-neutral-500">Search rooms and equipment (/)</span>
          <SearchBox runtime={runtime} inputRef={searchRef} />
        </label>
        <PropertyTree />
      </aside>

      <section
        ref={canvasRegionRef}
        role="application"
        tabIndex={0}
        aria-label="House 3D view"
        aria-describedby="vh-canvas-help"
        className="flex min-w-0 flex-1 flex-col gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-600"
      >
        <p id="vh-canvas-help" className="sr-only">
          Arrow keys orbit the camera, Shift and the arrow keys pan, plus and minus zoom. Press 1,
          2 or 3 to isolate a floor, 0 for the whole property, P for a top-down plan, and question
          mark for the full list of shortcuts.
        </p>
        <div className="relative min-h-0 flex-1">
          <HouseErrorBoundary>
            <HouseCanvasLazy />
          </HouseErrorBoundary>
          <LoadProgress />
        </div>
        <div className="flex flex-wrap items-start gap-4 rounded-lg border border-neutral-200 bg-white p-3">
          <CutawayControl />
          <ExplodeControl />
          <RouteLegend />
        </div>
      </section>

      <aside
        ref={inspectorRef}
        aria-label="Inspector"
        className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3"
      >
        <ViewToolbar />
        <hr className="border-neutral-200" />
        {state.editing ? <PlacementEditor /> : <Inspector />}
        {state.routeDraft ? <RouteEditors /> : null}
      </aside>

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
  const entityKey = useHouseStore((s) =>
    s.placements
      .map((p) => p.entityId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort()
      .join(","),
  );

  useEffect(() => {
    const entityIds = entityKey ? entityKey.split(",") : [];
    if (entityIds.length === 0) return;
    const handle = connectHaSse({ entityIds });
    return () => handle.close();
  }, [entityKey, runtime]);
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
        s.isolateFloor(floorId);
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
        if (s.editing) {
          // Esc once on a clean draft cancels; on a dirty one it asks, and a second Esc discards.
          if (!s.editing.dirty || s.editError === DISCARD_PROMPT) s.cancelEdit();
          else s.setEditError(DISCARD_PROMPT);
          return;
        }
        if (s.routeDraft) {
          s.endRouteDraft();
          return;
        }
        runtime.select(null);
      },
      toggleEdit() {
        const s = get();
        if (s.editing) {
          s.cancelEdit();
          return;
        }
        if (s.selection?.kind !== "equipment") return;
        const placement = s.placements.find((p) => p.id === s.selection?.id);
        if (!placement) return;
        s.beginEdit({
          placementId: placement.id,
          equipmentId: placement.equipmentId,
          modelId: placement.modelId,
          name: placement.name,
          physical: [...placement.position],
          rotationYDeg: placement.rotationYDeg,
          mount: placement.mount,
          floorId: placement.floorId,
          roomId: placement.roomId,
          surfaceId: placement.surfaceId,
          locationNote: placement.locationNote,
          photoId: placement.photoId,
          dirty: false,
        });
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
      <div className="rounded-md bg-neutral-900/85 px-3 py-2 text-xs text-white">
        {phase === "validating" ? "Checking the model package…" : `Loading the house… ${pct}%`}
      </div>
    </div>
  );
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
  const endRouteDraft = useHouseStore((s) => s.endRouteDraft);
  const phone = useIsPhone();
  if (!routeDraft || !index) return null;

  const floorId: FloorId | null =
    activeFloorId ?? routeDraft.segments.find((seg) => seg.floorId)?.floorId ?? null;
  const wallSurfaceId =
    selection?.kind === "surface" && index.surfaces.get(selection.id)?.kind === "wall"
      ? selection.id
      : null;

  return (
    <section className="flex flex-col gap-2 border-t border-neutral-200 pt-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Route path — {routeDraft.name}
        </h3>
        <button
          type="button"
          onClick={endRouteDraft}
          className="min-h-8 rounded-md border border-neutral-300 bg-white px-2 text-xs font-medium text-neutral-800 hover:bg-neutral-100"
        >
          Done
        </button>
      </header>
      {phone ? (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 p-2 text-xs text-neutral-600">
          The 2D route editors are read-only on a phone. Edit on a desktop.
        </p>
      ) : null}
      {floorId ? <PlanEditor2D floorId={floorId} /> : null}
      {wallSurfaceId ? <WallElevationEditor2D surfaceId={wallSurfaceId} /> : (
        <p className="text-[11px] text-neutral-500">
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
  const { index, placements } = useHouseStore(
    useShallow((s) => ({ index: s.index, placements: s.placements })),
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !index) return [];
    const out: Array<{ selection: Selection; label: string; secondary: string }> = [];
    for (const room of index.rooms.values()) {
      const haystack = [room.name, room.nameFi ?? "", ...room.aliases].join(" ").toLowerCase();
      if (haystack.includes(q))
        out.push({
          selection: { kind: "room", id: room.id },
          label: room.name,
          secondary: index.floors.get(room.floorId)?.name ?? room.floorId,
        });
    }
    for (const p of placements) {
      if (!p.name.toLowerCase().includes(q)) continue;
      out.push({
        selection: { kind: "equipment", id: p.id },
        label: p.name,
        secondary: p.roomId ? (index.rooms.get(p.roomId)?.name ?? p.roomId) : p.floorId,
      });
    }
    return out.slice(0, 8);
  }, [query, index, placements]);

  const focus = useCallback(
    async (selection: Selection) => {
      const s = runtime.store.getState();
      const manifest = s.index;
      if (!manifest) return;
      const floorId = floorOf(s, selection);
      if (floorId) {
        s.isolateFloor(floorId);
        s.setViewMode("floor");
      }
      runtime.select(selection);
      // The visibility resolver runs in a store subscription, so isolation has already landed;
      // one frame still gives the camera the applied matrices before it fits.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const scene = runtime.index;
      const box = scene
        ? boxForSelection(scene, selection, {
            placement: (id) => runtime.store.getState().placements.find((p) => p.id === id),
            route: (id) => runtime.store.getState().routes.find((r) => r.id === id),
          })
        : null;
      if (box) await runtime.camera?.fitBox(box, { padding: 0.6, clampPolar: true });
      else if (floorId) await runtime.camera?.fitBox(floorBox3(manifest, floorId));
      const text = describeSelection(runtime.store.getState(), selection);
      if (text) runtime.store.getState().announce(text);
    },
    [runtime],
  );

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          const first = results[0];
          if (first) void focus(first.selection);
        }}
        placeholder="Kitchen, door sensor…"
        className="min-h-9 w-full rounded-md border border-neutral-300 px-2 text-xs"
      />
      {results.length ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {results.map((r) => (
            <li key={`${r.selection.kind}:${r.selection.id}`}>
              <button
                type="button"
                onClick={() => void focus(r.selection)}
                className="min-h-8 w-full truncate rounded px-1 text-left text-xs text-neutral-800 hover:bg-neutral-100"
              >
                {r.label}
                <span className="ml-1 text-[10px] text-neutral-500">{r.secondary}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function floorOf(
  s: ReturnType<HouseRuntime["store"]["getState"]>,
  selection: Selection,
): FloorId | null {
  const index = s.index;
  if (!index) return null;
  switch (selection.kind) {
    case "room":
      return index.rooms.get(selection.id)?.floorId ?? null;
    case "floor":
      return selection.id;
    case "surface": {
      const surface = index.surfaces.get(selection.id);
      const roomId = surface?.roomId;
      return roomId ? (index.rooms.get(roomId)?.floorId ?? null) : null;
    }
    case "equipment":
      return s.placements.find((p) => p.id === selection.id)?.floorId ?? null;
    default:
      return null;
  }
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-900/40 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-white p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-900">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-8 rounded-md border border-neutral-300 px-2 text-xs font-medium"
          >
            Close
          </button>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="col-span-2 grid grid-cols-subgrid">
              <dt className="font-mono text-neutral-500">{s.keys}</dt>
              <dd className="text-neutral-800">{s.action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : "Something went wrong.";
