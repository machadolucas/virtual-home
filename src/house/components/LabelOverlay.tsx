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
import { cn } from "@/ui/cn";
import { roomBox } from "@/house/model/framingBoxes";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type { LabelAnchor } from "../hooks/useLabelProjection";
import { DESKTOP_POOL, LABEL_DETAILS_EVENT, PHONE_POOL, useLabelProjection } from "../hooks/useLabelProjection";
import { useHouseRuntime, useHouseStore, useShallow } from "../hooks/useHouseStore";
import { useIsPhone } from "../hooks/useReducedMotion";
import { haStore } from "@/house/store/haStore";
import { equipmentLabelReading, explicitUsefulLinks } from "@/house/model/equipmentLabel";

/**
 * The pooled label chip, as arbitrary variants on the host (the buttons are created
 * imperatively by `LabelPool`, so they cannot carry their own React className).
 *
 * It floats over the render, whose background is a household choice — a theme token,
 * a solid colour or a gradient — so the chip brings its own token surface, hairline
 * and blur. Never a raw white or black wash: one of the two would vanish.
 */
const LABEL_CHIP = [
  "[&>.vh-label]:-translate-x-1/2 [&>.vh-label]:-translate-y-1/2",
  "[&>.vh-label]:whitespace-nowrap [&>.vh-label]:rounded-full",
  "[&>.vh-label]:border [&>.vh-label]:border-line",
  "[&>.vh-label]:bg-surface/90 [&>.vh-label]:backdrop-blur-sm",
  "[&>.vh-label]:px-2 [&>.vh-label]:py-1",
  "[&>.vh-label]:text-xs [&>.vh-label]:font-medium [&>.vh-label]:text-ink",
  "[&>.vh-label]:shadow-pop",
  "[&>.vh-label-ok]:border-ok/45 [&>.vh-label-low]:border-due/55",
  "[&>.vh-label-critical]:border-overdue/60 [&>.vh-label-stale]:border-stale/50",
  "[&>.vh-label-unavailable]:border-unknown/50 [&>.vh-label-disconnected]:border-unknown/50",
  "[&>.vh-label-expanded]:px-2.5 [&>.vh-label-expanded]:py-2",
].join(" ");

/** The "+N" badge that stands in for a cluster of labels too dense to draw. */
const CLUSTER_CHIP = [
  "[&>.vh-label-cluster]:-translate-x-1/2 [&>.vh-label-cluster]:-translate-y-1/2",
  "[&>.vh-label-cluster]:rounded-full",
  "[&>.vh-label-cluster]:border [&>.vh-label-cluster]:border-line",
  "[&>.vh-label-cluster]:bg-surface-2/85 [&>.vh-label-cluster]:backdrop-blur-sm",
  "[&>.vh-label-cluster]:px-1.5 [&>.vh-label-cluster]:py-0.5",
  "[&>.vh-label-cluster]:text-[10px] [&>.vh-label-cluster]:font-semibold",
  "[&>.vh-label-cluster]:text-ink [&>.vh-label-cluster]:shadow-pop",
].join(" ");

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
        linkedEntities: p.linkedEntities ?? [],
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
  const activateFromKeyboard = (anchor: LabelAnchor) => {
    hostRef.current?.dispatchEvent(new CustomEvent(LABEL_DETAILS_EVENT, {
      detail: { anchorId: anchor.id },
    }));
    runtime.select(anchor.selection, { frame: true });
  };
  return (
    <>
      <div
        ref={hostRef}
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden",
          "[&>*]:pointer-events-auto [&>*]:absolute [&>*]:left-0 [&>*]:top-0",
          LABEL_CHIP,
          "[&>.vh-label-compact]:px-1.5 [&>.vh-label-compact]:py-0.5",
          CLUSTER_CHIP,
        )}
      />
      <ul className="sr-only">
        {anchors.map((anchor) => (
          <li key={anchor.id}>
            <button type="button" onClick={() => activateFromKeyboard(anchor)}>
              {anchor.secondary
                ? `${anchor.text} (${anchor.secondary})`
              : anchor.kind === "equipment" && explicitUsefulLinks(anchor.linkedEntities ?? []).filter((link) => link.role !== "battery_level").length > 1
                  ? `Open ${anchor.text} and show linked readings`
                  : anchor.text}
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
    subscribeBadgeChanges: (refresh) => {
      const entities = haStore.subscribe((state) => state.entities, refresh);
      const connection = haStore.subscribe((state) => state.connection, refresh);
      return () => {
        entities();
        connection();
      };
    },
    badgeText: (anchor, expanded) => {
      const ha = haStore.getState();
      return equipmentLabelReading(
        anchor.entityId,
        anchor.linkedEntities ?? [],
        ha.entities,
        ha.connection,
        Date.now(),
        expanded,
      );
    },
  });

  return null;
}
