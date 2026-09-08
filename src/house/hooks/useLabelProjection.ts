"use client";
/**
 * Project label anchors to screen space and write them into a **pooled** set of DOM nodes.
 *
 * Why a single custom overlay and not drei `<Html>`: ≤ 25 room labels is fine as portals, but the
 * requirement is those *plus* up to ~200 equipment markers with clustering and HA badges. That
 * would be 200 React subtrees to reconcile on any change, 200 CSS3D matrices, and per-label
 * raycasts or a depth read for occlusion. Here the hot path is pure DOM writes on nodes that
 * already exist: no React work, no allocation, and the transform is compositor-only.
 *
 * The pool size is the hard cap on labels, so a label cloud is structurally impossible.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { RefObject } from "react";
import type { ExplodeGroup, Selection } from "@/house/model/types";
import type { HouseRuntime } from "../runtime";

export type LabelKind = "building" | "room" | "equipment" | "route";

export interface LabelAnchor {
  id: string;
  kind: LabelKind;
  /** Physical site coordinates; the group's explode offset is added at projection time. */
  world: [number, number, number];
  group: ExplodeGroup;
  text: string;
  secondary?: string;
  selection: Selection;
  /** HA entity behind this anchor, if any — badges are written from the HA store. */
  entityId?: string | null;
}

export interface LabelTier {
  name: "A" | "B" | "C" | "D";
  kinds: Set<LabelKind>;
  compact: boolean;
  badges: boolean;
}

/** Semantic zoom bands, by distance from the camera to the controls target. */
export const TIERS: ReadonlyArray<{ name: LabelTier["name"]; min: number; max: number }> = [
  { name: "D", min: 0, max: 3.5 },
  { name: "C", min: 3.5, max: 9 },
  { name: "B", min: 9, max: 26 },
  { name: "A", min: 26, max: Infinity },
];

const TIER_CONTENT: Record<LabelTier["name"], LabelTier> = {
  A: { name: "A", kinds: new Set<LabelKind>(["building"]), compact: false, badges: false },
  B: { name: "B", kinds: new Set<LabelKind>(["room"]), compact: false, badges: false },
  C: { name: "C", kinds: new Set<LabelKind>(["room", "equipment"]), compact: true, badges: false },
  D: {
    name: "D",
    kinds: new Set<LabelKind>(["equipment", "route"]),
    compact: true,
    badges: true,
  },
};

/** Entering a tier needs 12 % past the boundary; leaving needs 12 % back the other way. */
export const HYSTERESIS = 0.12;

export function tierFor(distance: number, previous: LabelTier["name"] | null): LabelTier["name"] {
  const band = TIERS.find((t) => distance >= t.min && distance < t.max) ?? TIERS[TIERS.length - 1]!;
  if (!previous || previous === band.name) return band.name;
  const prev = TIERS.find((t) => t.name === previous);
  if (!prev) return band.name;
  // Still within the previous band's hysteresis margin? Stay put.
  const lowGuard = prev.min * (1 - HYSTERESIS);
  const highGuard = prev.max === Infinity ? Infinity : prev.max * (1 + HYSTERESIS);
  if (distance >= lowGuard && distance <= highGuard) return previous;
  return band.name;
}

export const CELL_PX = 72;

export interface LabelPoolSizes {
  labels: number;
  badges: number;
}

export const DESKTOP_POOL: LabelPoolSizes = { labels: 28, badges: 20 };
export const PHONE_POOL: LabelPoolSizes = { labels: 16, badges: 8 };

interface PooledLabel {
  el: HTMLButtonElement;
  anchorId: string | null;
}

export class LabelPool {
  readonly labels: PooledLabel[] = [];
  readonly badges: HTMLDivElement[] = [];

  constructor(
    host: HTMLElement,
    sizes: LabelPoolSizes,
    onActivate: (anchorId: string) => void,
  ) {
    for (let i = 0; i < sizes.labels; i++) {
      const el = document.createElement("button");
      el.type = "button";
      el.tabIndex = -1; // the real tab order lives in the hidden <ul> rendered by React
      el.className = "vh-label";
      el.hidden = true;
      el.addEventListener("click", () => {
        const entry = this.labels[i];
        if (entry?.anchorId) onActivate(entry.anchorId);
      });
      host.appendChild(el);
      this.labels.push({ el, anchorId: null });
    }
    for (let i = 0; i < sizes.badges; i++) {
      const el = document.createElement("div");
      el.className = "vh-label-cluster";
      el.hidden = true;
      host.appendChild(el);
      this.badges.push(el);
    }
  }

