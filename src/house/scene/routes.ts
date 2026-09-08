/**
 * Infrastructure routes: batched `LineSegments` per style bucket per explode group, plus an
 * optional `TubeGeometry` where a duct's real diameter is known.
 *
 * Two things this module must not get wrong:
 *  - `LineDashedMaterial` silently draws solid lines unless `geometry.computeLineDistances()` runs
 *    after the positions are set. `inferred` and `unknown` confidence are *drawn* as dashes, so a
 *    missed call would present a guess as a measurement.
 *  - WebGL ignores `LineBasicMaterial.linewidth`. Anything that must read at its true width is a
 *    tube, which is also depth-correct and needs no resolution uniform on resize.
 */
import * as THREE from "three";
import { clipGroupOf } from "@/house/model/explodeGroups";
import type {
  ExplodeGroup,
  Route,
  RouteCertainty,
  RouteLifecycle,
  RouteSystem,
  Vec3,
} from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import { overlayGroup, type SceneIndex } from "./SceneIndex";

/** Colour-blind-safe hues. Hue is never the only channel — endpoint glyphs differ per system. */
export const SYSTEM_COLORS: Record<RouteSystem, number> = {
  ventilation: 0x3d7ea6,
  water: 0x2f6fd0,
  electrical: 0xc9821f,
  network: 0x7a4fb5,
  heating: 0xc0562a,
  drainage: 0x6b6b4f,
  other: 0x6a6a66,
};

/** `planned` is deliberately hue-neutral: a plan must not read as an installation. */
export const PLANNED_COLOR = 0x8a8f96;

export interface RouteStyle {
  system: RouteSystem;
  lifecycle: RouteLifecycle;
  certainty: RouteCertainty;
}

const styleKey = (s: RouteStyle): string => `${s.system}|${s.lifecycle}|${s.certainty}`;
const bucketKey = (group: ExplodeGroup, s: RouteStyle): string => `${group}|${styleKey(s)}`;

export function opacityFor(style: RouteStyle): number {
  if (style.lifecycle === "removed") return 0.3;
  if (style.lifecycle === "planned") return 0.6;
  if (style.certainty === "unknown") return 0.45;
  if (style.certainty === "observed") return 0.85;
  return 1;
}

export const isDashed = (style: RouteStyle): boolean =>
  style.certainty === "inferred" || style.certainty === "unknown";

export function colorFor(style: RouteStyle): number {
  return style.lifecycle === "planned" ? PLANNED_COLOR : SYSTEM_COLORS[style.system];
}

interface Bucket {
  line: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  positions: number[];
}

export class RouteLayer {
  private readonly buckets = new Map<string, Bucket>();
  private readonly tubes: THREE.Mesh[] = [];
  private readonly tubeMaterials = new Map<number, THREE.MeshStandardMaterial>();

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
  ) {}

  /**
   * Rebuild everything from the route list. Called when route data or the renovation-date filter
   * changes — never per frame.
   */
  set(routes: readonly Route[], opts: { tubes?: boolean } = {}): void {
    this.clearGeometry();

    for (const route of routes) {
      const style: RouteStyle = {
        system: route.system,
        lifecycle: route.lifecycle,
        certainty: route.certainty,
      };
      for (let i = 1; i < route.points.length; i++) {
        const a = route.points[i - 1] as Vec3;
        const b = route.points[i] as Vec3;
        const group = this.groupOfSegment(route, i - 1);
        const bucket = this.bucketFor(group, style);
        bucket.positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      }
      if (opts.tubes && route.diameterM && route.points.length >= 2 && route.lifecycle !== "removed")
        this.addTube(route, style);
    }

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
      ? new THREE.LineDashedMaterial({ ...common, dashSize: 0.02, gapSize: 0.04 })
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

  private addTube(route: Route, style: RouteStyle): void {
    const points = route.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0);
    const radius = Math.max(0.01, (route.diameterM ?? 0.1) / 2);
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.max(2, points.length * 4),
      radius,
      6,
      false,
    );
    const hex = colorFor(style);
    let material = this.tubeMaterials.get(hex);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: hex,
        roughness: 0.6,
        metalness: 0,
        transparent: true,
        opacity: opacityFor(style),
      });
      this.tubeMaterials.set(hex, material);
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `vh-tube-${route.id}`;
    const group = this.groupOfSegment(route, 0);
    this.clip.attach(mesh, group);
    overlayGroup(this.index, group).add(mesh);
    this.tubes.push(mesh);
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
    for (const tube of this.tubes) {
      tube.removeFromParent();
      tube.geometry.dispose();
    }
    this.tubes.length = 0;
  }

  dispose(): void {
    this.clearGeometry();
    for (const bucket of this.buckets.values()) {
      bucket.line.removeFromParent();
      bucket.geometry.dispose();
      bucket.material.dispose();
    }
    this.buckets.clear();
    for (const m of this.tubeMaterials.values()) m.dispose();
    this.tubeMaterials.clear();
  }
}
