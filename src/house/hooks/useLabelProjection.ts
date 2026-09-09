"use client";
/**
 * Project label anchors to screen space and write them into a **pooled** set of DOM nodes.
 *
 * Why a single custom overlay and not drei `<Html>`: ≤ 25 room labels is fine as portals, but the
 * requirement is those *plus* up to ~200 equipment markers with clustering and HA badges. That
 * would be 200 React subtrees to reconcile on any change, 200 CSS3D matrices, and per-label
 * always-on raycasts or depth reads. Equipment occlusion is optional and runs only on rendered
 * frames; label projection writes into existing DOM nodes without React reconciliation.
 *
 * The pool size is the hard cap on labels, so a label cloud is structurally impossible.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { RefObject } from "react";
import type { ExplodeGroup, PlacementLinkedEntity, Selection } from "@/house/model/types";
import type { EquipmentLabelReading } from "@/house/model/equipmentLabel";
import { EquipmentOcclusion } from "@/house/scene/equipmentOcclusion";
import { isVisibleUp } from "@/house/scene/applyVisibility";
import type { HouseRuntime } from "../runtime";

export type LabelKind = "building" | "room" | "equipment" | "route";

export interface LabelAnchor {
  id: string;
  kind: LabelKind;
  /** Physical site coordinates; the group's explode offset is added at projection time. */
  world: [number, number, number];
  /** Physical equipment mount, independent of the label offset above it. */
  occlusionWorld?: [number, number, number];
  group: ExplodeGroup;
  text: string;
  secondary?: string;
  selection: Selection;
  /** HA entity behind this anchor, if any — badges are written from the HA store. */
  entityId?: string | null;
  linkedEntities?: readonly PlacementLinkedEntity[];
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
export const LABEL_DETAILS_EVENT = "vh-show-label-details";

interface PooledLabel {
  el: HTMLButtonElement;
  anchorId: string | null;
  badgeEnabled: boolean;
  expandable: boolean;
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
      this.labels.push({ el, anchorId: null, badgeEnabled: false, expandable: false });
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
      entry.badgeEnabled = false;
      entry.expandable = false;
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
  selected: boolean;
}

export interface LabelProjectionOptions {
  sizes?: LabelPoolSizes;
  badgeText?: (anchor: LabelAnchor, expanded: boolean) => EquipmentLabelReading | null;
  subscribeBadgeChanges?: (refresh: () => void) => () => void;
}

