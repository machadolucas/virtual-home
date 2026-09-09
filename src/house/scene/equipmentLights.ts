import * as THREE from "three";
import type { Vec3 } from "../model/types";

/** Fixed light slots keep shader programs stable when HA lights switch on and off. */
export const LIGHT_SLOTS_PER_KIND = 8;
export interface EquipmentLightSpec {
  id: string;
  spot: boolean;
  position: Vec3;
  direction: Vec3;
  color: Vec3;
  brightness: number;
}

/** Local, illustrative illumination; no shadow maps or household model mutation. */
export class EquipmentLightLayer {
  readonly root = new THREE.Group();
  private readonly points: THREE.PointLight[] = [];
  private readonly spots: THREE.SpotLight[] = [];
  private signature = "";
  private active: EquipmentLightSpec[] = [];

  constructor(scene: THREE.Scene) {
    this.root.name = "vh-equipment-lights";
    for (let i = 0; i < LIGHT_SLOTS_PER_KIND; i++) {
      const point = new THREE.PointLight(0xffffff, 0, 5, 2);
      const spot = new THREE.SpotLight(0xffffff, 0, 8, Math.PI / 7, 0.45, 2);
      point.name = `vh-live-point-${i}`;
      spot.name = `vh-live-spot-${i}`;
      this.points.push(point);
      this.spots.push(spot);
      this.root.add(point, spot, spot.target);
    }
    scene.add(this.root);
  }

  /** Caller orders candidates by relevance/distance. Returns true only for a visible change. */
  set(specs: readonly EquipmentLightSpec[], limit = LIGHT_SLOTS_PER_KIND): boolean {
    const points = specs.filter((s) => !s.spot).slice(0, limit);
    const spots = specs.filter((s) => s.spot).slice(0, limit);
    const signature = JSON.stringify([points, spots]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.active = [...points, ...spots];
    for (let i = 0; i < LIGHT_SLOTS_PER_KIND; i++) {
      this.apply(this.points[i]!, points[i]);
      this.apply(this.spots[i]!, spots[i]);
    }
    return true;
  }

  private apply(light: THREE.PointLight | THREE.SpotLight, spec: EquipmentLightSpec | undefined) {
    if (!spec) { light.intensity = 0; return; }
    light.position.fromArray(spec.position);
    light.color.setRGB(...spec.color, THREE.SRGBColorSpace);
    // A readable local pool at normal room dimensions; HA brightness scales it linearly.
    light.intensity = spec.brightness * (spec.spot ? 90 : 30);
    if (light instanceof THREE.SpotLight) {
      light.target.position.copy(light.position).add(new THREE.Vector3(...spec.direction));
      light.target.updateMatrixWorld();
    }
    light.updateMatrixWorld();
  }

  snapshot(): EquipmentLightSpec[] { return this.active.map((s) => ({ ...s })); }

  dispose() {
    this.root.removeFromParent();
    for (const light of [...this.points, ...this.spots]) light.dispose();
    this.root.clear();
    this.active = [];
  }
}
