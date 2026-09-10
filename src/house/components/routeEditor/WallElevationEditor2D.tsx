"use client";
/**
 * Wall-elevation editor: edit a route in one wall's own plane.
 *
 * Horizontal axis is along the wall, vertical is height **above the room's own floor**. The wall's
 * openings are overlaid from the manifest's element `properties.width/sill/head`, so a note like
 * "the cable runs 20 cm above the window head" is recordable rather than approximated.
 */
import { useMemo } from "react";
import { snapValue } from "@/house/model/geometry2d";
import type { SurfaceId } from "@/house/model/types";
import { wallFrame } from "@/house/scene/wallFrame";
import { routePointPlace } from "@/house/model/routePlaces";
import * as THREE from "three";
import { useHouseRuntime, useHouseStore, useShallow } from "../../hooks/useHouseStore";

const M = 100;

interface Opening {
  id: string;
  kind: string;
  width: number;
  sill: number;
  head: number;
}

export function WallElevationEditor2D({ surfaceId }: { surfaceId: SurfaceId }) {
  const runtime = useHouseRuntime();
  const { index, routeDraft, snap, selectedPointIndex } = useHouseStore(
    useShallow((s) => ({
      index: s.index,
      routeDraft: s.routeDraft,
      snap: s.snap,
      selectedPointIndex: s.selectedPointIndex,
    })),
  );
  const setRoutePoint = useHouseStore((s) => s.setRoutePoint);

  const surface = index?.surfaces.get(surfaceId);
  const mesh = runtime.index?.surfaceMesh.get(surfaceId);
  const room = surface?.roomId ? index?.rooms.get(surface.roomId) : undefined;

  const frame = useMemo(() => {
    if (!mesh) return null;
    const anchor = room ? index?.roomAnchors.get(room.id)?.point : undefined;
    return wallFrame(mesh, {
      towards: anchor ? new THREE.Vector3(anchor[0], anchor[1], anchor[2]) : undefined,
    });
  }, [mesh, room, index]);

  const openings = useMemo<Opening[]>(() => {
    if (!index || !surface?.elementId) return [];
    const out: Opening[] = [];
    for (const element of index.manifest.elements) {
      const properties = element.properties as Record<string, unknown> | undefined;
      if (!properties) continue;
      if (properties.wallId !== surface.elementId && element.wallId !== surface.elementId) continue;
      const width = numberOf(properties.width);
      const sill = numberOf(properties.sill);
      const head = numberOf(properties.head);
      if (width === null || sill === null || head === null) continue;
      out.push({ id: element.id, kind: element.kind, width, sill, head });
    }
    return out;
  }, [index, surface]);

  if (!index || !surface || !frame || !room) {
    return (
      <p className="text-xs text-ink-3">
        Pick a wall surface to edit a route in its own plane.
      </p>
    );
  }

  const length = frame.uRange[1];
  const bottom = frame.vRange[0] - room.floorElevation;
  const top = frame.vRange[1] - room.floorElevation;
  // SVG y grows downwards, so the elevation is drawn flipped: y = (top - height).
  const viewBox = `0 0 ${length * M} ${(top - bottom) * M}`;

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={viewBox}
        role="img"
        aria-label={`Elevation of ${surfaceId}`}
        className="h-auto w-full touch-none rounded-md border border-line bg-surface"
      >
        <rect x={0} y={0} width={length * M} height={(top - bottom) * M} fill="var(--vh-paper-2)" stroke="var(--vh-line-strong)" strokeWidth={2} />

        {openings.map((opening, i) => (
          <g key={opening.id}>
            <rect
              x={(i * (opening.width + 0.4) + 0.2) * M}
              y={(top - opening.head) * M}
              width={opening.width * M}
              height={(opening.head - opening.sill) * M}
              fill="var(--vh-accent-soft)"
              stroke="var(--vh-accent)"
              strokeWidth={2}
            />
            <text
              x={(i * (opening.width + 0.4) + 0.2 + opening.width / 2) * M}
              y={(top - opening.head) * M - 8}
              textAnchor="middle"
              className="fill-accent"
              style={{ fontSize: 18 }}
            >
              {opening.kind} · sill {opening.sill.toFixed(2)} · head {opening.head.toFixed(2)}
            </text>
          </g>
        ))}

        {routeDraft?.points.map((point, i) => {
          if (routePointPlace(routeDraft, i).floorId !== room.floorId) return null;
          const local = frame.toLocal(new THREE.Vector3(point[0], point[1], point[2]));
          const height = local.v - room.floorElevation;
          return (
            <circle
              key={`e-${i}`}
              cx={local.u * M}
              cy={(top - height) * M}
              r={selectedPointIndex === i ? 12 : 9}
              fill={selectedPointIndex === i ? "var(--vh-accent)" : "var(--vh-paper-0)"}
              stroke="var(--vh-accent)"
              strokeWidth={3}
              tabIndex={0}
              role="button"
              aria-label={`Route point ${i + 1}: ${local.u.toFixed(2)} m along the wall, ${height.toFixed(2)} m above the floor`}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 0.01 : snap.grid;
                let du = 0;
                let dv = 0;
                if (event.key === "ArrowLeft") du = -step;
                else if (event.key === "ArrowRight") du = step;
                else if (event.key === "ArrowUp") dv = step;
                else if (event.key === "ArrowDown") dv = -step;
                else return;
                event.preventDefault();
                const world = frame.toWorld(
                  snapValue(local.u + du, snap.grid),
                  snapValue(local.v + dv, snap.grid),
                  local.d,
                );
                setRoutePoint(i, [world.x, world.y, world.z]);
              }}
            />
          );
        })}
      </svg>
      <p className="text-[11px] text-ink-3">
        Heights are measured from {room.name}&apos;s own floor at{" "}
        {room.floorElevation.toFixed(2)} m, not from the floor datum.
      </p>
    </div>
  );
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