export function useLabelProjection(
  hostRef: RefObject<HTMLDivElement | null>,
  anchorsRef: RefObject<readonly LabelAnchor[]>,
  runtime: HouseRuntime,
  opts: LabelProjectionOptions = {},
): void {
  const poolRef = useRef<LabelPool | null>(null);
  const tierRef = useRef<LabelTier["name"] | null>(null);
  const expandedRef = useRef<Set<string>>(new Set());
  const occlusion = useRef(new EquipmentOcclusion()).current;
  const badgeTextRef = useRef(opts.badgeText);
  const badgeText = opts.badgeText;
  const subscribeBadgeChanges = opts.subscribeBadgeChanges;
  const sizes = useMemo(() => opts.sizes ?? DESKTOP_POOL, [opts.sizes]);

  useEffect(() => {
    badgeTextRef.current = badgeText;
  }, [badgeText]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const pool = new LabelPool(host, sizes, (anchorId) => {
      const anchor = anchorsRef.current?.find((a) => a.id === anchorId);
      if (!anchor) return;
      const reading = badgeTextRef.current?.(anchor, expandedRef.current.has(anchorId));
      if (anchor.kind === "equipment" && reading?.expandable) {
        const expanded = expandedRef.current;
        if (expanded.has(anchorId)) expanded.delete(anchorId);
        else expanded.add(anchorId);
        refreshVisibleLabels(pool, anchorsRef.current ?? [], tierRef.current, badgeTextRef.current, expanded);
      }
      runtime.select(anchor.selection);
    });
    const showAccessibleDetails = (event: Event) => {
      const anchorId = (event as CustomEvent<{ anchorId?: string }>).detail?.anchorId;
      if (!anchorId) return;
      const anchor = anchorsRef.current?.find((candidate) => candidate.id === anchorId);
      const reading = anchor && badgeTextRef.current?.(anchor, false);
      if (!anchor || !reading?.expandable) return;
      expandedRef.current.add(anchorId);
      refreshVisibleLabels(
        pool,
        anchorsRef.current ?? [],
        tierRef.current,
        badgeTextRef.current,
        expandedRef.current,
      );
    };
    host.addEventListener(LABEL_DETAILS_EVENT, showAccessibleDetails);
    poolRef.current = pool;
    return () => {
      host.removeEventListener(LABEL_DETAILS_EVENT, showAccessibleDetails);
      pool.dispose();
      poolRef.current = null;
    };
  }, [hostRef, anchorsRef, runtime, sizes]);

  useEffect(() => {
    if (!subscribeBadgeChanges) return;
    return subscribeBadgeChanges(() => {
      const pool = poolRef.current;
      if (pool)
        refreshVisibleLabels(
          pool,
          anchorsRef.current ?? [],
          tierRef.current,
          badgeTextRef.current,
          expandedRef.current,
        );
    });
  }, [anchorsRef, subscribeBadgeChanges]);

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
    const { selection, equipmentOcclusion } = runtime.store.getState();
    if (equipmentOcclusion && runtime.index) occlusion.beginFrame(runtime.index, runtime.clip, camera);

    for (const anchor of anchors) {
      const selected =
        anchor.kind === "equipment" &&
        selection?.kind === "equipment" &&
        anchor.selection.kind === "equipment" &&
        selection.id === anchor.selection.id;
      // A focused equipment marker always gets its reading, even if the camera lands within a
      // semantic-zoom hysteresis band intended for room labels.
      if (!tier.kinds.has(anchor.kind) && !selected) continue;
      if (!isGroupOnScreen(runtime, anchor.group)) continue;
      const offset = runtime.offsets.get(anchor.group) ?? 0;
      v.set(anchor.world[0], anchor.world[1] + offset, anchor.world[2]);
      // Clipped away by the cutaway? Then its label is gone too.
      if (runtime.clip && !runtime.clip.keeps(anchor.group, v)) continue;
      if (anchor.kind === "equipment" && equipmentOcclusion) {
        const target = anchor.occlusionWorld ?? anchor.world;
        if (occlusion.isOccluded(new THREE.Vector3(target[0], target[1] + offset, target[2]))) continue;
      } else if (!selected && isBehindEnvelope(runtime, anchor, camera)) continue;

      v.project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      if (x < -40 || y < -40 || x > size.width + 40 || y > size.height + 40) continue;

      const cell = (Math.floor(x / CELL_PX) << 12) ^ Math.floor(y / CELL_PX);
      const prev = cells.get(cell);
      if (!prev) cells.set(cell, { anchor, x, y, depth: v.z, count: 1, selected });
      else if ((selected && !prev.selected) || (selected === prev.selected && v.z < prev.depth))
        cells.set(cell, { anchor, x, y, depth: v.z, count: prev.count + 1, selected });
      else prev.count++;
    }

    write(pool, cells, tier, badgeTextRef.current, expandedRef.current);
  });
}

