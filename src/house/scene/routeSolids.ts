import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { InfraMedium } from "@/db/schema/infrastructure";
import type { ExplodeGroup, Route, Vec3 } from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import { overlayGroup, type SceneIndex } from "./SceneIndex";

const MEDIUM_COLORS: Record<InfraMedium, number> = {
  cold_water: 0x4089cf,
  hot_water: 0xcb5750,
  heating_water: 0xc16e38,
  supply_air: 0x4e9b8c,
  extract_air: 0x6a7fac,
  waste: 0x776956,
  drain: 0x767f67,
  gas: 0xa29740,
  electricity: 0xc9821f,
  ethernet: 0x7a4fb5,
  fiber: 0x9c62ad,
  coax: 0x714da1,
};

export function routeMediumColor(route: Pick<Route, "medium">, fallback: number): number {
  return route.medium ? MEDIUM_COLORS[route.medium] : fallback;
}

export function hasSolidRoute(route: Route): boolean {
  return route.lifecycle === "installed" && route.certainty !== "unknown" &&
    (route.kind === "pipe" || route.kind === "duct");
}

export function hasDocumentedFlow(route: Route): boolean {
  return hasSolidRoute(route) && !route.needsReconciliation &&
    route.flowState === "active" &&
    (route.flowDirection === "forward" || route.flowDirection === "reverse") &&
    (route.flowBasis === "declared" || route.flowBasis === "inferred");
}

type SolidBucket = {
  group: ExplodeGroup;
  color: THREE.Color;
  animated: boolean;
  spans: THREE.BufferGeometry[];
  spanCount: number;
};

const UP = new THREE.Vector3(0, 1, 0);

export class RouteSolids {
  private readonly pending = new Map<string, SolidBucket>();
  private readonly meshes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] = [];
  private readonly moving: typeof this.meshes = [];
  private readonly time = { value: 0 };
  private readonly showMotion = { value: 0 };
  private readonly bounds = new THREE.Box3();
  private readonly corner = new THREE.Vector3();

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
  ) {}

  add(
    route: Route, group: ExplodeGroup, hex: number, a: Vec3, b: Vec3,
    distance: number, length: number, join: boolean,
  ): void {
    const animated = hasDocumentedFlow(route);
    const key = `${group}|${hex}|${route.flowState}|${route.certainty}|${animated}`;
    let bucket = this.pending.get(key);
    if (!bucket) {
      const color = new THREE.Color(hex);
      if (route.flowState === "inactive") color.lerp(new THREE.Color(0x797777), 0.8);
      else if (route.flowState !== "active") color.lerp(new THREE.Color(0x808080), 0.3);
      if (route.certainty === "inferred") color.lerp(new THREE.Color(0x9b9b9b), 0.21);
      bucket = { group, color, animated, spans: [], spanCount: 0 };
      this.pending.set(key, bucket);
    }

    // Only a documented diameter sets the exact circular size. Width-only ducts need a
    // schematic height; runs with no dimensions get a schematic diameter.
    const radius = (route.diameterM ?? (route.kind === "duct" ? 0.125 : 0.032)) / 2;
    const width = route.kind === "duct" && !route.diameterM ? route.widthM : undefined;
    const geometry = width
      ? new THREE.BoxGeometry(width, length, Math.min(width, 0.15))
      : new THREE.CylinderGeometry(radius, radius, length, 10, 1);
    const direction = route.flowDirection === "reverse" ? -1 : 1;
    if (animated) this.setProgress(geometry, (y) => direction * (distance + length / 2 + y));

    // Join circular spans only within one semantic floor so the elbow cannot bridge an explode
    // gap. The pulse uses the exact same progress at both sides of the join.
    if (join && !width) {
      const elbow = new THREE.SphereGeometry(radius, 10, 6);
      if (animated) this.setProgress(elbow, () => direction * distance);
      elbow.translate(...a);
      bucket.spans.push(elbow);
    }
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const axis = end.clone().sub(start).normalize();
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, axis));
    geometry.translate(...start.add(end).multiplyScalar(0.5).toArray());
    bucket.spans.push(geometry);
    bucket.spanCount++;
  }

  private setProgress(geometry: THREE.BufferGeometry, distanceAtY: (y: number) => number): void {
    const positions = geometry.getAttribute("position");
    const progress = new Float32Array(positions.count);
    for (let i = 0; i < positions.count; i++) progress[i] = distanceAtY(positions.getY(i));
    geometry.setAttribute("vhRouteDistance", new THREE.BufferAttribute(progress, 1));
  }

  flush(): void {
    for (const [key, bucket] of this.pending) {
      const geometry = mergeGeometries(bucket.spans);
      bucket.spans.forEach((span) => span.dispose());
      if (!geometry) continue;
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial({ color: bucket.color, roughness: 0.72 });
      if (bucket.animated) {
        material.customProgramCacheKey = () => "vh-route-flow-v1";
        material.onBeforeCompile = (shader) => {
          shader.uniforms.vhRouteTime = this.time;
          shader.uniforms.vhRouteMotion = this.showMotion;
          shader.vertexShader = `attribute float vhRouteDistance;
varying float vhDistance;
${shader.vertexShader}`.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvhDistance = vhRouteDistance;",
          );
          shader.fragmentShader = `uniform float vhRouteTime;
uniform float vhRouteMotion;
varying float vhDistance;
${shader.fragmentShader}`.replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
float phase = fract((vhDistance - vhRouteTime * 0.34) / 1.1);
float pulse = smoothstep(0.54, 0.83, phase) * (1.0 - smoothstep(0.83, 0.97, phase));
totalEmissiveRadiance += mix(diffuseColor.rgb, vec3(1.0), 0.5) * pulse * vhRouteMotion * 0.32;`,
          );
        };
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `vh-tube-${key}`;
      mesh.userData.vhRouteSpanCount = bucket.spanCount;
      // The house uses semantic pickables and the route editor's existing point/path targets.
      mesh.raycast = () => {};
      this.clip.attach(mesh, bucket.group);
      overlayGroup(this.index, bucket.group).add(mesh);
      this.meshes.push(mesh);
      if (bucket.animated) this.moving.push(mesh);
    }
    this.pending.clear();
  }

  tick(delta: number, allowMotion: boolean): boolean {
    this.showMotion.value = 0;
    if (!allowMotion || !this.moving.some((mesh) => this.isVisible(mesh))) return false;
    this.showMotion.value = 1;
    // Keep continuity after a suspension without jumping through a long background delta.
    this.time.value = (this.time.value + Math.min(delta, 0.05)) % (1.1 / 0.34 * 96);
    return true;
  }

  private isVisible(mesh: (typeof this.meshes)[number]): boolean {
    for (let node: THREE.Object3D | null = mesh; node; node = node.parent)
      if (!node.visible) return false;
    if (!mesh.geometry.boundingBox) return true;
    mesh.updateWorldMatrix(true, false);
    this.bounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    for (const plane of mesh.material.clippingPlanes ?? []) {
      const n = plane.normal;
      this.corner.set(
        n.x < 0 ? this.bounds.min.x : this.bounds.max.x,
        n.y < 0 ? this.bounds.min.y : this.bounds.max.y,
        n.z < 0 ? this.bounds.min.z : this.bounds.max.z,
      );
      if (plane.distanceToPoint(this.corner) < 0) return false;
    }
    return true;
  }

  clear(): void {
    for (const mesh of this.meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshes.length = 0;
    this.moving.length = 0;
  }
}
