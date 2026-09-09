/**
 * Equipment markers: one `InstancedMesh` per explode group and symbol.
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
import { getViewerPalette, type MarkerStateClass } from "./palette";
import { overlayGroup, type SceneIndex } from "./SceneIndex";
import { symbolGeometry, type PlacementSymbol } from "./symbols";

export const MARKER_CAPACITY = 256;
export const MARKER_RADIUS = 0.06;

/**
 * Instance colour for one HA state class, from the live tokens (`scene/palette.ts`).
 *
 * Style, not the only channel — the DOM marker carries the state as a shape too (filled / hollow /
 * dotted ring), so a viewer who cannot separate the hues loses nothing.
 */
export function markerColor(stateClass: string): number {
  const palette = getViewerPalette();
  return palette.marker[stateClass as MarkerStateClass] ?? palette.marker.unlinked;
}

export interface MarkerGroupState {
  mesh: THREE.InstancedMesh;
  ids: PlacementId[];
}

/**
 * One instanced mesh per (explode group × symbol).
 *
 * The split by symbol is what lets a lamp post look like a lamp post: instancing needs one
 * geometry per mesh, so a second silhouette means a second mesh. The cost is bounded — a
 * household uses a handful of symbols per floor, and each mesh is still one draw call for up to
 * 256 markers, which is the property they were instanced for in the first place.
 */
type MarkerKey = string;

const keyOf = (group: ExplodeGroup, symbol: PlacementSymbol): MarkerKey => `${group}::${symbol}`;

export class MarkerLayer {
  private readonly material: THREE.MeshStandardMaterial;
  private readonly groups = new Map<MarkerKey, MarkerGroupState & { group: ExplodeGroup }>();
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly position = new THREE.Vector3();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);
  private readonly color = new THREE.Color();

  constructor(
    private readonly index: SceneIndex,
    private readonly clip: ClipGroups,
  ) {
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  }

  private groupFor(group: ExplodeGroup, symbol: PlacementSymbol): MarkerGroupState {
    const key = keyOf(group, symbol);
    let state = this.groups.get(key);
    if (!state) {
      const mesh = new THREE.InstancedMesh(
        symbolGeometry(symbol),
        this.material,
        MARKER_CAPACITY,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `vh-markers-${group}-${symbol}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(MARKER_CAPACITY * 3),
        3,
      );
      mesh.count = 0;
      mesh.frustumCulled = false; // instances span a whole floor
      this.clip.attach(mesh, group);
      overlayGroup(this.index, group).add(mesh);
      state = { mesh, ids: [], group };
      this.groups.set(key, state);
    }
    return state;
  }

  /** Rebuild all groups from the placement list. Positions are physical, never exploded. */
  set(
    placements: readonly Placement[],
    stateOf: (p: Placement) => string,
    groupOf: (p: Placement) => ExplodeGroup,
    symbolOf: (p: Placement) => PlacementSymbol = () => "generic",
  ): void {
    for (const state of this.groups.values()) {
      state.mesh.count = 0;
      state.ids.length = 0;
    }
    for (const p of placements) {
      const state = this.groupFor(groupOf(p), symbolOf(p));
      if (state.mesh.count >= MARKER_CAPACITY) continue;
      const i = state.mesh.count;
      // Yaw matters now that symbols have a front: a wall lamp's shade has to point away from the
      // wall it is bolted to, which is the rotation the wall snap already solved for.
      this.position.set(p.position[0], p.position[1], p.position[2]);
      this.euler.set(0, THREE.MathUtils.degToRad(p.rotationYDeg ?? 0), 0);
      this.quaternion.setFromEuler(this.euler);
      this.matrix.compose(this.position, this.quaternion, this.unitScale);
      state.mesh.setMatrixAt(i, this.matrix);
      this.color.setHex(markerColor(stateOf(p)));
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
    const hex = markerColor(stateClass);
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
    this.material.dispose();
    // The symbol geometries are shared and immutable, so they outlive one layer on purpose:
    // disposing them here would pull the geometry out from under a second workspace mounting.
  }
}