  hideAll(): void {
    for (const entry of this.labels) {
      entry.el.hidden = true;
      entry.anchorId = null;
    }
    for (const badge of this.badges) badge.hidden = true;
  }

  dispose(): void {
    for (const entry of this.labels) entry.el.remove();
    for (const badge of this.badges) badge.remove();
    this.labels.length = 0;
    this.badges.length = 0;
  }
}

interface Candidate {
  anchor: LabelAnchor;
  x: number;
  y: number;
  depth: number;
  count: number;
}

export interface LabelProjectionOptions {
  sizes?: LabelPoolSizes;
  badgeText?: (anchor: LabelAnchor) => { text: string; className: string } | null;
}

export function useLabelProjection(
  hostRef: RefObject<HTMLDivElement | null>,
  anchorsRef: RefObject<readonly LabelAnchor[]>,
  runtime: HouseRuntime,
  opts: LabelProjectionOptions = {},
): void {
  const poolRef = useRef<LabelPool | null>(null);
  const tierRef = useRef<LabelTier["name"] | null>(null);
  const dirtyRef = useRef<Set<string>>(new Set());
  const sizes = useMemo(() => opts.sizes ?? DESKTOP_POOL, [opts.sizes]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const pool = new LabelPool(host, sizes, (anchorId) => {
      const anchor = anchorsRef.current?.find((a) => a.id === anchorId);
      if (anchor) runtime.select(anchor.selection);
    });
    poolRef.current = pool;
    return () => {
      pool.dispose();
      poolRef.current = null;
    };
  }, [hostRef, anchorsRef, runtime, sizes]);

  // HA updates mark anchors dirty; the next projection frame drains the set and writes text and
  // class only. No `invalidate()` — a badge change must not wake the GPU.
  useEffect(() => {
    const dirty = dirtyRef.current;
    return () => dirty.clear();
  }, []);

  useFrame(({ camera, size }) => {
    const pool = poolRef.current;
    const anchors = anchorsRef.current;
    if (!pool || !anchors) return;

    const target = runtime.camera?.pose().target ?? [0, 0, 0];
    const distance = camera.position.distanceTo(new THREE.Vector3(...target));
    const tierName = tierFor(distance, tierRef.current);
    tierRef.current = tierName;
    const tier = TIER_CONTENT[tierName];

    const cells = new Map<number, Candidate>();
    const v = new THREE.Vector3();

    for (const anchor of anchors) {
      if (!tier.kinds.has(anchor.kind)) continue;
      if (!isGroupOnScreen(runtime, anchor.group)) continue;
      const offset = runtime.offsets.get(anchor.group) ?? 0;
      v.set(anchor.world[0], anchor.world[1] + offset, anchor.world[2]);
      // Clipped away by the cutaway? Then its label is gone too.
      if (runtime.clip && !runtime.clip.keeps(anchor.group, v)) continue;
      if (isBehindEnvelope(runtime, anchor, camera)) continue;

      v.project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      if (x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) continue;

      const cell = (Math.floor(x / CELL_PX) << 12) ^ Math.floor(y / CELL_PX);
      const prev = cells.get(cell);
      if (!prev) cells.set(cell, { anchor, x, y, depth: v.z, count: 1 });
      else if (v.z < prev.depth)
        cells.set(cell, { anchor, x, y, depth: v.z, count: prev.count + 1 });
      else prev.count++;
    }

    write(pool, cells, tier, opts.badgeText);
  });
}

