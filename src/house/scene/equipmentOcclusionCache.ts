import type * as THREE from "three";
import { EquipmentOcclusion } from "./equipmentOcclusion";
import type { SceneIndex } from "./SceneIndex";
import type { ClipGroups } from "./clipGroups";

/** Labels and click targets share one visibility result per mount. Camera motion samples at 10 Hz;
 * a single trailing frame resolves the final pose, without creating an idle render loop. */
export class EquipmentOcclusionCache {
  private readonly tester = new EquipmentOcclusion();
  private readonly results = new Map<string, boolean>();
  private index: SceneIndex | null = null;
  private revision = -1;
  private pose = "";
  private sampledAt = -Infinity;
  private pending: ReturnType<typeof setTimeout> | null = null;
  queries = 0;
  batches = 0;

  beginFrame(index: SceneIndex, clip: ClipGroups | null, camera: THREE.Camera, revision: number, invalidate: () => void, now = performance.now()): void {
    camera.updateMatrixWorld(true);
    const pose = camera.matrixWorld.elements.join(",") + camera.projectionMatrix.elements.join(",");
    const changed = this.index !== index || this.revision !== revision;
    if (!changed && pose === this.pose) return;
    if (!changed && now - this.sampledAt < 100) {
      if (this.pending === null) this.pending = setTimeout(() => { this.pending = null; invalidate(); }, 100 - (now - this.sampledAt));
      return;
    }
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    this.index = index;
    this.revision = revision;
    this.pose = pose;
    this.sampledAt = now;
    this.results.clear();
    this.tester.beginFrame(index, clip, camera);
    this.batches++;
  }

  isOccluded(world: THREE.Vector3): boolean {
    const key = `${world.x},${world.y},${world.z}`;
    const known = this.results.get(key);
    if (known !== undefined) return known;
    const hidden = this.tester.isOccluded(world);
    this.results.set(key, hidden);
    this.queries++;
    return hidden;
  }

  dispose(): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = null;
    this.index = null;
    this.results.clear();
    this.pose = "";
    this.revision = -1;
    this.sampledAt = -Infinity;
  }
}
