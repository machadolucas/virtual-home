import * as THREE from "three";
import type { EquipmentLightSpec } from "./equipmentLights";

interface Emitter {
  position: THREE.Vector3;
  color: THREE.Color;
  target: THREE.Color;
}

/** One instanced draw call makes every live bulb visibly luminous, independently of shadow slots. */
export class LightEmitters {
  private readonly geometry = new THREE.SphereGeometry(0.055, 8, 6);
  private readonly material = new THREE.MeshBasicMaterial({ toneMapped: false });
  private mesh: THREE.InstancedMesh;
  private readonly entries = new Map<string, Emitter>();
  private readonly matrix = new THREE.Matrix4();
  private capacity = 64;
  private dirty = false;

  constructor(private readonly parent: THREE.Group) {
    this.mesh = this.createMesh();
  }

  private createMesh(): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.capacity);
    mesh.name = "vh-live-emitting-cores";
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.raycast = () => {};
    this.parent.add(mesh);
    return mesh;
  }

  set(specs: readonly EquipmentLightSpec[]): void {
    const wanted = new Set(specs.map((s) => s.id));
    for (const [id, entry] of this.entries) if (!wanted.has(id)) entry.target.setRGB(0, 0, 0);
    for (const spec of specs) {
      let entry = this.entries.get(spec.id);
      if (!entry) {
        entry = { position: new THREE.Vector3(), color: new THREE.Color(0), target: new THREE.Color() };
        this.entries.set(spec.id, entry);
      }
      entry.position.fromArray(spec.position);
      // A lamp's bright emitter remains recognizable without multiplying its surface illumination.
      entry.target.setRGB(...spec.color, THREE.SRGBColorSpace).multiplyScalar(Math.min(3, spec.brightness * 3));
    }
    this.dirty = true;
  }

  tick(delta: number): boolean {
    let moving = false;
    const amount = Math.min(1, delta / 0.045);
    for (const [id, entry] of this.entries) {
      entry.color.lerp(entry.target, amount);
      const distance = Math.abs(entry.color.r - entry.target.r) + Math.abs(entry.color.g - entry.target.g) + Math.abs(entry.color.b - entry.target.b);
      if (distance < 0.002) entry.color.copy(entry.target);
      else moving = true;
      if (entry.color.r + entry.color.g + entry.color.b === 0) this.entries.delete(id);
    }
    if (!moving && !this.dirty) return false;
    if (this.entries.size > this.capacity) {
      this.capacity = 2 ** Math.ceil(Math.log2(this.entries.size));
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = this.createMesh();
    }
    let i = 0;
    for (const entry of this.entries.values()) {
      this.matrix.makeTranslation(entry.position);
      this.mesh.setMatrixAt(i, this.matrix);
      this.mesh.setColorAt(i++, entry.color);
    }
    this.mesh.count = i;
    this.mesh.visible = i > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = moving;
    return true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.entries.clear();
  }
}
