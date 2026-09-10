import type { StateCreator } from "zustand";
import type { EndpointDto } from "@/features/projects/wire";
import type { PlaceableEquipment } from "@/house/store/dataApi";
import type { FloorId, Placement, RoomId, Route, RouteId, RouteKind, RouteSystem, Vec3 } from "@/house/model/types";
import { routePointPlace } from "@/house/model/routePlaces";
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
  /** Unsaved pointer position for the next span. It is presentation state, never persisted. */
  routeDraftHover: { point: Vec3; floorId: FloorId | null; roomId: RoomId | null } | null;
  selectedPointIndex: number | null;
  visibleSystems: Record<RouteSystem, boolean>;
  visibleRouteKinds: Record<RouteKind, boolean>;
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
  insertRoutePoint(
    index: number,
    point: Vec3,
    place?: { floorId: FloorId | null; roomId: RoomId | null },
  ): void;
  setRouteSegmentPlace(
    index: number,
    place: { floorId: FloorId | null; roomId: RoomId | null },
  ): void;
  setRoutePointPlace(
    index: number,
    place: { floorId: FloorId | null; roomId: RoomId | null },
  ): void;
  deleteRoutePoint(index: number): void;
  setRouteDraftHover(
    hover: { point: Vec3; floorId: FloorId | null; roomId: RoomId | null } | null,
  ): void;
  cancelRouteDraft(): void;
  endRouteDraft(): void;
  selectPoint(index: number | null): void;
  toggleSystem(system: RouteSystem): void;
  toggleRouteKind(kind: RouteKind): void;
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
const ALL_ROUTE_KINDS: RouteKind[] = [
  "duct", "pipe", "cable", "valve", "outlet", "switch", "junction", "access-point", "other",
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
  routeDraftHover: null,
  selectedPointIndex: null,
  visibleSystems: Object.fromEntries(ALL_SYSTEMS.map((s) => [s, true])) as Record<
    RouteSystem,
    boolean
  >,
  visibleRouteKinds: Object.fromEntries(ALL_ROUTE_KINDS.map((kind) => [kind, true])) as Record<
    RouteKind,
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
    set((s) => s.editorSaving || s.furnishingsEditing ? {} : ({
      routeDraft: {
        ...route,
        pointPlaces: route.points.map((_, index) => routePointPlace(route, index)),
        pointKinds: route.points.map((_, index) => route.pointKinds?.[index] ?? "vertex"),
      },
      routeDraftIsNew: opts?.isNew ?? false,
      routeDraftOrigin: opts?.isNew ? null : route,
      routeDraftHover: null,
      selectedPointIndex: Math.max(0, route.points.length - 1),
      // A multi-floor run must remain visible as a whole while it is being edited. Keep the
      // camera pose, but clear semantic floor isolation so upper/lower endpoints do not vanish.
      activeFloorId: null,
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

  insertRoutePoint: (index, point, place) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft) return {};
      const points = [...s.routeDraft.points];
      points.splice(index, 0, point);
      const pointKinds = s.routeDraft.points.map((_, i) => s.routeDraft!.pointKinds?.[i] ?? "vertex");
      pointKinds.splice(Math.max(0, Math.min(index, pointKinds.length)), 0, "vertex");
      const pointPlaces = s.routeDraft.points.map((_, i) => routePointPlace(s.routeDraft!, i));
      const template = place ?? pointPlaces[Math.max(0, Math.min(index - 1, pointPlaces.length - 1))] ?? {
        floorId: null,
        roomId: null,
      };
      pointPlaces.splice(Math.max(0, Math.min(index, pointPlaces.length)), 0, { ...template });
      return withDraft(s, {
        ...s.routeDraft,
        points,
        pointKinds,
        pointPlaces,
        segments: pointPlaces.slice(0, -1),
      });
    }),

  setRouteSegmentPlace: (index, place) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft || index < 0 || index >= s.routeDraft.segments.length)
        return {};
      const segments = [...s.routeDraft.segments];
      segments[index] = place;
      const pointPlaces = s.routeDraft.points.map((_, i) => routePointPlace(s.routeDraft!, i));
      pointPlaces[index] = place;
      return withDraft(s, { ...s.routeDraft, segments, pointPlaces });
    }),

  setRoutePointPlace: (index, place) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft || index < 0 || index >= s.routeDraft.points.length)
        return {};
      const pointPlaces = s.routeDraft.points.map((_, i) => routePointPlace(s.routeDraft!, i));
      pointPlaces[index] = place;
      return withDraft(s, {
        ...s.routeDraft,
        pointPlaces,
        segments: pointPlaces.slice(0, -1),
      });
    }),

  deleteRoutePoint: (index) =>
    set((s) => {
      if (s.editorSaving || !s.routeDraft || s.routeDraft.points.length <= 2) return {};
      const points = s.routeDraft.points.filter((_, i) => i !== index);
      const pointPlaces = s.routeDraft.points
        .map((_, i) => routePointPlace(s.routeDraft!, i))
        .filter((_, i) => i !== index);
      const pointKinds = s.routeDraft.points
        .map((_, i) => s.routeDraft!.pointKinds?.[i] ?? "vertex")
        .filter((_, i) => i !== index);
      const segments = pointPlaces.slice(0, -1);
      return {
        ...withDraft(s, { ...s.routeDraft, points, pointPlaces, pointKinds, segments }),
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
      return { routes, routeDraft: null, routeDraftOrigin: null, routeDraftIsNew: false, routeDraftHover: null, selectedPointIndex: null };
    }),

  endRouteDraft: () =>
    set({
      routeDraft: null,
      routeDraftIsNew: false,
      routeDraftOrigin: null,
      routeDraftHover: null,
      selectedPointIndex: null,
    }),

  setRouteDraftHover: (routeDraftHover) => set({ routeDraftHover }),

  selectPoint: (selectedPointIndex) => set({ selectedPointIndex }),

  toggleSystem: (system) =>
    set((s) => ({ visibleSystems: { ...s.visibleSystems, [system]: !s.visibleSystems[system] } })),

  toggleRouteKind: (kind) =>
    set((s) => ({
      visibleRouteKinds: { ...s.visibleRouteKinds, [kind]: !s.visibleRouteKinds[kind] },
    })),

  setDataError: (dataError) => set({ dataError }),
});
