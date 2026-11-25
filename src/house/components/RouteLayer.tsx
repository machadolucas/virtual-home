"use client";
/**
 * The route legend and the 3D handle layer for the polyline editor.
 *
 * The line geometry itself is built imperatively (`scene/routes.ts`); this component only renders
 * the legend and, in edit mode, the draggable point handles.
 *
 * The legend states the confidence convention in words, because a solid line is *not* proof of a
 * verified concealed installation.
 */
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { colorFor, isDashed, SYSTEM_COLORS } from "@/house/scene/routes";
import type { Route, RouteSystem } from "@/house/model/types";
import { hasDocumentedFlow } from "@/house/scene/routeSolids";
import { useReducedMotion } from "../hooks/useReducedMotion";
import { isRouteVisible, routeInViewScope } from "@/house/model/routeVisibility";
import { routePointPlace } from "@/house/model/routePlaces";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useViewerPalette } from "../hooks/useViewerPalette";

const SYSTEM_LABELS: Record<RouteSystem, string> = {
  ventilation: "Ventilation",
  water: "Water",
  electrical: "Electrical",
  network: "Network",
  heating: "Heating",
  drainage: "Drainage",
  other: "Other",
};

export function RouteLegend() {
  const view = useHouseStore(
    useShallow((s) => ({
      routes: s.routes,
      layers: s.layers,
      routeDraft: s.routeDraft,
      activeRoutesOnly: s.activeRoutesOnly,
      visibleRouteKinds: s.visibleRouteKinds,
      visibleSystems: s.visibleSystems,
      toggleSystem: s.toggleSystem,
      showRouteFlow: s.showRouteFlow,
      setShowRouteFlow: s.setShowRouteFlow,
      performanceMode: s.performanceMode,
      renovationDate: s.renovationDate,
    })),
  );
  const { routes, activeRoutesOnly, visibleSystems, toggleSystem, showRouteFlow, setShowRouteFlow, performanceMode, renovationDate } = view;
  const present = useMemo(() => new Set(
    routes.filter((r) => routeInViewScope(r, { activeRoutesOnly, renovationDate })).map((r) => r.system),
  ), [routes, activeRoutesOnly, renovationDate]);

  const reducedMotion = useReducedMotion();
  const flowAvailable = routes.some((r) => hasDocumentedFlow(r) && isRouteVisible(r, view));
  const flowPaused = reducedMotion || performanceMode || renovationDate !== null;
  if (present.size === 0) {
    return activeRoutesOnly && routes.length > 0 ? (
      <p role="status" className="text-xs text-ink-3">No active pipes or ducts in this view.</p>
    ) : null;
  }

  return (
    <section aria-label="Route legend" className="space-y-2 text-xs text-ink-2">
      <ul className="space-y-1">
        {[...present].map((system) => (
          <li key={system}>
            <label className="flex min-h-8 items-center gap-2">
              <input
                type="checkbox"
                checked={visibleSystems[system]}
                onChange={() => toggleSystem(system)}
                className="h-4 w-4"
              />
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-6 rounded"
                style={{ backgroundColor: `#${SYSTEM_COLORS[system].toString(16).padStart(6, "0")}` }}
              />
              {SYSTEM_LABELS[system]}
            </label>
          </li>
        ))}
      </ul>
      <p className="max-w-prose text-ink-3">
        Colours distinguish utility media. Unknown paths are dashed, and inferred solids are
        subdued. Cross-sections are schematic where dimensions are incomplete.
        {activeRoutesOnly ? "" : " Muted solids indicate retained, out-of-service runs. Grey dashes mark planned or removed runs."}
      </p>
      {flowAvailable ? (
        <>
          <label className="flex min-h-8 items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={showRouteFlow && !flowPaused}
              disabled={flowPaused}
              onChange={(event) => setShowRouteFlow(event.target.checked)}
            />
            Animate documented direction
          </label>
          <p className="max-w-prose text-ink-3">
            Pulses illustrate documented direction on in-service runs. This is a schematic.
            {flowPaused ? " Animation is paused in this view or by reduced motion." : ""}
          </p>
        </>
      ) : null}
    </section>
  );
}

