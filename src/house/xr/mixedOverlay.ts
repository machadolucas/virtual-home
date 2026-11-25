import * as THREE from "three";
import type { VentilationFan } from "@/domain/ventilationFeedback";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import { isActivePipeOrDuct } from "@/house/model/routeVisibility";
import type { Route } from "@/house/model/types";
import { ClipGroups } from "@/house/scene/clipGroups";
import { RouteLayer } from "@/house/scene/routes";
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
  const index = createSceneIndex(manifest);
  const group = index.overlay.root;
  group.name = "vh-mixed-reality-routes";
  group.visible = false;
  group.matrixAutoUpdate = false;
  const layer = new RouteLayer(index, new ClipGroups([floorId]));
  let filter: MixedRealityRouteFilter = "both";
  let source = routes;
  let runs: Route[] = [];
  let count = 0;
  const localRay = new THREE.Ray();
  const inverse = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const rayPoint = new THREE.Vector3();
  const styled = new WeakSet<THREE.Material>();

  function rebuild(): void {
    runs = mixedRealityRuns(source, floorId, filter).filter((r) => r.modelId === manifest.modelId);
    count = new Set(runs.map(({ id }) => id)).size;
    layer.set(runs, { tubes: true, approximatePaths: isApproximate });
    group.traverse((object) => {
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

  rebuild();
  return {
    group,
    get count() { return count; },
    applyTransform(matrix: THREE.Matrix4 | null) {
      group.visible = matrix !== null;
      if (!matrix) return;
      group.matrix.copy(matrix);
      group.matrixWorldNeedsUpdate = true;
    },
    setFilter(next: MixedRealityRouteFilter) {
      if (filter === next) return;
      filter = next;
      rebuild();
    },
    setRoutes(next: readonly Route[]) {
      if (source === next) return;
      source = next;
      rebuild();
    },
    tick(delta: number, enabled: boolean, fanRates: Readonly<Record<VentilationFan, number>>) {
      return layer.tick(delta, enabled, fanRates);
    },
    pick(ray: THREE.Ray): MixedRealityRoutePick | null {
      if (!group.visible) return null;
      group.updateWorldMatrix(true, false, true);
      localRay.copy(ray).applyMatrix4(inverse.copy(group.matrixWorld).invert());
      let route: Route | undefined;
      let bestDistance = Infinity;
      let segmentEnd = 0;
      for (const span of runs) {
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
      layer.dispose();
      group.removeFromParent();
      group.clear();
      runs = [];
      count = 0;
    },
  };
}
