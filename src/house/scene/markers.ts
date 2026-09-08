/**
 * Equipment markers: one `InstancedMesh` per explode group.
 *
 * 200 markers as 200 meshes would be 200 draw calls, 200 matrix updates and (with drei
 * `<Instances>`) 200 React components. Per group it is one draw call, ≤ 256 instances, an
 * `instanceColor` channel for the HA state, and the explode offset comes free from the overlay
 * group's transform.
 *
 * The **primary hit target is the DOM marker**, not this dot: a 0.06 m sphere is a ~6 px target,
 * which fails both the hit-target and the accessibility requirements. The 3D instance provides the
 * depth-correct, wall-occluded, cutaway-clipped dot and a secondary pick path.
 */
import * as THREE from "three";
import type { ExplodeGroup, Placement, PlacementId } from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import { overlayGroup, type SceneIndex } from "./SceneIndex";

export const MARKER_CAPACITY = 256;
export const MARKER_RADIUS = 0.06;

/** Instance colours by HA state class. Style, not the only channel — the DOM badge carries shape. */
export const MARKER_COLORS: Record<string, number> = {
  live: 0x2f7d4f,
  unavailable: 0x9a9a95,
  unknown: 0x9a9a95,
  stale: 0xb08420,
  low: 0xc0562a,
  critical: 0xb02a2a,
  unlinked: 0x6a6a66,
  disconnected: 0x8b8b87,
  selected: 0x2f6fd0,
};

export interface MarkerGroupState {
  mesh: THREE.InstancedMesh;
  ids: PlacementId[];
}

export class MarkerLayer {
  private readonly geometry: THREE.SphereGeometry;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly groups = new Map<ExplodeGroup, MarkerGroupState>();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
  ) {
    this.geometry = new THREE.SphereGeometry(MARKER_RADIUS, 10, 8);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
  }

  private groupFor(group: ExplodeGroup): MarkerGroupState {
    let state = this.groups.get(group);
    if (!state) {
      const mesh = new THREE.InstancedMesh(this.geometry, this.material, MARKER_CAPACITY);
      mesh.name = `vh-markers-${group}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(MARKER_CAPACITY * 3),
        3,
      );
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span a whole floor
      this.clip.attach(mesh, group);
      overlayGroup(this.index, group).add(mesh);
      state = { mesh, ids: [] };
      this.groups.set(group, state);
    }
    return state;
  }

  /** Rebuild all groups from the placement list. Positions are physical, never exploded. */
  set(
    placements: readonly Placement[],
    stateOf: (p: Placement) => string,
    groupOf: (p: Placement) => ExplodeGroup,
  ): void {
    for (const state of this.groups.values()) {
      state.mesh.count = 0;
      state.ids.length = 0;
    }
    for (const p of placements) {
      const state = this.groupFor(groupOf(p));
      if (state.mesh.count >= MARKER_CAPACITY) continue;
      const i = state.mesh.count;
      this.matrix.makeTranslation(p.position[0], p.position[1], p.position[2]);
      state.mesh.setMatrixAt(i, this.matrix);
      this.color.setHex(MARKER_COLORS[stateOf(p)] ?? MARKER_COLORS.unlinked ?? 0x808080);
      state.mesh.setColorAt(i, this.color);
      state.ids.push(p.id);
      state.mesh.count = i + 1;
    }
    for (const state of this.groups.values()) {
      state.mesh.instanceMatrix.needsUpdate = true;
      if (state.mesh.instanceColor) state.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Recolour one marker in place. Returns true when a colour actually changed (→ invalidate). */
  setStateColor(placementId: PlacementId, stateClass: string): boolean {
    const hex = MARKER_COLORS[stateClass] ?? MARKER_COLORS.unlinked ?? 0x808080;
    for (const state of this.groups.values()) {
      const i = state.ids.indexOf(placementId);
      if (i < 0 || !state.mesh.instanceColor) continue;
      const attr = state.mesh.instanceColor;
      this.color.setHex(hex);
      if (
        Math.abs((attr.getX(i) ?? 0) - this.color.r) < 1e-6 &&
        Math.abs((attr.getY(i) ?? 0) - this.color.g) < 1e-6 &&
        Math.abs((attr.getZ(i) ?? 0) - this.color.b) < 1e-6
      )
        return false;
      state.mesh.setColorAt(i, this.color);
      attr.needsUpdate = true;
      return true;
    }
    return false;
  }

  /** `hit.instanceId` → placement id. */
  placementAt(mesh: THREE.Object3D, instanceId: number): PlacementId | null {
    for (const state of this.groups.values())
      if (state.mesh === mesh) return state.ids[instanceId] ?? null;
    return null;
  }

  get meshes(): THREE.InstancedMesh[] {
    return [...this.groups.values()].map((s) => s.mesh);
  }

  dispose(): void {
    for (const state of this.groups.values()) {
      state.mesh.removeFromParent();
      state.mesh.dispose();
    }
    this.groups.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
