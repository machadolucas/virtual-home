import type { StateCreator } from "zustand";
import type { EndpointDto } from "@/features/projects/wire";
import type { PlaceableEquipment } from "@/house/store/dataApi";
import type { Placement, Route, RouteId, RouteSystem } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface RouteSlice {
  placements: Placement[];
  /** Equipment that exists but is not placed in this model yet — what "place this" acts on. */
  placeable: PlaceableEquipment[];
  routes: Route[];
  /**
   * The fixed things routes run between — a manifold, a shutoff, a meter, a duct inlet. Loaded by
   * whoever needs them (the workspace shell does not hydrate them), kept here so the route form
   * and the endpoint form agree on one list.
   */
  endpoints: EndpointDto[];
  /** Route being edited; `points` stay physical site coordinates at all times. */
  routeDraft: Route | null;
  /** True while the draft is a run that does not exist on the server yet. */
  routeDraftIsNew: boolean;
  /**
   * The route as it was when the draft opened, so discarding restores it. `null` for a new run:
   * there is nothing to go back to, and the caller removes it instead.
   */
  routeDraftOrigin: Route | null;
  selectedPointIndex: number | null;
  visibleSystems: Record<RouteSystem, boolean>;
  dataError: string | null;

  setPlacements(placements: Placement[]): void;
  upsertPlacement(placement: Placement): void;
  removePlacement(id: string): void;
  setPlaceable(placeable: PlaceableEquipment[]): void;
  /** Drop one from the not-placed list once it has a position. */
  markPlaced(assetId: string): void;
  /** Put one back on that list when its placement is removed. */
  restorePlaceable(equipment: PlaceableEquipment): void;
  setRoutes(routes: Route[]): void;
  upsertRoute(route: Route): void;
  removeRoute(id: RouteId): void;
  setEndpoints(endpoints: EndpointDto[]): void;
  upsertEndpoint(endpoint: EndpointDto): void;
  removeEndpoint(id: string): void;
  beginRouteDraft(route: Route, opts?: { isNew?: boolean }): void;
  updateRouteDraft(patch: Partial<Route>): void;
  setRoutePoint(index: number, point: [number, number, number]): void;
  insertRoutePoint(index: number, point: [number, number, number]): void;
  deleteRoutePoint(index: number): void;
  cancelRouteDraft(): void;
  endRouteDraft(): void;
  selectPoint(index: number | null): void;
  toggleSystem(system: RouteSystem): void;
  setDataError(message: string | null): void;
}

const ALL_SYSTEMS: RouteSystem[] = [
  "ventilation",
  "water",
  "electrical",
  "network",
  "heating",
  "drainage",
  "other",
];

/**
 * A draft edit, mirrored into `routes` whenever that run is already in the list.
 *
 * The 3D line geometry is built from `routes` (`scene/routes.ts`); only the point handles read the
 * draft. Without the mirror a dragged point moved its handle and left the line behind, and a run
 * being drawn for the first time was invisible until it was saved. Mirroring only a route the
 * caller has already put in the list keeps that explicit: a draft nobody added is not silently
 * drawn.
 */
function withDraft(s: HouseStore, routeDraft: Route): Partial<RouteSlice> {
  const i = s.routes.findIndex((r) => r.id === routeDraft.id);
  if (i < 0) return { routeDraft };
  const routes = [...s.routes];
  routes[i] = routeDraft;
  return { routeDraft, routes };
}

