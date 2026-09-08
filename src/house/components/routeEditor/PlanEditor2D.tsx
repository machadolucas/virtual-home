"use client";
/**
 * 2D plan route editor.
 *
 * `viewBox` is in **centimetres** and needs no axis flip: the package's plan convention is X to
 * the right and Z downwards, which is exactly SVG's coordinate sense. Live dimensions are what
 * make a plan editor more precise than freehand 3D, so each segment's length and the perpendicular
 * distance to the nearest room edge are drawn as you drag.
 */
import { useCallback, useMemo, useRef } from "react";
import { distanceToRings, snapValue } from "@/house/model/geometry2d";
import { floorBox } from "@/house/model/framingBoxes";
import type { FloorId, Vec2 } from "@/house/model/types";
import { useHouseStore, useShallow } from "../../hooks/useHouseStore";

const M = 100; // centimetres per metre

export function PlanEditor2D({ floorId }: { floorId: FloorId }) {
  const { index, routeDraft, snap, selectedPointIndex } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      routeDraft: s.routeDraft,
      snap: s.snap,
      selectedPointIndex: s.selectedPointIndex,
    })),
  );
  const setRoutePoint = useHouseStore((s) => s.setRoutePoint);
  const insertRoutePoint = useHouseStore((s) => s.insertRoutePoint);
  const deleteRoutePoint = useHouseStore((s) => s.deleteRoutePoint);
  const selectPoint = useHouseStore((s) => s.selectPoint);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);

  const rooms = useMemo(() => index?.roomsByFloor.get(floorId) ?? [], [index, floorId]);
  const box = useMemo(() => (index ? floorBox(index, floorId) : null), [index, floorId]);

  const toModel = useCallback((event: { clientX: number; clientY: number }): Vec2 | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const x = viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width;
    const z = viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height;
    return [x / M, z / M];
  }, []);

  if (!index || !box) return null;

  const viewBox = `${box.min[0] * M} ${box.min[2] * M} ${(box.max[0] - box.min[0]) * M} ${
    (box.max[2] - box.min[2]) * M
  }`;

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const i = dragging.current;
    if (i === null || !routeDraft) return;
    const model = toModel(event);
    if (!model) return;
    const point = routeDraft.points[i];
    if (!point) return;
    setRoutePoint(i, [
      snapValue(model[0], snap.grid),
      point[1], // height is edited in the elevation editor or the numeric field
      snapValue(model[1], snap.grid),
    ]);
  };

  return (
    <div className="flex flex-col gap-2">
      <svg
        ref={svgRef}
        viewBox={viewBox}
        role="img"
        aria-label={`Plan of ${index.floors.get(floorId)?.name ?? floorId}`}
        className="h-auto w-full touch-none rounded-md border border-line bg-surface"
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerLeave={() => {
          dragging.current = null;
        }}
      >
        {rooms.map((room) => (
          <g key={room.id}>
            <polygon
              points={room.footprint.outer.map((p) => `${p[0] * M},${p[1] * M}`).join(" ")}
              fill="var(--vh-paper-2)"
              stroke="var(--vh-line-strong)"
              strokeWidth={2}
            />
            {room.footprint.holes.map((hole, i) => (
              <polygon
                key={i}
                points={hole.map((p) => `${p[0] * M},${p[1] * M}`).join(" ")}
                fill="var(--vh-paper-0)"
                stroke="var(--vh-line-strong)"
                strokeWidth={2}
              />
            ))}
            <text
              x={(index.roomAnchors.get(room.id)?.point[0] ?? 0) * M}
              y={(index.roomAnchors.get(room.id)?.point[2] ?? 0) * M}
              textAnchor="middle"
              className="fill-ink-3"
              style={{ fontSize: 22 }}
            >
              {room.name}
            </text>
          </g>
        ))}

        {routeDraft ? (
          <>
            <polyline
              points={routeDraft.points.map((p) => `${p[0] * M},${p[2] * M}`).join(" ")}
              fill="none"
              stroke="var(--vh-accent)"
              strokeWidth={4}
              strokeDasharray={
                routeDraft.certainty === "inferred" || routeDraft.certainty === "unknown"
                  ? "12 8"
                  : undefined
              }
            />
            {routeDraft.points.slice(1).map((point, i) => {
              const previous = routeDraft.points[i];
              if (!previous) return null;
              const length = Math.hypot(point[0] - previous[0], point[2] - previous[2]);
              return (
                <text
                  key={`dim-${i}`}
                  x={((previous[0] + point[0]) / 2) * M}
                  y={((previous[2] + point[2]) / 2) * M - 8}
                  textAnchor="middle"
                  className="fill-accent"
                  style={{ fontSize: 20 }}
                  onDoubleClick={() =>
                    insertRoutePoint(i + 1, [
                      (previous[0] + point[0]) / 2,
                      (previous[1] + point[1]) / 2,
                      (previous[2] + point[2]) / 2,
                    ])
                  }
                >
                  {length.toFixed(2)} m
                </text>
              );
            })}
            {routeDraft.points.map((point, i) => {
              const clearance = nearestEdgeDistance(rooms, point[0], point[2]);
              return (
                <g key={`p-${i}`}>
                  <circle
                    cx={point[0] * M}
                    cy={point[2] * M}
                    r={selectedPointIndex === i ? 12 : 9}
                    fill={selectedPointIndex === i ? "var(--vh-accent)" : "var(--vh-paper-0)"}
                    stroke="var(--vh-accent)"
                    strokeWidth={3}
                    className="cursor-move"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      dragging.current = i;
                      selectPoint(i);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Delete" || event.key === "Backspace") deleteRoutePoint(i);
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Route point ${i + 1} at x ${point[0].toFixed(2)}, z ${point[2].toFixed(2)}`}
                  />
                  {clearance !== null ? (
                    <text
                      x={point[0] * M + 14}
                      y={point[2] * M - 6}
                      className="fill-ink-3"
                      style={{ fontSize: 18 }}
                    >
                      {clearance.toFixed(2)} m to wall
                    </text>
                  ) : null}
                </g>
              );
            })}
          </>
        ) : null}
      </svg>
      <p className="text-[11px] text-ink-3">
        North is up in model orientation. True north is {index.manifest.coordinateSystem.north?.bearingDeg ?? "?"}
        ° ({index.manifest.coordinateSystem.north?.certainty ?? "unknown"}) — the plan is never
        silently rotated.
      </p>
    </div>
  );
}

function nearestEdgeDistance(
  rooms: ReadonlyArray<{ footprint: { outer: Vec2[]; holes: Vec2[][] } }>,
  x: number,
  z: number,
): number | null {
  let best: number | null = null;
  for (const room of rooms) {
    const d = distanceToRings(x, z, [room.footprint.outer, ...room.footprint.holes]);
    if (best === null || d < best) best = d;
  }
  return best;
}
