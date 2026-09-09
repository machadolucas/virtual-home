import * as THREE from "three";
import type { Vec3 } from "../model/types";
import type { SceneIndex } from "./SceneIndex";

/** Fixed light slots keep shader programs stable when HA lights switch on and off. */
export const LIGHT_SLOTS_PER_KIND = 4;
/** Every emitting source casts a shadow; these caps bound the shadow passes. */
export const LIGHT_BUDGET = { point: 4, spot: 4 } as const;
export const PERFORMANCE_LIGHT_BUDGET = { point: 1, spot: 1 } as const;
/** Short enough to feel live, long enough to avoid a hard flash on an HA event. */
export const LIGHT_FADE_SECONDS = 0.16;

const POINT_INTENSITY = 18;
const SPOT_INTENSITY = 55;
const SETTLE_EPSILON = 0.0005;

export interface EquipmentLightSpec {
  id: string;
  spot: boolean;
  position: Vec3;
  direction: Vec3;
  color: Vec3;
  brightness: number;
}

export interface EquipmentLightBudget {
  point: number;
  spot: number;
}

export interface RenderedEquipmentLight {
  id: string;
  kind: "point" | "spot";
  intensity: number;
  castShadow: boolean;
  shadowMapSize: number;
  shadowMapAllocated: boolean;
  fading: boolean;
}

interface Fade {
  elapsed: number;
  fromIntensity: number;
  toIntensity: number;
  fromColor: THREE.Color;
  toColor: THREE.Color;
}

/**
 * Make model surfaces diffuse receivers and full-geometry occluders. `clipShadows=false` is
 * deliberate: cutaway/focus clipping changes what the camera sees, while the original wall and
 * door geometry continues to block a neighbouring room's light.
 */
export function prepareEquipmentLightSurfaces(index: SceneIndex): boolean {
  let changed = false;
  for (const entry of index.assets.values()) {
    if (index.manifest.assets.get(entry.id)?.kind === "scan-reference") continue;
    for (const mesh of entry.meshes) {
      if (!mesh.castShadow || !mesh.receiveShadow) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        changed = true;
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE.MeshStandardMaterial;
        if ("roughness" in standard && standard.roughness < 0.94) {
          standard.roughness = 0.94;
          changed = true;
        }
        if (material.clipShadows) {
          material.clipShadows = false;
          changed = true;
        }
      }
    }
  }
  return changed;
}

/** Local illustrative illumination with a fixed pool and a bounded shadow budget. */
export class EquipmentLightLayer {
  readonly root = new THREE.Group();
  private readonly points: THREE.PointLight[] = [];
  private readonly spots: THREE.SpotLight[] = [];
  private readonly fades = new Map<THREE.Light, Fade>();
  private readonly assignments = new Map<THREE.Light, string>();
  private signature = "";
  private active: EquipmentLightSpec[] = [];

  constructor(scene: THREE.Scene) {
    this.root.name = "vh-equipment-lights";
    for (let i = 0; i < LIGHT_SLOTS_PER_KIND; i++) {
      const point = new THREE.PointLight(0xffffff, 0, 5, 2);
      const spot = new THREE.SpotLight(0xffffff, 0, 8, Math.PI / 7, 0.45, 2);
      point.name = `vh-live-point-${i}`;
      spot.name = `vh-live-spot-${i}`;
      configureShadow(point, 128);
      configureShadow(spot, 256);
      this.points.push(point);
      this.spots.push(spot);
      this.root.add(point, spot, spot.target);
    }
    scene.add(this.root);
  }