export const createRouteSlice: StateCreator<HouseStore, Mutators, [], RouteSlice> = (set) => ({
  placements: [],
  placeable: [],
  routes: [],
  endpoints: [],
  routeDraft: null,
  routeDraftIsNew: false,
  routeDraftOrigin: null,
  selectedPointIndex: null,
  visibleSystems: Object.fromEntries(ALL_SYSTEMS.map((s) => [s, true])) as Record<
    RouteSystem,
    boolean
  >,
  dataError: null,

  setPlacements: (placements) => set({ placements }),

  upsertPlacement: (placement) =>
    set((s) => {
      const i = s.placements.findIndex((p) => p.id === placement.id);
      if (i < 0) return { placements: [...s.placements, placement] };
      const next = [...s.placements];
      next[i] = placement;
      return { placements: next };
    }),

  removePlacement: (id) => set((s) => ({ placements: s.placements.filter((p) => p.id !== id) })),

  setPlaceable: (placeable) => set({ placeable }),

  markPlaced: (assetId) =>
    set((s) => ({ placeable: s.placeable.filter((e) => e.assetId !== assetId) })),

  restorePlaceable: (equipment) =>
    set((s) =>
      s.placeable.some((e) => e.assetId === equipment.assetId)
        ? {}
        : { placeable: [...s.placeable, equipment].sort((a, b) => a.name.localeCompare(b.name)) },
    ),

  setRoutes: (routes) => set({ routes }),

  upsertRoute: (route) =>
    set((s) => {
      const i = s.routes.findIndex((r) => r.id === route.id);
      if (i < 0) return { routes: [...s.routes, route] };
      const next = [...s.routes];
      next[i] = route;
      return { routes: next };
    }),

  removeRoute: (id) => set((s) => ({ routes: s.routes.filter((r) => r.id !== id) })),

  setEndpoints: (endpoints) => set({ endpoints }),

  upsertEndpoint: (endpoint) =>
    set((s) => {
      const i = s.endpoints.findIndex((e) => e.id === endpoint.id);
      if (i < 0) return { endpoints: [...s.endpoints, endpoint] };
      const next = [...s.endpoints];
      next[i] = endpoint;
      return { endpoints: next };
    }),

  removeEndpoint: (id) => set((s) => ({ endpoints: s.endpoints.filter((e) => e.id !== id) })),

  beginRouteDraft: (route, opts) =>
    set((s) => s.editorSaving ? {} : ({
      routeDraft: route,
      routeDraftIsNew: opts?.isNew ?? false,
      routeDraftOrigin: opts?.isNew ? null : route,
      selectedPointIndex: null,
    })),

  updateRouteDraft: (patch) =>
    set((s) => (s.routeDraft && !s.editorSaving ? withDraft(s, { ...s.routeDraft, ...patch }) : {})),

  setRoutePoint: (index, point) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft || index < 0 || index >= s.routeDraft.points.length) return {};
      const points = [...s.routeDraft.points];
      points[index] = point;
      return withDraft(s, { ...s.routeDraft, points });
    }),

  insertRoutePoint: (index, point) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft) return {};
      const points = [...s.routeDraft.points];
      points.splice(index, 0, point);
      const segments = [...s.routeDraft.segments];
      const template = segments[Math.max(0, Math.min(index - 1, segments.length - 1))] ?? {
        floorId: null,
        roomId: null,
      };
      segments.splice(Math.max(0, index - 1), 0, { ...template });
      return withDraft(s, { ...s.routeDraft, points, segments });
    }),

  deleteRoutePoint: (index) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft || s.routeDraft.points.length <= 2) return {};
      const points = s.routeDraft.points.filter((_, i) => i !== index);
      const segments = s.routeDraft.segments.slice(0, Math.max(0, points.length - 1));
      return {
        ...withDraft(s, { ...s.routeDraft, points, segments }),
        selectedPointIndex: null,
      };
    }),

  cancelRouteDraft: () =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft) return {};
      const id = s.routeDraft.id;
      const routes = s.routeDraftIsNew
        ? s.routes.filter((route) => route.id !== id)
        : s.routes.map((route) => route.id === id ? (s.routeDraftOrigin ?? route) : route);
      return { routes, routeDraft: null, routeDraftOrigin: null, routeDraftIsNew: false, selectedPointIndex: null };
    }),

  endRouteDraft: () =>
    set({
      routeDraft: null,
      routeDraftIsNew: false,
      routeDraftOrigin: null,
      selectedPointIndex: null,
    }),

  selectPoint: (selectedPointIndex) => set({ selectedPointIndex }),

  toggleSystem: (system) =>
    set((s) => ({ visibleSystems: { ...s.visibleSystems, [system]: !s.visibleSystems[system] } })),

  setDataError: (dataError) => set({ dataError }),
});
