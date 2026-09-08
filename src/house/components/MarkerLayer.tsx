"use client";
/**
 * The DOM half of the marker layer.
 *
 * The 3D `InstancedMesh` dot (owned by `scene/markers.ts`) gives depth correctness — occluded by
 * walls, clipped by the cutaway, carried by the explode offset. But a 0.06 m sphere is a ~6 px
 * target, which fails both the hit-target and the accessibility requirements, so the **primary**
 * target is a DOM button: 24 px on a pointer device, 44 px on touch.
 *
 * State is never conveyed by hue alone: the dot's fill style (filled / hollow / dotted ring)
 * carries it too.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { useStore } from "zustand";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type { Placement } from "@/house/model/types";
import { classifyBattery, classifyState, haStore, type StateClass } from "@/house/store/haStore";
import { useHouseRuntime, useHouseStore } from "../hooks/useHouseStore";
import { useIsTouch, useNow } from "../hooks/useReducedMotion";

/** Projects the marker buttons in `useFrame` and writes only transforms — no React re-render. */
export function MarkerDomLayer({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }) {
  const runtime = useHouseRuntime();
  const placements = useHouseStore((s) => s.placements);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const nodesRef = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const map = nodesRef.current;
    map.clear();
    for (const el of Array.from(host.querySelectorAll<HTMLElement>("[data-placement]"))) {
      const id = el.dataset.placement;
      if (id) map.set(id, el);
    }
  }, [hostRef, placements]);

  const v = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    const manifest = runtime.manifest;
    if (!manifest) return;
    for (const p of placements) {
      const el = nodesRef.current.get(p.id);
      if (!el) continue;
      const group = p.surfaceId ? clipGroupOf(manifest, p.surfaceId) : p.floorId;
      const offset = runtime.offsets.get(group) ?? 0;
      v.set(p.position[0], p.position[1] + offset, p.position[2]);
      if (runtime.clip && !runtime.clip.keeps(group, v)) {
        el.hidden = true;
        continue;
      }
      v.project(camera);
      if (v.z < -1 || v.z > 1) {
        el.hidden = true;
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.hidden = false;
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    }
  });

  return null;
}

export function MarkerButtons({ hostRef }: { hostRef: React.RefObject<HTMLDivElement | null> }) {
  const runtime = useHouseRuntime();
  const placements = useHouseStore((s) => s.placements);
  const selection = useHouseStore((s) => s.selection);
  const touch = useIsTouch();
  const [, forceBadgeTick] = useState(0);

  // Badge classes come from the HA store; a re-render here is per-anchor-set, not per event.
  useEffect(() => {
    const unsub = haStore.subscribe((s) => s.connection, () => forceBadgeTick((n) => n + 1));
    const interval = setInterval(() => forceBadgeTick((n) => n + 1), 30_000);
    return () => {
      unsub();
      clearInterval(interval);
    };
  }, []);

  const size = touch ? "h-11 w-11" : "h-6 w-6";

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      {placements.map((p) => {
        const selected = selection?.kind === "equipment" && selection.id === p.id;
        return (
          <button
            key={p.id}
            type="button"
            data-placement={p.id}
            hidden
            aria-pressed={selected}
            aria-label={markerLabel(p)}
            onClick={() => runtime.select({ kind: "equipment", id: p.id }, { frame: false })}
            onDoubleClick={() => void runtime.camera?.frameEquipment(p.id)}
            className={`pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 ${size} rounded-full border-2 ${
              selected ? "border-sky-600 bg-sky-100" : "border-neutral-500 bg-white/90"
            } shadow-sm`}
          >
            <span className="sr-only">{markerLabel(p)}</span>
            <MarkerDot placement={p} />
          </button>
        );
      })}
    </div>
  );
}

function MarkerDot({ placement }: { placement: Placement }) {
  // One selector per entity (§9.3): a temperature change re-renders this dot and nothing else.
  const entity = useStore(haStore, (s) =>
    placement.entityId ? s.entities[placement.entityId] : undefined,
  );
  const connection = useStore(haStore, (s) => s.connection);
  const now = useNow();
  const cls: StateClass = classifyState(entity, connection, now);
  const battery = classifyBattery(entity?.battery);
  const shape =
    cls === "live"
      ? battery === "critical"
        ? "bg-red-600"
        : battery === "low"
          ? "bg-orange-500"
          : "bg-emerald-600"
      : cls === "stale"
        ? "border-2 border-dotted border-amber-600 bg-transparent"
        : "border border-neutral-400 bg-transparent";
  return <span className={`mx-auto block h-2 w-2 rounded-full ${shape}`} aria-hidden="true" />;
}

function markerLabel(p: Placement): string {
  const ha = haStore.getState();
  const entity = p.entityId ? ha.entities[p.entityId] : undefined;
  const cls = classifyState(entity, ha.connection, Date.now());
  const state =
    cls === "unlinked"
      ? "not linked to Home Assistant"
      : cls === "unavailable"
        ? "unavailable"
        : cls === "unknown"
          ? "state unknown"
          : cls === "disconnected"
            ? "Home Assistant disconnected"
            : `${entity?.state ?? "—"}${entity?.unit ? ` ${entity.unit}` : ""}`;
  const battery =
    entity?.battery === null || entity?.battery === undefined
      ? "battery unknown"
      : `battery ${entity.battery} percent`;
  return `${p.name} — ${state}, ${battery}`;
}
