/** Infrastructure lines and 3D runs share the same semantic floor and clipping groups. */
import * as THREE from "three";
import { polylineLength } from "@/house/model/geometry2d";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type {
  ExplodeGroup,
  Route,
  RouteCertainty,
  RouteLifecycle,
  RouteSystem,
  Vec3,
} from "@/house/model/types";
import { hasSolidRoute, routeMediumColor, RouteSolids } from "./routeSolids";
import type { ClipGroups } from "./clipGroups";
import { getViewerPalette } from "./palette";
import { overlayGroup, type SceneIndex } from "./SceneIndex";

/**
 * Colour-blind-safe hues. Hue is never the only channel — endpoint glyphs differ per system.
 *
 * These stay literal rather than following the theme: they are *identity* ("the blue line is
 * water"), they are drawn against the model rather than against the background, and the token ramp
 * has no per-system hue to map them onto. `scene/palette.ts` records the exception.
 */
export const SYSTEM_COLORS: Record<RouteSystem, number> = {
  ventilation: 0x3d7ea6,
  water: 0x2f6fd0,
  electrical: 0xc9821f,
  network: 0x7a4fb5,
  heating: 0xc0562a,
  drainage: 0x6b6b4f,
  other: 0x6a6a66,
};

/**
 * `planned` is deliberately hue-neutral: a plan must not read as an installation. Being neutral is
 * exactly what makes it theme-dependent, so it comes from the `unknown` token.
 */
export function plannedColor(): number {
  return getViewerPalette().routePlanned;
}

export interface RouteStyle {
  system: RouteSystem;
  lifecycle: RouteLifecycle;
  certainty: RouteCertainty;
  medium?: Route["medium"];
  flowState?: Route["flowState"];
}

const styleKey = (s: RouteStyle): string => `${s.system}|${s.lifecycle}|${s.certainty}|${s.medium ?? ""}|${s.flowState ?? ""}`;
const bucketKey = (group: ExplodeGroup, s: RouteStyle): string => `${group}|${styleKey(s)}`;

export function opacityFor(style: RouteStyle): number {
  if (style.lifecycle === "removed") return 0.3;
  if (style.lifecycle === "planned") return 0.6;
  if (style.flowState === "inactive") return 0.52;
  if (style.certainty === "unknown") return 0.45;
  if (style.certainty === "observed") return 0.85;
  return 1;
}

export const isDashed = (style: RouteStyle): boolean =>
  style.lifecycle !== "installed" || style.certainty === "inferred" || style.certainty === "unknown";

export function colorFor(style: RouteStyle): number {
  if (style.lifecycle !== "installed") return plannedColor();
  const hex = routeMediumColor(style, SYSTEM_COLORS[style.system]);
  return style.flowState === "inactive" ? new THREE.Color(hex).lerp(new THREE.Color(0x797777), 0.8).getHex() : hex;
}

interface Bucket {
  line: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  positions: number[];
}

export class RouteLayer {
  private readonly buckets = new Map<string, Bucket>();
  private readonly solids: RouteSolids;

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
  ) {
    this.solids = new RouteSolids(index, clip);
  }

  /**
   * Rebuild everything from the route list. Called when route data or the renovation-date filter
   * changes — never per frame.
   */
  set(routes: readonly Route[], opts: { tubes?: boolean } = {}): void {
    this.clearGeometry();

    for (const route of routes) {
      const solid = opts.tubes && hasSolidRoute(route);
      const routeLength = solid ? polylineLength(route.points) : 0;
      let distance = 0;
      let previousGroup: ExplodeGroup | null = null;
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1] as Vec3;
        const b = route.points[i] as Vec3;
        const group = this.groupOfSegment(route, i - 1);
        const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (length < 1e-5) continue;
        if (solid) {
          const color = routeMediumColor(route, SYSTEM_COLORS[route.system]);
          this.solids.add(route, group, color, a, b, distance, length, routeLength, previousGroup === group);
        } else {
          const bucket = this.bucketFor(group, route);
          bucket.positions.push(...a, ...b);
        }
        distance += length;
        previousGroup = group;
      }
    }
    this.solids.flush();

    for (const bucket of this.buckets.values()) {
      bucket.geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(bucket.positions, 3),
      );
      // Required by LineDashedMaterial; a classic omission that yields silently solid lines.
      // `LineSegments.computeLineDistances()` measures per segment, which is what we need.
      bucket.line.computeLineDistances();
      bucket.geometry.computeBoundingSphere();
      bucket.line.visible = bucket.positions.length > 0;
    }
  }

  private groupOfSegment(route: Route, segmentIndex: number): ExplodeGroup {
    const segment = route.segments[segmentIndex];
    if (segment?.floorId) return segment.floorId;
    if (route.offsetFrom) return clipGroupOf(this.index.manifest, route.offsetFrom.surfaceId);
    return "site";
  }

  private bucketFor(group: ExplodeGroup, style: RouteStyle): Bucket {
    const key = bucketKey(group, style);
    let bucket = this.buckets.get(key);
    if (bucket) return bucket;

    const geometry = new THREE.BufferGeometry();
    const common = {
      color: colorFor(style),
      transparent: true,
      opacity: opacityFor(style),
      depthTest: true,
    };
    const material = isDashed(style)
      ? new THREE.LineDashedMaterial({ ...common, dashSize: 0.08, gapSize: 0.06 })
      : new THREE.LineBasicMaterial(common);
    const line = new THREE.LineSegments(geometry, material);
    line.name = `vh-routes-${key}`;
    line.frustumCulled = false;
    line.renderOrder = 5;
    this.clip.attach(line, group);
    overlayGroup(this.index, group).add(line);

    bucket = { line, geometry, material, positions: [] };
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** True while the demand-rendered scene has a visible directional cue. */
  tick(delta: number, allowMotion: boolean): boolean {
    return this.solids.tick(delta, allowMotion);
  }

  /** Buckets, for the draw-call budget assertions. */
  get bucketCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) if (b.line.visible) n++;
    return n;
  }

  /** True when every dashed bucket carries line distances (asserted in a unit test). */
  hasLineDistances(): boolean {
    for (const bucket of this.buckets.values()) {
      if (!(bucket.material instanceof THREE.LineDashedMaterial)) continue;
      if (bucket.positions.length === 0) continue;
      if (!bucket.geometry.getAttribute("lineDistance")) return false;
    }
    return true;
  }

  private clearGeometry(): void {
    for (const bucket of this.buckets.values()) {
      bucket.positions.length = 0;
      bucket.geometry.deleteAttribute("position");
      bucket.geometry.deleteAttribute("lineDistance");
      bucket.line.visible = false;
    }
    this.solids.clear();
  }

  dispose(): void {
    this.clearGeometry();
    for (const bucket of this.buckets.values()) {
      bucket.line.removeFromParent();
      bucket.geometry.dispose();
      bucket.material.dispose();
    }
    this.buckets.clear();
  }
}