function write(
  pool: LabelPool,
  cells: Map<number, Candidate>,
  tier: LabelTier,
  badgeText?: LabelProjectionOptions["badgeText"],
): void {
  const sorted = [...cells.values()].sort((a, b) => a.depth - b.depth);
  let labelIndex = 0;
  let badgeIndex = 0;

  for (const candidate of sorted) {
    if (candidate.count > 1) {
      const badge = pool.badges[badgeIndex++];
      if (!badge) continue;
      badge.hidden = false;
      badge.textContent = `+${candidate.count - 1}`;
      badge.style.transform = `translate3d(${Math.round(candidate.x)}px, ${Math.round(candidate.y)}px, 0)`;
      continue;
    }
    const slot = pool.labels[labelIndex++];
    if (!slot) continue;
    const { anchor } = candidate;
    slot.anchorId = anchor.id;
    slot.el.hidden = false;
    slot.el.style.transform = `translate3d(${Math.round(candidate.x)}px, ${Math.round(candidate.y)}px, 0)`;
    const badge = tier.badges && badgeText ? badgeText(anchor) : null;
    const text = badge ? `${anchor.text} · ${badge.text}` : anchor.text;
    if (slot.el.textContent !== text) slot.el.textContent = text;
    const className = `vh-label vh-label-${anchor.kind}${tier.compact ? " vh-label-compact" : ""}${
      badge ? ` ${badge.className}` : ""
    }`;
    if (slot.el.className !== className) slot.el.className = className;
    slot.el.setAttribute("data-anchor", anchor.id);
    slot.el.setAttribute("aria-label", anchor.secondary ? `${anchor.text} (${anchor.secondary})` : anchor.text);
  }

  for (let i = labelIndex; i < pool.labels.length; i++) {
    const slot = pool.labels[i];
    if (!slot) continue;
    slot.el.hidden = true;
    slot.anchorId = null;
  }
  for (let i = badgeIndex; i < pool.badges.length; i++) {
    const badge = pool.badges[i];
    if (badge) badge.hidden = true;
  }
}

function isGroupOnScreen(runtime: HouseRuntime, group: ExplodeGroup): boolean {
  const index = runtime.index;
  if (!index) return true;
  const nodes = index.floorNodes.get(group);
  if (!nodes || nodes.length === 0) return true;
  return nodes.some((n) => n.visible && n.parent?.visible !== false);
}

/**
 * Rule 4 of the occlusion policy: an interior anchor, an exterior camera and an intact envelope
 * means the label is behind a wall. This single logical rule removes the "labels floating over the
 * closed exterior" problem, so no per-label raycast is needed in v1.
 */
function isBehindEnvelope(
  runtime: HouseRuntime,
  anchor: LabelAnchor,
  camera: THREE.Camera,
): boolean {
  const manifest = runtime.manifest;
  if (!manifest) return false;
  const state = runtime.store.getState();
  if (!state.roofVisible || !state.ceilingsVisible || state.cut.enabled) return false;
  if (anchor.kind === "building") return false;

  for (const building of manifest.buildings.keys()) {
    const box = boundsOf(runtime, building);
    if (!box) continue;
    const point = new THREE.Vector3(anchor.world[0], anchor.world[1], anchor.world[2]);
    if (!box.containsPoint(point)) continue;
    const outside = box.clone().expandByScalar(0.4);
    if (!outside.containsPoint(camera.position)) return true;
  }
  return false;
}

const boundsCache = new WeakMap<HouseRuntime, Map<string, THREE.Box3 | null>>();

function boundsOf(runtime: HouseRuntime, buildingId: string): THREE.Box3 | null {
  let perRuntime = boundsCache.get(runtime);
  if (!perRuntime) boundsCache.set(runtime, (perRuntime = new Map()));
  if (perRuntime.has(buildingId)) return perRuntime.get(buildingId) ?? null;
  const manifest = runtime.manifest;
  if (!manifest) return null;
  const box = new THREE.Box3();
  for (const asset of manifest.assetsByBuilding.get(buildingId) ?? []) {
    if (asset.kind === "scan-reference") continue;
    if (asset.bounds?.min && asset.bounds.max)
      box.union(
        new THREE.Box3(
          new THREE.Vector3(...asset.bounds.min),
          new THREE.Vector3(...asset.bounds.max),
        ),
      );
  }
  const result = box.isEmpty() ? null : box;
  perRuntime.set(buildingId, result);
  return result;
}
