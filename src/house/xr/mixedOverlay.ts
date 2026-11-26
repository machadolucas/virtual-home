import * as THREE from "three";
import type { VentilationFan } from "@/domain/ventilationFeedback";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { isActivePipeOrDuct } from "@/house/model/routeVisibility";
import type { Route } from "@/house/model/types";
import { ClipGroups } from "@/house/scene/clipGroups";
import { RouteLayer } from "@/house/scene/routes";
import { createRouteFlowState } from "@/house/scene/routeSolids";
import { createSceneIndex } from "@/house/scene/SceneIndex";

export type MixedRealityRouteFilter = "pipes" | "ducts" | "both";

export type MixedRealityRoutePick = Pick<Route, "id" | "name" | "kind" | "certainty"> & { label: string; distance: number; segment: readonly [Route["points"][number], Route["points"][number]]; approximate: boolean };

const isApproximate = (route: Route): boolean =>
  route.certainty === "inferred" || route.certainty === "unknown" ||
  (route.isEstimated ?? route.certainty !== "measured");

const squaredSpanLength = (a: Route["points"][number], b: Route["points"][number]): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Keep contiguous spans so separate portions of a route never gain a connecting line across floors. */
export function mixedRealityRuns(
  routes: readonly Route[],
  floorId: string,
  filter: MixedRealityRouteFilter,
): Route[] {
  const runs: Route[] = [];
  for (const route of routes) {
    if (!isActivePipeOrDuct(route) || route.needsReconciliation) continue;
    if (filter !== "both" && (filter === "pipes" ? route.kind !== "pipe" : route.kind !== "duct")) continue;
    let start: number | null = null;
    for (let i = 0; i < route.points.length; i++) {
      const a = route.points[i];
      const b = route.points[i + 1];
      const spansFloor = route.segments[i]?.floorId === floorId;
      const startFloor = route.pointPlaces?.[i]?.floorId;
      const endFloor = route.pointPlaces?.[i + 1]?.floorId;
      if (a && b && spansFloor && (!startFloor || startFloor === floorId) && (!endFloor || endFloor === floorId) &&
        squaredSpanLength(a, b) >= 1e-10) {
        start ??= i;
        continue;
      }
      if (start === null) continue;
      runs.push({
        ...route,
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
) {
  const group = new THREE.Group();
  group.name = "vh-mixed-reality-routes";
  group.visible = false;
  group.matrixAutoUpdate = false;
  const flow = createRouteFlowState();
  const clip = new ClipGroups([floorId]);
  function createLayer(name: string) {
    const index = createSceneIndex(manifest);
    const root = index.overlay.root;
    root.name = name;
    group.add(root);
    return { root, layer: new RouteLayer(index, clip, flow) };
  }
  const floor = createLayer("vh-mr-floor-routes");
  let trace: (ReturnType<typeof createLayer> & { id: string; runs: Route[] }) | null = null;
  const activeTrace = () => trace?.root.visible ? trace : null;
  let filter: MixedRealityRouteFilter = "both";
  let source = routes;
  let eligible: Route[] = [];
  let count = 0;
  const localRay = new THREE.Ray();
  const inverse = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const rayPoint = new THREE.Vector3();
  const styled = new WeakSet<THREE.Material>();

  function draw({ layer, root }: ReturnType<typeof createLayer>, runs: Route[]): void {
    layer.set(runs, { tubes: true, approximatePaths: isApproximate });
    root.traverse((object) => {
      const material = (object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material;
      if (!material || styled.has(material)) return;
      styled.add(material);
      // There is no physical occlusion map here. Soft, translucent graphics always read as an overlay.
      material.transparent = true;
      material.depthWrite = false;
      material.opacity *= object.userData.vhApproximatePath === true ? 0.52 : 0.63;
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissive.copy(material.color);
        material.emissiveIntensity = 0.25;
      }
    });
  }

  function disposeTrace() {
    if (!trace) return;
    trace.layer.dispose();
    trace.root.removeFromParent();
    trace = null;
    floor.root.visible = true;
  }

  function rebuild(): void {
    disposeTrace();
    eligible = mixedRealityRuns(source, floorId, filter).filter((r) => r.modelId === manifest.modelId);
    count = new Set(eligible.map(({ id }) => id)).size;
    draw(floor, eligible);
  }

  function clearFocus() {
    const current = activeTrace();
    if (!current) return;
    current.root.visible = false;
    floor.root.visible = true;
  }

  rebuild();
  return {
    group,
    get count() { return activeTrace() ? 1 : count; },
    get focusedId() { return activeTrace()?.id ?? null; },
    clearFocus,
    toggleFocus(routeId: string | null) {
      const current = activeTrace();
      if (!group.visible) return current?.id ?? null;
      if (routeId === null || routeId === current?.id) clearFocus();
      else if (!current) {
        if (trace?.id !== routeId) {
          const runs = eligible.filter(({ id }) => id === routeId);
          if (!runs.length) return null;
          disposeTrace();
          trace = { ...createLayer("vh-mr-focused-route"), id: routeId, runs };
          draw(trace, runs);
        }
        floor.root.visible = false;
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
      return (activeTrace() ?? floor).layer.tick(delta, enabled, fanRates);
    },
    pick(ray: THREE.Ray): MixedRealityRoutePick | null {
      if (!group.visible) return null;
      group.updateWorldMatrix(true, false, true);
      localRay.copy(ray).applyMatrix4(inverse.copy(group.matrixWorld).invert());
      let route: Route | undefined;
      let bestDistance = Infinity;
      let segmentEnd = 0;
      for (const span of activeTrace()?.runs ?? eligible) {
        for (let i = 1; i < span.points.length; i++) {
          a.fromArray(span.points[i - 1]!);
          b.fromArray(span.points[i]!);
          const gapSquared = localRay.distanceSqToSegment(a, b, rayPoint);
          const distance = localRay.origin.distanceTo(rayPoint);
          const radius = Math.max(0.055, (span.diameterM ?? span.widthM ?? 0) / 2);
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
        segment: [route.points[segmentEnd - 1]!, route.points[segmentEnd]!], approximate: isApproximate(route),
        name: route.name,
        kind: route.kind,
        certainty: route.certainty,
        label: isApproximate(route)
          ? `${route.name} · Approximate concealed route`
          : `${route.name} · ${route.certainty} path`,
      };
    },
    dispose() {
      disposeTrace();
      floor.layer.dispose();
      group.removeFromParent();
      group.clear();
      eligible = [];
      count = 0;
    },
  };
}
