import type { StateCreator } from "zustand";
import type { Placement, Route, RouteId, RouteSystem } from "@/house/model/types";
import type { HouseStore, Mutators } from "../createHouseStore";

export interface RouteSlice {
  placements: Placement[];
  routes: Route[];
  /** Route being edited; `points` stay physical site coordinates at all times. */
  routeDraft: Route | null;
  selectedPointIndex: number | null;
  visibleSystems: Record<RouteSystem, boolean>;
  dataError: string | null;

  setPlacements(placements: Placement[]): void;
  upsertPlacement(placement: Placement): void;
  removePlacement(id: string): void;
  setRoutes(routes: Route[]): void;
  upsertRoute(route: Route): void;
  removeRoute(id: RouteId): void;
  beginRouteDraft(route: Route): void;
  updateRouteDraft(patch: Partial<Route>): void;
  setRoutePoint(index: number, point: [number, number, number]): void;
  insertRoutePoint(index: number, point: [number, number, number]): void;
  deleteRoutePoint(index: number): void;
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

export const createRouteSlice: StateCreator<HouseStore, Mutators, [], RouteSlice> = (set) => ({
  placements: [],
  routes: [],
  routeDraft: null,
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

  beginRouteDraft: (route) => set({ routeDraft: route, selectedPointIndex: null }),

  updateRouteDraft: (patch) =>
    set((s) => (s.routeDraft ? { routeDraft: { ...s.routeDraft, ...patch } } : {})),

  setRoutePoint: (index, point) =>
    set((s) => {
      if (!s.routeDraft || index < 0 || index >= s.routeDraft.points.length) return {};
      const points = [...s.routeDraft.points];
      points[index] = point;
      return { routeDraft: { ...s.routeDraft, points } };
    }),

  insertRoutePoint: (index, point) =>
    set((s) => {
      if (!s.routeDraft) return {};
      const points = [...s.routeDraft.points];
      points.splice(index, 0, point);
      const segments = [...s.routeDraft.segments];
      const template = segments[Math.max(0, Math.min(index - 1, segments.length - 1))] ?? {
        floorId: null,
        roomId: null,
      };
      segments.splice(Math.max(0, index - 1), 0, { ...template });
      return { routeDraft: { ...s.routeDraft, points, segments } };
    }),

  deleteRoutePoint: (index) =>
    set((s) => {
      if (!s.routeDraft || s.routeDraft.points.length <= 2) return {};
      const points = s.routeDraft.points.filter((_, i) => i !== index);
      const segments = s.routeDraft.segments.slice(0, Math.max(0, points.length - 1));
      return {
        routeDraft: { ...s.routeDraft, points, segments },
        selectedPointIndex: null,
      };
    }),

  endRouteDraft: () => set({ routeDraft: null, selectedPointIndex: null }),

  selectPoint: (selectedPointIndex) => set({ selectedPointIndex }),

  toggleSystem: (system) =>
    set((s) => ({ visibleSystems: { ...s.visibleSystems, [system]: !s.visibleSystems[system] } })),

  setDataError: (dataError) => set({ dataError }),
});