/** Draggable handles for the route being edited. One small mesh per point, under the floor group. */
export function RoutePointHandles() {
  const runtime = useHouseRuntime();
  const draft = useHouseStore((s) => s.routeDraft);
  const hover = useHouseStore((s) => s.routeDraftHover);
  const selectedPointIndex = useHouseStore((s) => s.selectedPointIndex);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.05, 10, 8), []);
  const palette = useViewerPalette();

  const pathGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    if (!draft) return geometry;
    const positions: number[] = [];
    const lineDistances: number[] = [];
    for (let i = 1; i < draft.points.length; i++) {
      const a = withOffset(runtime, draft, i - 1, draft.points[i - 1]!);
      const b = withOffset(runtime, draft, i, draft.points[i]!);
      positions.push(...a, ...b);
      lineDistances.push(0, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("lineDistance", new THREE.Float32BufferAttribute(lineDistances, 1));
    return geometry;
  }, [runtime, draft]);
  const hoverGeometry = useMemo(() => {
    const geometry = new THREE.BufferGeometry();
    const last = draft?.points.at(-1);
    if (!draft || !last || !hover) return geometry;
    const sourceOffset = runtime.offsets.get(
      routePointPlace(draft, draft.points.length - 1).floorId ?? "site",
    ) ?? 0;
    const targetOffset = runtime.offsets.get(hover.floorId ?? "site") ?? 0;
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [last[0], last[1] + sourceOffset, last[2], hover.point[0], hover.point[1] + targetOffset, hover.point[2]],
        3,
      ),
    );
    return geometry;
  }, [runtime, draft, hover]);

  useEffect(() => () => pathGeometry.dispose(), [pathGeometry]);
  useEffect(() => () => hoverGeometry.dispose(), [hoverGeometry]);

  if (!draft) return null;

  return (
    <group name="vh-route-handles">
      <lineSegments name="vh-route-draft-path" geometry={pathGeometry} frustumCulled={false} renderOrder={6}>
        {isDashed(draft) ? (
          <lineDashedMaterial color={colorFor(draft)} transparent opacity={0.9} dashSize={0.06} gapSize={0.04} depthTest />
        ) : (
          <lineBasicMaterial color={colorFor(draft)} transparent opacity={0.9} depthTest />
        )}
      </lineSegments>
      <lineSegments name="vh-route-draft-xray" geometry={pathGeometry} frustumCulled={false} renderOrder={7}>
        {isDashed(draft) ? (
          <lineDashedMaterial color={colorFor(draft)} transparent opacity={0.2} dashSize={0.06} gapSize={0.04} depthTest={false} />
        ) : (
          <lineBasicMaterial color={colorFor(draft)} transparent opacity={0.2} depthTest={false} />
        )}
      </lineSegments>
      {hover ? (
        <lineSegments name="vh-route-draft-hover" geometry={hoverGeometry} frustumCulled={false} renderOrder={8}>
          <lineBasicMaterial
            color={palette.routeSelectedPoint}
            transparent
            opacity={0.8}
            depthTest={false}
          />
        </lineSegments>
      ) : null}
      {draft.points.map((point, i) => (
        <mesh
          key={`${draft.id}-${i}`}
          geometry={geometry}
          position={withOffset(runtime, draft, i, point)}
          onPointerDown={(event) => {
            event.stopPropagation();
            runtime.store.getState().setRouteDraftHover(null);
            runtime.store.getState().selectPoint(i);
          }}
        >
          <meshStandardMaterial
            color={selectedPointIndex === i ? palette.routeSelectedPoint : colorFor({
              system: draft.system,
              lifecycle: draft.lifecycle,
              certainty: draft.certainty,
            })}
            roughness={0.4}
            metalness={0}
          />
        </mesh>
      ))}
    </group>
  );
}

function withOffset(
  runtime: ReturnType<typeof useHouseRuntime>,
  route: Route,
  index: number,
  point: readonly [number, number, number],
): [number, number, number] {
  const group = routePointPlace(route, index).floorId ?? "site";
  const offset = runtime.offsets.get(group) ?? 0;
  return [point[0], point[1] + offset, point[2]];
}

export { isDashed };
