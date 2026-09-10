import type { Route, RoutePointPlace } from "./types";

/** Preserve each vertex's location; only old in-memory drafts inherit from their spans. */
export function routePointPlace(route: Pick<Route, "pointPlaces" | "segments">, index: number): RoutePointPlace {
  return route.pointPlaces?.[index] ??
    route.segments[Math.min(index, Math.max(0, route.segments.length - 1))] ??
    { floorId: null, roomId: null };
}
