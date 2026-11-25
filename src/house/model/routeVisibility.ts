import { isRunVisibleOn } from "@/features/projects/renovationDate";
import type { Route, RouteId, RouteKind, RouteSystem } from "./types";

interface RouteScope {
  activeRoutesOnly: boolean;
  renovationDate: string | null;
}

export interface RouteVisibility extends RouteScope {
  layers: { routes: boolean };
  routeDraft: { id: RouteId } | null;
  visibleSystems: Readonly<Record<RouteSystem, boolean>>;
  visibleRouteKinds: Readonly<Record<RouteKind, boolean>>;
}

/** Service status is independent of path confidence and whether flow direction is known. */
export function isActivePipeOrDuct(route: Pick<Route, "kind" | "lifecycle" | "flowState">): boolean {
  return route.lifecycle === "installed" && route.flowState === "active" &&
    (route.kind === "pipe" || route.kind === "duct");
}

/** Available legend choices must survive their own kind and system switches. */
export function routeInViewScope(route: Route, scope: RouteScope): boolean {
  return (!scope.activeRoutesOnly || isActivePipeOrDuct(route)) &&
    isRunVisibleOn(route, scope.renovationDate);
}

export function isRouteVisible(route: Route, view: RouteVisibility): boolean {
  return view.layers.routes && route.id !== view.routeDraft?.id &&
    view.visibleSystems[route.system] && view.visibleRouteKinds[route.kind] &&
    routeInViewScope(route, view);
}
