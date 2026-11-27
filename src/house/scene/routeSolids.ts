import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { AIR_STREAM_STYLE, classifyAirStream, type AirStream } from "@/domain/airStream";
import { fanForAirStream, type VentilationFan } from "@/domain/ventilationFeedback";
import type { InfraMedium } from "@/db/schema/infrastructure";
import type { ExplodeGroup, Route, Vec3 } from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import { overlayGroup, type SceneIndex } from "./SceneIndex";
import { ductOutletGeometry, matchDuctOutlet } from "./ductOutlets";
import { rectangularDuctSpan } from "./rectangularDuct";

const MEDIUM_COLORS: Record<InfraMedium, number> = {
  cold_water: 0x4089cf,
  hot_water: 0xcb5750,
  heating_water: 0xc16e38,
  supply_air: AIR_STREAM_STYLE.room_supply.body,
  extract_air: AIR_STREAM_STYLE.room_extract.body,
  waste: 0x776956,
  drain: 0x767f67,
  gas: 0xa29740,
  electricity: 0xc9821f,
  ethernet: 0x7a4fb5,
  fiber: 0x9c62ad,
  coax: 0x714da1,
};

export function routeMediumColor(route: Pick<Route, "medium" | "airStream">, fallback: number): number {
  const stream = classifyAirStream(route.medium, route.airStream);
  return stream ? AIR_STREAM_STYLE[stream].body : route.medium ? MEDIUM_COLORS[route.medium] : fallback;
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

const FLOW_MOTION = {
  air: {
    repeatM: 0.85,
    cyclesPerSecond: 1,
    shader: `
float mainBand = smoothstep(0.30, 0.62, phase) * (1.0 - smoothstep(0.76, 0.96, phase));
float wake = smoothstep(0.04, 0.11, phase) * (1.0 - smoothstep(0.19, 0.36, phase));
float glow = (mainBand + 0.38 * wake) * 0.36;`,
  },
  pipe: {
    repeatM: 0.88,
    cyclesPerSecond: 0.5,
    shader: `
float packet = smoothstep(0.57, 0.83, phase) * (1.0 - smoothstep(0.83, 0.94, phase));
float glow = packet * 0.48;`,
  },
} as const;

type MotionKind = keyof typeof FLOW_MOTION;
type MotionChannel = VentilationFan | "illustrativeAir" | "pipe";
type MotionUniforms = { phase: { value: number }; enabled: { value: number } };
type SolidMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;

const MOTION_CHANNELS = ["supply", "extract", "illustrativeAir", "pipe"] as const;
const motionUniforms = (): MotionUniforms => ({ phase: { value: 0 }, enabled: { value: 0 } });

export type RouteFlowState = Record<MotionChannel, MotionUniforms>;

export function createRouteFlowState(): RouteFlowState {
  return { supply: motionUniforms(), extract: motionUniforms(), illustrativeAir: motionUniforms(), pipe: motionUniforms() };
}

type SolidBucket = {
  group: ExplodeGroup;
  color: THREE.Color;
  motion: MotionKind | null;
  airStream?: AirStream;
  silencer: boolean;
  approximate: boolean;
  spans: THREE.BufferGeometry[];
  spanCount: number;
};

const UP = new THREE.Vector3(0, 1, 0);
const SILENCER_CASING = new THREE.Color(0xa2aab0);
const SILENCER_COLLAR = new THREE.Color(0x69757e);

/** Display dimensions only. Nominal width supplies no evidence for a rectangular duct's height. */
export function routeBodyProfile(route: Route) {
  const silencer = route.kind === "duct" && route.ductFitting === "silencer" && route.points.length === 2;
  const width = route.kind === "duct" && !route.diameterM && !silencer ? route.widthM : undefined;
  const height = width ? Math.min(width, .15) : undefined;
  const radius = (route.diameterM ?? (silencer ? .21 : route.kind === "duct" ? .125 : .032)) / 2;
  const outerRadius = silencer ? silencerShellRadius(radius) : width && height ? Math.hypot(width, height) / 2 : radius;
  return { silencer, width, height, radius, outerRadius };
}

const silencerShellRadius = (radius: number) => radius * 0.13 / 0.105;

/** Display sizes for an inline fitting whose connection DN may be unrecorded. */
function silencerParts(length: number, radius = 0.105): THREE.BufferGeometry[] {
  const collarLength = Math.min(0.065, 0.16 * length);
  const bodyLength = length - 2 * collarLength;
  const collarCentre = (length - collarLength) / 2;
  return [
    { centre: -collarCentre, length: collarLength, radius, color: SILENCER_COLLAR },
    { centre: 0, length: bodyLength, radius: silencerShellRadius(radius), color: SILENCER_CASING },
    { centre: collarCentre, length: collarLength, radius, color: SILENCER_COLLAR },
  ].map(({ centre, length, radius, color }) => {
    const geometry = new THREE.CylinderGeometry(radius, radius, length, 20, 1).translate(0, centre, 0);
    const colors = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  });
}

export class RouteSolids {
  private readonly pending = new Map<string, SolidBucket>();
  private readonly meshes: SolidMesh[] = [];
  private readonly moving: Record<MotionChannel, SolidMesh[]> = {
    supply: [], extract: [], illustrativeAir: [], pipe: [],
  };
  private readonly bounds = new THREE.Box3();
  private readonly corner = new THREE.Vector3();

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
    private readonly motion: RouteFlowState = createRouteFlowState(),
  ) {}

  add(
    route: Route, group: ExplodeGroup, hex: number, a: Vec3, b: Vec3,
    distance: number, length: number, routeLength: number,
    options: { join: boolean; previous?: Vec3; next?: Vec3; approximate: boolean; immersive: boolean },
  ): void {
    const { join, approximate = false } = options;
    const motion = hasDocumentedFlow(route) ? (route.kind === "duct" ? "air" : "pipe") : null;
    const airStream = classifyAirStream(route.medium, route.airStream);
    const { radius, width, height, silencer } = routeBodyProfile(route);
    const key = `${group}|${hex}|${route.flowState}|${route.certainty}|${motion ?? "static"}|${airStream ?? ""}${silencer ? "|silencer" : ""}${approximate ? "|approximate" : ""}`;
    let bucket = this.pending.get(key);
    if (!bucket) {
      const color = new THREE.Color(hex);
      if (route.flowState === "inactive") color.lerp(new THREE.Color(0x797777), 0.8);
      else if (route.flowState !== "active") color.lerp(new THREE.Color(0x808080), 0.3);
      if (route.certainty === "inferred" || approximate) color.lerp(new THREE.Color(0x9b9b9b), 0.21);
      bucket = { group, color, motion, airStream, silencer, approximate, spans: [], spanCount: 0 };
      this.pending.set(key, bucket);
    }

    const direction = route.flowDirection === "reverse" ? -1 : 1;
    // Repeat the cue more closely on short terminals. All spans in a run share the
    // same scale and arc length, including spans on another floor.
    const repeat = motion ? Math.min(FLOW_MOTION[motion].repeatM, Math.max(0.12, routeLength / 1.35)) : 1;
    const cyclesPerMetre = direction / repeat;
    // Confidence markings are a static surface treatment independent of flow speed or direction.
    const mark = (geometry: THREE.BufferGeometry, station: (index: number, y: number) => number) => {
      if (motion) this.setProgress(geometry, "vhRouteDistance", (i, y) => cyclesPerMetre * station(i, y));
      if (approximate) this.setProgress(geometry, "vhRouteMark", (i, y) => station(i, y) / Math.min(.8, routeLength));
    };
    if (width && height && options.immersive) {
      const shape = rectangularDuctSpan(a, b, width, height, options.previous, options.next);
      // BoxGeometry UVs on the caps are face-oriented, so retain the original longitudinal
      // coordinate of each vertex before the miter was applied.
      const ends = shape.getAttribute("vhDuctEnd");
      mark(shape, i => distance + length * ends.getX(i));
      shape.deleteAttribute("vhDuctEnd");
      bucket.spans.push(shape);
      bucket.spanCount++;
      return;
    }
    const parts = silencer ? silencerParts(length, options.immersive ? radius : undefined) : [width && height
      ? new THREE.BoxGeometry(width, length, height)
      : new THREE.CylinderGeometry(radius, radius, length, options.immersive ? 12 : 10, 1)];
    // Join circular spans only within one semantic floor so the elbow cannot bridge an explode
    // gap. The pulse uses the exact same progress at both sides of the join.
    if (join && !width && !silencer) {
      const elbow = new THREE.SphereGeometry(radius, 10, 6);
      mark(elbow, () => distance);
      elbow.translate(...a);
      bucket.spans.push(elbow);
    }
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const axis = end.clone().sub(start).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(UP, axis);
    const centre = start.add(end).multiplyScalar(0.5);
    for (const part of parts) {
      mark(part, (_, y) => distance + length / 2 + y);
      part.applyQuaternion(rotation);
      part.translate(centre.x, centre.y, centre.z);
      bucket.spans.push(part);
    }
    bucket.spanCount++;
  }

  addOutlets(route: Route, hex: number, routes: readonly Route[], original = route, mixedReality = false): void {
    for (const end of [0, route.points.length - 1]) {
      const originalEnd = end === 0 ? 0 : original.points.length - 1;
      if (original.pointKinds?.[originalEnd] !== "outlet") continue;
      // A patch may expose an original terminal or cut a span at an arbitrary point.
      // Keep a verified fitting only when that terminal survived the clip.
      if (original !== route && route.points[end]!.some((v, axis) =>
        Math.abs(v - original.points[originalEnd]![axis]!) > 1e-5)) continue;
      const outlet = matchDuctOutlet(this.index, original, originalEnd, routes, mixedReality);
      if (!outlet) continue;
      const geometry = ductOutletGeometry(route, outlet, hex);
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.84,
        emissive: 0x332f27,
        emissiveIntensity: 0.20,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `vh-duct-outlet-${route.id}-${end}`;
      mesh.userData.vhDuctOutlet = { floorId: outlet.floorId, surfaceId: outlet.surfaceId };
      if (outlet.schematic) mesh.userData.vhDuctOutlet.schematic = true;
      mesh.raycast = () => {};
      const planes = outlet.surfaceId ? this.clip.planesFor(outlet.surfaceId) : [];
      if (planes.length > 0) material.clippingPlanes = [...planes];
      else this.clip.attach(mesh, outlet.floorId);
      overlayGroup(this.index, outlet.floorId).add(mesh);
      this.meshes.push(mesh);
    }
  }

  private setProgress(geometry: THREE.BufferGeometry, name: string, distanceAtY: (index: number, y: number) => number): void {
    const positions = geometry.getAttribute("position");
    const progress = new Float32Array(positions.count);
    for (let i = 0; i < positions.count; i++) progress[i] = distanceAtY(i, positions.getY(i));
    geometry.setAttribute(name, new THREE.BufferAttribute(progress, 1));
  }

  flush(): void {
    for (const [key, bucket] of this.pending) {
      const geometry = mergeGeometries(bucket.spans);
      bucket.spans.forEach((span) => span.dispose());
      if (!geometry) continue;
      geometry.computeBoundingBox();
      const material = new THREE.MeshStandardMaterial(bucket.silencer
        ? { vertexColors: true, roughness: 0.50, metalness: 0.25 }
        : { color: bucket.color, roughness: 0.72 });
      const pulse = bucket.motion && bucket.airStream ? AIR_STREAM_STYLE[bucket.airStream].pulse : undefined;
      const channel = bucket.motion === "air"
        ? bucket.airStream ? fanForAirStream(bucket.airStream) : "illustrativeAir"
        : bucket.motion;
      if (channel && bucket.motion) {
        const { shader: glow } = FLOW_MOTION[bucket.motion];
        const { phase, enabled } = this.motion[channel];
        material.customProgramCacheKey = () =>
          `vh-route-flow-v4-${pulse === undefined ? "default" : "palette"}-${bucket.motion}`;
        material.onBeforeCompile = (shader) => {
          shader.uniforms.vhRoutePhase = phase;
          shader.uniforms.vhRouteMotion = enabled;
          if (pulse !== undefined) shader.uniforms.vhRoutePulseColor = { value: new THREE.Color(pulse) };
          shader.vertexShader = `attribute float vhRouteDistance;
varying float vhDistance;
${shader.vertexShader}`.replace(
            "#include <begin_vertex>",
            "#include <begin_vertex>\nvhDistance = vhRouteDistance;",
          );
          shader.fragmentShader = `uniform float vhRoutePhase;
uniform float vhRouteMotion;
${pulse !== undefined ? "uniform vec3 vhRoutePulseColor;" : ""}
varying float vhDistance;
${shader.fragmentShader}`.replace(
            "#include <emissivemap_fragment>",
            `#include <emissivemap_fragment>
float phase = fract(vhDistance - vhRoutePhase);
${glow}
totalEmissiveRadiance += ${pulse !== undefined ? "vhRoutePulseColor" : "mix(diffuseColor.rgb, vec3(1.0), 0.5)"} * glow * vhRouteMotion;`,
          );
        };
      }
      if (bucket.approximate) {
        const compileFlow = material.onBeforeCompile.bind(material);
        const flowKey = channel ? material.customProgramCacheKey() : "vh-route-static";
        material.customProgramCacheKey = () => flowKey + "-confidence-bands-v1";
        material.onBeforeCompile = (shader, renderer) => {
          compileFlow(shader, renderer);
          shader.vertexShader = `attribute float vhRouteMark;
varying float vhMark;
${shader.vertexShader}`.replace("#include <begin_vertex>", "#include <begin_vertex>\nvhMark = vhRouteMark;");
          shader.fragmentShader = `varying float vhMark;
${shader.fragmentShader}`.replace("#include <color_fragment>", `#include <color_fragment>
float markPhase = fract(vhMark);
float markDistance = min(abs(markPhase - 0.27), abs(markPhase - 0.34));
float footprint = fwidth(vhMark);
float edge = clamp(footprint, 0.001, 0.025);
float bands = (1.0 - smoothstep(0.014 - edge, 0.014 + edge, markDistance)) *
              (1.0 - smoothstep(0.04, 0.16, footprint));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.76, 0.49), bands * 0.65);`);
        };
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `vh-tube-${key}`;
      mesh.userData.vhRouteSpanCount = bucket.spanCount;
      if (bucket.approximate) mesh.userData.vhApproximatePath = true;
      if (bucket.silencer) mesh.userData.vhDuctFitting = "silencer";
      if (bucket.airStream) mesh.userData.vhAirStream = bucket.airStream;
      if (pulse !== undefined) mesh.userData.vhRoutePulseColor = pulse;
      // The house uses semantic pickables and the route editor's existing point/path targets.
      mesh.raycast = () => {};
      this.clip.attach(mesh, bucket.group);
      overlayGroup(this.index, bucket.group).add(mesh);
      this.meshes.push(mesh);
      if (channel) this.moving[channel].push(mesh);
    }
    this.pending.clear();
  }

  tick(
    delta: number,
    allowMotion: boolean,
    fanRates: Readonly<Record<VentilationFan, number>> = { supply: 1, extract: 1 },
  ): boolean {
    let active = false;
    const elapsed = Math.min(delta, 0.05);
    for (const channel of MOTION_CHANNELS) {
      const uniforms = this.motion[channel];
      const rate = channel === "pipe" ? FLOW_MOTION.pipe.cyclesPerSecond
        : channel === "illustrativeAir" ? FLOW_MOTION.air.cyclesPerSecond
        : FLOW_MOTION.air.cyclesPerSecond * fanRates[channel];
      const visible = allowMotion && rate > 0 && this.moving[channel].some((mesh) => this.isVisible(mesh));
      uniforms.enabled.value = visible ? 1 : 0;
      if (visible) {
        // Integrate speed without restarting the current phase when fan feedback changes.
        uniforms.phase.value = (uniforms.phase.value + rate * elapsed) % 1;
        active = true;
      }
    }
    return active;
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
    for (const channel of MOTION_CHANNELS) this.moving[channel].length = 0;
  }
}
