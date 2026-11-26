import * as THREE from "three";

/** A model can encode both opened leaves of a double door in one mesh. Clear the authored leaf
 * in place, and keep it open until the walkthrough ends. Its frame and threshold stay physical. */
export class DoorPassage {
  open = false;
  private opacity = 1;
  private original?: THREE.Material | THREE.Material[];
  private fading: THREE.Material[] = [];
  private initialOpacity: number[] = [];

  constructor(
    readonly id: string,
    readonly mesh: THREE.Mesh,
    readonly bounds: THREE.Box3,
  ) {}

  clear(immediate = false) {
    if (this.open) return;
    this.open = true;
    this.original = this.mesh.material;
    const source = Array.isArray(this.original) ? this.original : [this.original];
    this.initialOpacity = source.map((material) => material.opacity);
    this.fading = source.map((material) => {
      const copy = material.clone();
      copy.onBeforeCompile = material.onBeforeCompile;
      copy.customProgramCacheKey = material.customProgramCacheKey.bind(material);
      copy.transparent = true;
      copy.depthWrite = false;
      return copy;
    });
    this.mesh.material = Array.isArray(this.original) ? this.fading : this.fading[0]!;
    if (immediate) this.tick(1);
  }

  tick(dt: number) {
    if (!this.open || this.opacity === 0) return;
    this.opacity = Math.max(0, this.opacity - dt / 0.18);
    for (const [i, material] of this.fading.entries()) {
      material.opacity = this.opacity * this.initialOpacity[i]!;
      material.visible = this.opacity > 0;
    }
  }

  dispose() {
    if (this.original) this.mesh.material = this.original;
    for (const material of this.fading) material.dispose();
  }
}
