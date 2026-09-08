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
import { useMemo } from "react";
import * as THREE from "three";
import { colorFor, isDashed, SYSTEM_COLORS } from "@/house/scene/routes";
import type { Route, RouteSystem } from "@/house/model/types";
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
  const { routes, visibleSystems, toggleSystem } = useHouseStore(
    useShallow((s) => ({
      routes: s.routes,
      visibleSystems: s.visibleSystems,
      toggleSystem: s.toggleSystem,
    })),
  );
  const present = useMemo(() => {
    const set = new Set<RouteSystem>();
    for (const r of routes) set.add(r.system);
    return [...set];
  }, [routes]);

  if (present.length === 0) return null;

  return (
    <section aria-label="Route legend" className="space-y-2 text-xs text-ink-2">
      <ul className="space-y-1">
        {present.map((system) => (
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
        Line position is drawn; confidence is shown by style — solid for measured, dashed for
        inferred. A solid line is not proof of a verified concealed installation.
      </p>
    </section>
  );
}

/** Draggable handles for the route being edited. One small mesh per point, under the floor group. */
export function RoutePointHandles() {
  const runtime = useHouseRuntime();
  const draft = useHouseStore((s) => s.routeDraft);
  const selectedPointIndex = useHouseStore((s) => s.selectedPointIndex);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.05, 10, 8), []);
  const palette = useViewerPalette();

  if (!draft) return null;

  return (
    <group name="vh-route-handles">
      {draft.points.map((point, i) => (
        <mesh
          key={`${draft.id}-${i}`}
          geometry={geometry}
          position={withOffset(runtime, draft, i, point)}
          onPointerDown={(event) => {
            event.stopPropagation();
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
  const group = route.segments[Math.min(index, route.segments.length - 1)]?.floorId ?? "site";
  const offset = runtime.offsets.get(group) ?? 0;
  return [point[0], point[1] + offset, point[2]];
}

export { isDashed };