  /** Caller orders candidates by relevance/distance. Returns true only for a target change. */
  set(
    specs: readonly EquipmentLightSpec[],
    budget: EquipmentLightBudget = LIGHT_BUDGET,
  ): boolean {
    const points = specs.filter((spec) => !spec.spot).slice(0, budget.point);
    const spots = specs.filter((spec) => spec.spot).slice(0, budget.spot);
    const signature = JSON.stringify([points, spots, budget.point, budget.spot]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.active = [...points, ...spots];
    this.reconcile(this.points, points, budget.point);
    this.reconcile(this.spots, spots, budget.spot);
    return true;
  }

  private reconcile(
    lights: readonly (THREE.PointLight | THREE.SpotLight)[],
    specs: readonly EquipmentLightSpec[],
    budget: number,
  ): void {
    const wanted = new Map(specs.map((spec) => [spec.id, spec]));
    const reserved = new Set<number>();

    // Keep surviving fixtures in their current slots. Otherwise A switching off would shift B
    // into A's slot and abruptly discard A's fade-out.
    for (let i = 0; i < budget; i++) {
      const light = lights[i]!;
      const id = this.assignments.get(light);
      const spec = id ? wanted.get(id) : undefined;
      if (!spec) continue;
      reserved.add(i);
      wanted.delete(id!);
      this.apply(light, spec);
    }

    for (let i = 0; i < LIGHT_SLOTS_PER_KIND; i++) {
      const light = lights[i]!;
      light.castShadow = i < budget;
      if (i >= budget) this.apply(light, undefined);
      else if (!reserved.has(i) && this.assignments.has(light)) this.apply(light, undefined);
    }

    for (const spec of wanted.values()) {
      let slot = lights.findIndex(
        (light, i) =>
          i < budget &&
          !reserved.has(i) &&
          (!this.assignments.has(light) || (light.intensity === 0 && !this.fades.has(light))),
      );
      // At a full budget a newly prioritized fixture must replace one old occupant. Camera-driven
      // priority replacement is allowed to be immediate; HA changes with spare capacity still fade.
      if (slot < 0) {
        for (let i = budget - 1; i >= 0; i--) {
          if (!reserved.has(i)) { slot = i; break; }
        }
      }
      if (slot < 0) continue;
      reserved.add(slot);
      this.apply(lights[slot]!, spec);
    }
  }

  /** Advance active fades. Returning true asks demand rendering for one more frame. */
  tick(deltaSeconds: number): boolean {
    if (!(deltaSeconds > 0) || this.fades.size === 0) return false;
    let changed = false;
    for (const [light, fade] of this.fades) {
      fade.elapsed = Math.min(LIGHT_FADE_SECONDS, fade.elapsed + deltaSeconds);
      const t = fade.elapsed / LIGHT_FADE_SECONDS;
      const eased = t * t * (3 - 2 * t);
      light.intensity = THREE.MathUtils.lerp(fade.fromIntensity, fade.toIntensity, eased);
      light.color.copy(fade.fromColor).lerp(fade.toColor, eased);
      changed = true;
      if (
        fade.elapsed >= LIGHT_FADE_SECONDS ||
        (Math.abs(light.intensity - fade.toIntensity) < SETTLE_EPSILON &&
          colorDistance(light.color, fade.toColor) < SETTLE_EPSILON)
      ) {
        light.intensity = fade.toIntensity;
        light.color.copy(fade.toColor);
        this.fades.delete(light);
      }
    }
    return changed;
  }

  get fading(): boolean {
    return this.fades.size > 0;
  }

  private apply(
    light: THREE.PointLight | THREE.SpotLight,
    spec: EquipmentLightSpec | undefined,
  ): void {
    const targetColor = spec
      ? new THREE.Color().setRGB(...spec.color, THREE.SRGBColorSpace)
      : light.color.clone();
    const targetIntensity = spec
      ? spec.brightness * (spec.spot ? SPOT_INTENSITY : POINT_INTENSITY)
      : 0;
    if (!spec) {
      this.startFade(light, targetIntensity, targetColor);
      return;
    }

    if (this.assignments.get(light) !== spec.id) {
      // Priority changes can reuse a fixed slot at a different physical position. Never carry the
      // previous fixture's brightness across the room; the new occupant fades up from dark.
      light.intensity = 0;
      light.color.copy(targetColor);
      this.assignments.set(light, spec.id);
    }
    light.position.fromArray(spec.position);
    if (light instanceof THREE.SpotLight) {
      light.target.position.copy(light.position).add(new THREE.Vector3(...spec.direction));
      light.target.updateMatrixWorld();
    }
    light.updateMatrixWorld();
    this.startFade(light, targetIntensity, targetColor);
  }

  private startFade(light: THREE.Light, targetIntensity: number, targetColor: THREE.Color): void {
    if (
      Math.abs(light.intensity - targetIntensity) < SETTLE_EPSILON &&
      colorDistance(light.color, targetColor) < SETTLE_EPSILON
    ) {
      light.intensity = targetIntensity;
      light.color.copy(targetColor);
      this.fades.delete(light);
      return;
    }
    this.fades.set(light, {
      elapsed: 0,
      fromIntensity: light.intensity,
      toIntensity: targetIntensity,
      fromColor: light.color.clone(),
      toColor: targetColor,
    });
  }

  snapshot(): EquipmentLightSpec[] {
    return this.active.map((spec) => ({ ...spec }));
  }

  /** Read-only diagnostics for the browser regression hook. */
  renderedSnapshot(): RenderedEquipmentLight[] {
    const result: RenderedEquipmentLight[] = [];
    const append = (light: THREE.PointLight | THREE.SpotLight, kind: "point" | "spot") => {
      const id = this.assignments.get(light);
      if (!id || (light.intensity === 0 && !this.fades.has(light))) return;
      result.push({
        id,
        kind,
        intensity: light.intensity,
        castShadow: light.castShadow,
        shadowMapSize: light.shadow.mapSize.width,
        shadowMapAllocated: light.shadow.map !== null,
        fading: this.fades.has(light),
      });
    };
    for (const light of this.points) append(light, "point");
    for (const light of this.spots) append(light, "spot");
    return result;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const light of [...this.points, ...this.spots]) light.dispose();
    this.root.clear();
    this.fades.clear();
    this.assignments.clear();
    this.active = [];
  }
}

function configureShadow(light: THREE.PointLight | THREE.SpotLight, mapSize: number): void {
  light.castShadow = false;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.camera.near = 0.05;
  light.shadow.camera.far = light.distance;
  light.shadow.radius = 2;
  light.shadow.bias = -0.0008;
  light.shadow.normalBias = 0.025;
}

function colorDistance(a: THREE.Color, b: THREE.Color): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}
