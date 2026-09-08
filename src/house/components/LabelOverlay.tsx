"use client";
/**
 * The label layer: one DOM overlay, a fixed recycled pool, imperative writes.
 *
 * `LabelHost` is a sibling of `<Canvas>` (so labels sit on a translucent chip with a solid
 * backdrop rather than as text directly on the render, where contrast is unpredictable).
 * `LabelProjector` lives *inside* the canvas because the projection runs in `useFrame`.
 *
 * A visually hidden, React-rendered `<ul>` mirrors the visible label set in document order and
 * carries the real tab stops, so a keyboard user reaches every visible marker even though the
 * pooled buttons are recycled (and therefore `tabIndex={-1}`).
 */
import { useEffect, useMemo, useRef } from "react";
import { roomBox } from "@/house/model/framingBoxes";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type { LabelAnchor } from "../hooks/useLabelProjection";
import { DESKTOP_POOL, PHONE_POOL, useLabelProjection } from "../hooks/useLabelProjection";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useIsPhone } from "../hooks/useReducedMotion";
import { classifyBattery, classifyState, haStore } from "@/house/store/haStore";

export function useLabelAnchors(): LabelAnchor[] {
  const runtime = useHouseRuntime();
  const { placements, routes, activeFloorId } = useHouseStore(
    useShallow((s) => ({
      placements: s.placements,
      routes: s.routes,
      activeFloorId: s.activeFloorId,
    })),
  );

  return useMemo(() => {
    const manifest = runtime.manifest;
    if (!manifest) return [];
    const anchors: LabelAnchor[] = [];

    for (const building of manifest.buildings.values()) {
      const floors = manifest.floorsByBuilding.get(building.id) ?? [];
      const boxes = floors
        .flatMap((f) => manifest.roomsByFloor.get(f.id) ?? [])
        .map((r) => roomBox(r));
      if (boxes.length === 0) continue;
      const min = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i] as number)));
      const max = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i] as number)));
      anchors.push({
        id: `building:${building.id}`,
        kind: "building",
        world: [
          ((min[0] as number) + (max[0] as number)) / 2,
          (max[1] as number) + 1.2,
          ((min[2] as number) + (max[2] as number)) / 2,
        ],
        group: floors[0]?.id ?? "site",
        text: building.name,
        selection: { kind: "building", id: building.id },
      });
    }

    for (const room of manifest.rooms.values()) {
      const anchor = manifest.roomAnchors.get(room.id);
      if (!anchor) continue;
      anchors.push({
        id: `room:${room.id}`,
        kind: "room",
        world: anchor.point,
        group: room.floorId,
        text: room.name,
        secondary: room.nameFi ?? undefined,
        selection: { kind: "room", id: room.id },
      });
    }

    for (const p of placements) {
      anchors.push({
        id: `equipment:${p.id}`,
        kind: "equipment",
        // Physical coordinate; the group's explode offset is added at projection time.
        world: [p.position[0], p.position[1] + 0.12, p.position[2]],
        group: p.surfaceId ? clipGroupOf(manifest, p.surfaceId) : p.floorId,
        text: p.name,
        selection: { kind: "equipment", id: p.id },
        entityId: p.entityId,
      });
    }

    for (const route of routes) {
      const first = route.points[0];
      const last = route.points[route.points.length - 1];
      for (const [i, point] of [first, last].entries()) {
        if (!point) continue;
        anchors.push({
          id: `route:${route.id}:${i}`,
          kind: "route",
          world: [point[0], point[1], point[2]],
          group: route.segments[i === 0 ? 0 : route.segments.length - 1]?.floorId ?? "site",
          text: route.name,
          selection: { kind: "route", id: route.id },
        });
      }
    }

    void activeFloorId; // isolation is handled at projection time, per anchor group
    return anchors;
  }, [runtime.manifest, placements, routes, activeFloorId]);
}

export interface LabelHostProps {
  hostRef: React.RefObject<HTMLDivElement | null>;
  anchors: readonly LabelAnchor[];
}

/** The DOM host plus the accessible mirror list. */
export function LabelHost({ hostRef, anchors }: LabelHostProps) {
  const runtime = useHouseRuntime();
  return (
    <>
      <div
        ref={hostRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden [&>*]:pointer-events-auto [&>*]:absolute [&>*]:left-0 [&>*]:top-0 [&>.vh-label]:-translate-x-1/2 [&>.vh-label]:-translate-y-1/2 [&>.vh-label]:whitespace-nowrap [&>.vh-label]:rounded-full [&>.vh-label]:border [&>.vh-label]:border-neutral-300/80 [&>.vh-label]:bg-white/95 [&>.vh-label]:px-2 [&>.vh-label]:py-1 [&>.vh-label]:text-xs [&>.vh-label]:font-medium [&>.vh-label]:text-neutral-800 [&>.vh-label]:shadow-sm [&>.vh-label-compact]:px-1.5 [&>.vh-label-compact]:py-0.5 [&>.vh-label-cluster]:-translate-x-1/2 [&>.vh-label-cluster]:-translate-y-1/2 [&>.vh-label-cluster]:rounded-full [&>.vh-label-cluster]:bg-neutral-800/90 [&>.vh-label-cluster]:px-1.5 [&>.vh-label-cluster]:py-0.5 [&>.vh-label-cluster]:text-[10px] [&>.vh-label-cluster]:font-semibold [&>.vh-label-cluster]:text-white"
      />
      <ul className="sr-only">
        {anchors.map((anchor) => (
          <li key={anchor.id}>
            <button type="button" onClick={() => runtime.select(anchor.selection, { frame: true })}>
              {anchor.secondary ? `${anchor.text} (${anchor.secondary})` : anchor.text}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export interface LabelProjectorProps {
  hostRef: React.RefObject<HTMLDivElement | null>;
  anchors: readonly LabelAnchor[];
}

/** Runs inside the canvas: `useFrame` projection into the pooled DOM nodes. */
export function LabelProjector({ hostRef, anchors }: LabelProjectorProps) {
  const runtime = useHouseRuntime();
  const phone = useIsPhone();
  const anchorsRef = useRef<readonly LabelAnchor[]>(anchors);
  useEffect(() => {
    anchorsRef.current = anchors;
  }, [anchors]);

  useLabelProjection(hostRef, anchorsRef, runtime, {
    sizes: phone ? PHONE_POOL : DESKTOP_POOL,
    badgeText: (anchor) => {
      if (!anchor.entityId) return null;
      const ha = haStore.getState();
      const entity = ha.entities[anchor.entityId];
      const cls = classifyState(entity, ha.connection, Date.now());
      if (cls === "unlinked") return null;
      if (cls === "disconnected") return { text: "—", className: "vh-label-disconnected" };
      if (cls === "unavailable") return { text: "unavailable", className: "vh-label-unavailable" };
      if (cls === "unknown") return { text: "—", className: "vh-label-unknown" };
      const battery = classifyBattery(entity?.battery);
      const value = entity ? `${entity.state}${entity.unit ? ` ${entity.unit}` : ""}` : "—";
      const suffix =
        battery === "unknown"
          ? ""
          : battery === "ok"
            ? ""
            : ` · battery ${entity?.battery}%`;
      return {
        text: `${value}${suffix}`,
        className: cls === "stale" ? "vh-label-stale" : `vh-label-${battery}`,
      };
    },
  });

  return null;
}
