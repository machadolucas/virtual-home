import * as THREE from "three";
import type { VentilationFan } from "@/domain/ventilationFeedback";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { polylineLength } from "@/house/model/geometry2d";
import { isActivePipeOrDuct } from "@/house/model/routeVisibility";
import type { Route } from "@/house/model/types";
import { ClipGroups } from "@/house/scene/clipGroups";
import { RouteLayer, type RenderRoute } from "@/house/scene/routes";
import { createRouteFlowState, routeBodyProfile } from "@/house/scene/routeSolids";
import { createSceneIndex, type SceneIndex } from "@/house/scene/SceneIndex";
import { clipWallRoutes, type WallPatch } from "./wallPatch";

export type MixedRealityRouteFilter = "pipes" | "ducts" | "both";

export type MixedRealityRoutePick = Pick<Route, "id" | "name" | "kind" | "certainty"> & { label: string; sizeDetail?: string; distance: number; segment: readonly [Route["points"][number], Route["points"][number]]; approximate: boolean };

export const isApproximateRoute = (route: Route): boolean =>
  route.certainty === "inferred" || route.certainty === "unknown" ||
  (route.isEstimated ?? route.certainty !== "measured");

function sizeDetail(route: Route): string {
  const { width, height, radius, silencer } = routeBodyProfile(route);
  const mm = (value: number) => Math.round(value * 10_000) / 10;
  if (width && height) return `Width ${mm(width)} mm recorded · height ${mm(height)} mm schematic`;
  const diameter = `Ø${mm(radius * 2)} mm`;
  if (silencer && route.diameterM) return `${diameter} connection recorded · casing schematic`;
  if (silencer) return `${diameter} schematic connection · casing schematic`;
  return route.diameterM ? `${diameter} recorded` : `Schematic diameter · ${diameter}`;
}

/** Keep contiguous spans so separate portions of a route never gain a connecting line across floors. */
export function mixedRealityRuns(
  routes: readonly Route[],
  floorId: string,
  filter: MixedRealityRouteFilter,
): RenderRoute[] {
  const runs: RenderRoute[] = [];
  for (const route of routes) {
    if (!isActivePipeOrDuct(route) || route.needsReconciliation) continue;
    if (filter !== "both" && (filter === "pipes" ? route.kind !== "pipe" : route.kind !== "duct")) continue;
    let start: number | null = null;
    const total = polylineLength(route.points);
    let station = 0, runStart = 0;
    for (let i = 0; i < route.points.length; i++) {
      const a = route.points[i];
      const b = route.points[i + 1];
      const spansFloor = route.segments[i]?.floorId === floorId;
      const startFloor = route.pointPlaces?.[i]?.floorId;
      const endFloor = route.pointPlaces?.[i + 1]?.floorId;
      const length = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : 0;
      const spanStart = station;
      station += length;
      if (a && b && spansFloor && (!startFloor || startFloor === floorId) && (!endFloor || endFloor === floorId) && length >= 1e-5) {
        if (start === null) { start = i; runStart = spanStart; }
        continue;
      }
      if (start === null) continue;
      runs.push({
        ...route,
        arcStartM: runStart, arcLengthM: total,
        points: route.points.slice(start, i + 1),
        segments: route.segments.slice(start, i),
        pointPlaces: route.pointPlaces?.slice(start, i + 1),
        pointKinds: route.pointKinds?.slice(start, i + 1),
        endpoints: [],
      });
      start = null;
    }
  }
  return runs;
}