function write(
  pool: LabelPool,
  cells: Map<number, Candidate>,
  tier: LabelTier,
  badgeText?: LabelProjectionOptions["badgeText"],
  expanded = new Set<string>(),
): void {
  const sorted = [...cells.values()].sort((a, b) => a.depth - b.depth);
  let labelIndex = 0;
  let badgeIndex = 0;

  for (const candidate of sorted) {
    if (candidate.count > 1 && !candidate.selected) {
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
    slot.badgeEnabled = anchor.kind === "equipment" || tier.badges || candidate.selected;
    slot.el.hidden = false;
    slot.el.style.transform = `translate3d(${Math.round(candidate.x)}px, ${Math.round(candidate.y)}px, 0)`;
    writeLabelText(slot, anchor, tier, badgeText, expanded.has(anchor.id));
    slot.el.setAttribute("data-anchor", anchor.id);
  }

  for (let i = labelIndex; i < pool.labels.length; i++) {
    const slot = pool.labels[i];
    if (!slot) continue;
      slot.el.hidden = true;
      slot.anchorId = null;
      slot.badgeEnabled = false;
      slot.expandable = false;
  }
  for (let i = badgeIndex; i < pool.badges.length; i++) {
    const badge = pool.badges[i];
    if (badge) badge.hidden = true;
  }
}

function writeLabelText(
  slot: PooledLabel,
  anchor: LabelAnchor,
  tier: LabelTier,
  badgeText: LabelProjectionOptions["badgeText"],
  expanded: boolean,
): void {
  const badge = slot.badgeEnabled && badgeText ? badgeText(anchor, expanded) : null;
  const showExpanded = expanded && (badge?.expandable ?? false);
  slot.el.style.maxWidth = "calc(100% - 16px)";
  slot.el.style.whiteSpace = showExpanded ? "normal" : "nowrap";
  slot.el.style.overflowWrap = showExpanded ? "normal" : "anywhere";
  slot.el.style.width = showExpanded ? "min(18rem, calc(100% - 16px))" : "";
  slot.el.style.borderRadius = showExpanded ? "0.5rem" : "";
  slot.el.style.padding = showExpanded ? ".5rem .625rem" : "";
  slot.expandable = badge?.expandable ?? false;
  const prefix = badge?.text ? `${anchor.text} · ${badge.text}` : anchor.text;
  const battery = badge?.batteryPercent;
  const contentKey = `${prefix}\0${battery ?? ""}\0${expanded}\0${JSON.stringify(badge?.details ?? [])}`;
  if (slot.el.dataset.contentKey !== contentKey) {
    slot.el.dataset.contentKey = contentKey;
    writeLabelContent(slot.el, anchor.text, badge, expanded);
  }
  const className = `vh-label vh-label-${anchor.kind}${tier.compact ? " vh-label-compact" : ""}${
    badge ? ` ${badge.className}` : ""
  }${showExpanded ? " vh-label-expanded" : ""}`;
  if (slot.el.className !== className) slot.el.className = className;
  if (anchor.kind === "equipment" && slot.expandable)
    slot.el.setAttribute("aria-expanded", String(showExpanded));
  else slot.el.removeAttribute("aria-expanded");
  const accessibleReading = badge?.text ? `, ${badge.text}` : "";
  const action = slot.expandable ? `, ${showExpanded ? "hide" : "show"} linked readings` : "";
  slot.el.setAttribute("aria-label", `${anchor.text}${accessibleReading}${action}`);
}

type LabelIcon = NonNullable<EquipmentLabelReading["details"]>[number]["icon"];

/**
 * Fixed, font-independent line icons for the imperative label pool. Unicode glyphs vary by font
 * and platform (the former temperature "°" was especially easy to mistake for part of the value),
 * while these SVG paths remain legible at the label's compact size.
 */
const ICON_PATHS: Record<LabelIcon, readonly string[]> = {
  temperature: [
    "M14 4a2 2 0 0 0-4 0v9.54a4 4 0 1 0 4 0V4",
    "M12 9v7",
  ],
  humidity: [
    "M12 2.7 6.35 8.35a8 8 0 1 0 11.3 0L12 2.7Z",
    "M8.5 14.5a3.5 3.5 0 0 0 3.5 3.5",
  ],
  illuminance: [
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z",
    "M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41",
  ],
  occupancy: [
    "M12 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M6.5 21v-2a5.5 5.5 0 0 1 11 0v2",
    "M4.9 8.8a9 9 0 0 0 0 6.4M19.1 8.8a9 9 0 0 1 0 6.4",
  ],
  contact: [
    "M4 21h16",
    "M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16",
    "M14 12h.01",
  ],
  light: [
    "M9 18h6M10 22h4",
    "M8.7 14.7A7 7 0 1 1 15.3 14.7c-.8.6-1.3 1.4-1.3 2.3h-4c0-.9-.5-1.7-1.3-2.3Z",
  ],
  power: ["m13 2-9 12h8l-1 8 9-12h-8l1-8Z"],
  reading: [
    "M4 19V9M10 19V5M16 19v-7M22 19V3",
    "M2 19h22",
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

function labelIconNode(kind: LabelIcon): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-label-icon", kind);
  for (const data of ICON_PATHS[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

const TONE_COLOR: Record<NonNullable<EquipmentLabelReading["details"]>[number]["tone"], string> = {
  live: "var(--vh-ok)",
  inactive: "var(--vh-ink-3)",
  unknown: "var(--vh-unknown)",
  stale: "var(--vh-stale)",
};

function batteryNode(level: number): HTMLSpanElement {
  const icon = document.createElement("span");
  icon.className = "vh-battery-icon";
  icon.setAttribute("aria-hidden", "true");
  const color = level <= 10 ? "var(--vh-overdue)" : level <= 20 ? "var(--vh-due)" : "var(--vh-ink-2)";
  icon.style.cssText = `display:inline-flex;align-items:center;gap:1px;vertical-align:middle;color:${color}`;
  const body = document.createElement("span");
  body.style.cssText = "display:inline-flex;width:.75rem;height:.45rem;padding:1px;border:1px solid currentColor;border-radius:2px";
  const fill = document.createElement("span");
  fill.style.cssText = `display:block;width:${level}%;height:100%;background:currentColor`;
  const cap = document.createElement("span");
  cap.style.cssText = "display:block;width:2px;height:.22rem;border-radius:0 1px 1px 0;background:currentColor";
  body.append(fill);
  icon.append(body, cap);
  return icon;
}

function writeLabelContent(
  el: HTMLButtonElement,
  title: string,
  reading: EquipmentLabelReading | null,
  expanded: boolean,
): void {
  const battery = reading?.batteryPercent;
  const level = battery === undefined ? undefined : Math.round(Math.min(100, Math.max(0, battery)));
  if (!expanded || !reading?.expandable) {
    const parts: Node[] = [document.createTextNode(reading?.text ? `${title} · ${reading.text}` : title)];
    if (level !== undefined) parts.push(document.createTextNode(" · "), batteryNode(level), document.createTextNode(` ${level}%`));
    el.replaceChildren(...parts);
    el.dataset.captureText = `${reading?.text ? `${title} · ${reading.text}` : title}${level === undefined ? "" : ` · [${"█".repeat(Math.round(level / 25))}${"░".repeat(4 - Math.round(level / 25))}] ${level}%`}`;
  } else {
    const header = document.createElement("span");
    header.className = "vh-label-header";
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:.75rem;text-align:left";
    const name = document.createElement("span");
    name.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:650";
    name.textContent = title;
    header.append(name);
    if (level !== undefined) {
      const batteryBadge = document.createElement("span");
      batteryBadge.style.cssText = "display:inline-flex;flex:none;align-items:center;gap:.25rem;color:var(--vh-ink-2);font-size:.6875rem";
      batteryBadge.append(batteryNode(level), document.createTextNode(`${level}%`));
      header.append(batteryBadge);
    }
    const list = document.createElement("span");
    list.className = "vh-label-readings";
    list.style.cssText = "display:grid;margin-top:.35rem;padding-top:.25rem;border-top:1px solid var(--vh-line);gap:.125rem";
    for (const detail of reading.details) {
      const row = document.createElement("span");
      row.className = "vh-label-reading";
      row.style.cssText = "display:grid;grid-template-columns:1rem minmax(0,1fr) auto;align-items:center;gap:.375rem;min-height:1.35rem;text-align:left";
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.style.cssText = `display:inline-flex;align-items:center;justify-content:center;color:${TONE_COLOR[detail.tone]}`;
      icon.append(labelIconNode(detail.icon));
      const label = document.createElement("span");
      label.style.cssText = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vh-ink-3);font-size:.6875rem;font-weight:500";
      label.textContent = detail.label;
      const value = document.createElement("span");
      value.style.cssText = `white-space:nowrap;color:${TONE_COLOR[detail.tone]};font-size:.75rem;font-weight:650`;
      value.textContent = detail.value;
      row.append(icon, label, value);
      list.append(row);
    }
    el.replaceChildren(header, list);
    el.dataset.captureText = [title, ...reading.details.map((detail) => `${detail.label}: ${detail.value}`), ...(level === undefined ? [] : [`Battery: ${level}%`])].join("\n");
  }
  if (level === undefined) delete el.dataset.batteryLevel;
  else el.dataset.batteryLevel = String(level);
}

function refreshVisibleLabels(
  pool: LabelPool,
  anchors: readonly LabelAnchor[],
  tierName: LabelTier["name"] | null,
  badgeText: LabelProjectionOptions["badgeText"],
  expanded: ReadonlySet<string>,
): void {
  if (!tierName) return;
  const tier = TIER_CONTENT[tierName];
  for (const slot of pool.labels) {
    if (slot.el.hidden || !slot.anchorId) continue;
    const anchor = anchors.find((candidate) => candidate.id === slot.anchorId);
    if (anchor) writeLabelText(slot, anchor, tier, badgeText, expanded.has(anchor.id));
  }
}

function isGroupOnScreen(runtime: HouseRuntime, group: ExplodeGroup): boolean {
  const index = runtime.index;
  if (!index) return true;
  const nodes = index.floorNodes.get(group);
  if (!nodes || nodes.length === 0) return true;
  return nodes.some(isVisibleUp);
}

/**
 * Rule 4 of the occlusion policy: an interior anchor, an exterior camera and an intact envelope
 * means the label is behind a wall. This single logical rule removes the "labels floating over the
 * closed exterior" problem when precise equipment occlusion is disabled.
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