export function buildMixedRealityOverlay(
  manifest: ManifestIndex,
  routes: readonly Route[],
  floorId: string,
  sourceIndex?: SceneIndex | null,
) {
  const group = new THREE.Group();
  group.name = "vh-mixed-reality-routes";
  group.visible = false;
  group.matrixAutoUpdate = false;
  const flow = createRouteFlowState();
  const clip = new ClipGroups([floorId]);
  function createLayer(name: string) {
    const index = createSceneIndex(manifest);
    // Mount the grilles against the same finished wall surfaces as desktop, while
    // keeping MR visibility, transforms and GPU resources in a separate overlay.
    if (sourceIndex?.manifest === manifest) {
      index.surfaceMesh = sourceIndex.surfaceMesh;
      index.floorNodes = sourceIndex.floorNodes;
    }
    const root = index.overlay.root;
    root.name = name;
    group.add(root);
    return { root, layer: new RouteLayer(index, clip, flow) };
  }
  const floor = createLayer("vh-mr-floor-routes");
  const patch = createLayer("vh-mr-wall-routes");
  patch.root.removeFromParent();
  let patchSpec: WallPatch | null = null;
  let patchRuns: Route[] = [];
  let patchCount = 0;
  patch.root.visible = false;
  let trace: (ReturnType<typeof createLayer> & { id: string; runs: Route[] }) | null = null;
  const activeTrace = () => trace?.root.visible ? trace : null;
  let filter: MixedRealityRouteFilter = "both";
  let source = routes;
  let outletNeighbors: Route[] = [];
  let eligible: Route[] = [];
  let count = 0;
  const localRay = new THREE.Ray();
  const inverse = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const rayPoint = new THREE.Vector3();

  function draw({ layer, root }: ReturnType<typeof createLayer>, runs: Route[]): void {
    layer.set(runs, { tubes: true, mixedReality: { approximatePath: isApproximateRoute, outletNeighbors } });
    root.traverse((object) => {
      const material = (object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material;
      if (material instanceof THREE.MeshStandardMaterial) {
        // Let nearer pipes occlude the far side of a bend and the duct behind a crossing.
        // Passthrough fills the space around the runs.
        material.emissive.copy(material.color);
        material.emissiveIntensity = 0.09;
        if (!material.vertexColors) material.roughness = 0.53;
      }
    });
  }

  function disposeTrace() {
    if (!trace) return;
    trace.layer.dispose();
    trace.root.removeFromParent();
    trace = null;
    baseVisibility();
  }

  function baseVisibility() {
    floor.root.visible = !patchSpec;
    patch.root.visible = !!patchSpec;
  }

  function drawPatch() {
    patchRuns = patchSpec ? clipWallRoutes(mixedRealityRuns(source, floorId, "both")
      .filter((route) => route.modelId === manifest.modelId), patchSpec) : [];
    patchCount = new Set(patchRuns.map(({ id }) => id)).size;
    draw(patch, patchRuns);
    if (patchSpec && !patch.root.parent) group.add(patch.root);
    if (!patchSpec) patch.root.removeFromParent();
    baseVisibility();
  }

  function rebuild(): void {
    disposeTrace();
    outletNeighbors = source.filter(r => r.modelId === manifest.modelId && r.kind === "duct" && isActivePipeOrDuct(r) && !r.needsReconciliation);
    eligible = mixedRealityRuns(source, floorId, filter).filter((r) => r.modelId === manifest.modelId);
    count = new Set(eligible.map(({ id }) => id)).size;
    draw(floor, eligible);
    if (patchSpec) drawPatch();
  }

  function clearFocus() {
    const current = activeTrace();
    if (!current) return;
    current.root.visible = false;
    baseVisibility();
  }

  rebuild();
  return {
    group,
    get count() { return activeTrace() ? 1 : patchSpec ? patchCount : count; },
    get focusedId() { return activeTrace()?.id ?? null; },
    get patchRoutes() { return patchRuns as readonly Route[]; },
    setWallPatch(next: WallPatch | null) {
      if (patchSpec === next) return;
      disposeTrace();
      patchSpec = next;
      drawPatch();
    },
    clearFocus,
    toggleFocus(routeId: string | null) {
      const current = activeTrace();
      if (!group.visible) return current?.id ?? null;
      if (routeId === null || routeId === current?.id) clearFocus();
      else if (!current) {
        if (trace?.id !== routeId) {
          const runs = (patchSpec ? patchRuns : eligible).filter(({ id }) => id === routeId);
          if (!runs.length) return null;
          disposeTrace();
          trace = { ...createLayer("vh-mr-focused-route"), id: routeId, runs };
          draw(trace, runs);
        }
        floor.root.visible = false;
        patch.root.visible = false;
        trace.root.visible = true;
      }
      return activeTrace()?.id ?? null;
    },
    applyTransform(matrix: THREE.Matrix4 | null) {
      group.visible = matrix !== null;
      if (!matrix) {
        clearFocus();
        return;
      }
      group.matrix.copy(matrix);
      group.matrixWorldNeedsUpdate = true;
    },
    setFilter(next: MixedRealityRouteFilter) {
      if (filter === next) {
        clearFocus();
        return;
      }
      filter = next;
      rebuild();
    },
    setRoutes(next: readonly Route[]) {
      if (source === next) return;
      source = next;
      rebuild();
    },
    tick(delta: number, enabled: boolean, fanRates: Readonly<Record<VentilationFan, number>>) {
      return (activeTrace() ?? (patchSpec ? patch : floor)).layer.tick(delta, enabled, fanRates);
    },
    pick(ray: THREE.Ray): MixedRealityRoutePick | null {
      if (!group.visible) return null;
      group.updateWorldMatrix(true, false, true);
      localRay.copy(ray).applyMatrix4(inverse.copy(group.matrixWorld).invert());
      let route: Route | undefined;
      let bestDistance = Infinity;
      let segmentEnd = 0;
      for (const span of activeTrace()?.runs ?? (patchSpec ? patchRuns : eligible)) {
        const radius = Math.max(.055, routeBodyProfile(span).outerRadius);
        for (let i = 1; i < span.points.length; i++) {
          a.fromArray(span.points[i - 1]!);
          b.fromArray(span.points[i]!);
          const gapSquared = localRay.distanceSqToSegment(a, b, rayPoint);
          const distance = localRay.origin.distanceTo(rayPoint);
          if (gapSquared <= radius * radius && distance > 0 && distance < bestDistance) {
            route = span;
            segmentEnd = i;
            bestDistance = distance;
          }
        }
      }
      if (!route) return null;
      return {
        id: route.id, distance:bestDistance,
        segment: [route.points[segmentEnd - 1]!, route.points[segmentEnd]!], approximate: isApproximateRoute(route),
        name: route.name,
        sizeDetail: sizeDetail(route),
        kind: route.kind,
        certainty: route.certainty,
        label: isApproximateRoute(route)
          ? `${route.name} · Approximate concealed route`
          : `${route.name} · ${route.certainty} path`,
      };
    },
    dispose() {
      disposeTrace();
      floor.layer.dispose();
      patch.layer.dispose();
      group.removeFromParent();
      group.clear();
      eligible = [];
      count = 0;
    },
  };
}
