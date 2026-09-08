/**
 * Full teardown.
 *
 * Because the viewer never uses `useLoader` / `useGLTF`, there is no global URL cache to clear:
 * everything reachable is owned by the `SceneIndex`, and disposing it is sufficient. `renderer`
 * disposal and context loss are left to R3F.
 */
import * as THREE from "three";
import type { SceneIndex } from "./SceneIndex";

export interface DisposeReport {
  geometries: number;
  materials: number;
  assets: number;
}

export function disposeTree(root: THREE.Object3D): { geometries: number; materials: number } {
  let geometries = 0;
  let materials = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
      geometries++;
    }
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) {
      for (const m of mat) {
        m.dispose();
        materials++;
      }
    } else if (mat) {
      mat.dispose();
      materials++;
    }
    const instanced = o as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) instanced.dispose();
  });
  return { geometries, materials };
}

export function disposeViewer(index: SceneIndex, scene: THREE.Scene | null): DisposeReport {
  let geometries = 0;
  let materials = 0;
  const assets = index.assets.size;

  for (const entry of index.assets.values()) {
    entry.root.removeFromParent();
    scene?.remove(entry.root);
    const counted = disposeTree(entry.root);
    geometries += counted.geometries;
    materials += counted.materials;
    // Anything the audit cloned or the loader created but the tree no longer reaches.
    for (const g of entry.disposables.geometries) g.dispose();
    for (const m of entry.disposables.materials) m.dispose();
    entry.nodes.clear();
    entry.meshes.length = 0;
  }

  for (const group of index.overlay.floorGroups.values()) {
    group.removeFromParent();
    const counted = disposeTree(group);
    geometries += counted.geometries;
    materials += counted.materials;
  }
  index.overlay.root.removeFromParent();
  scene?.remove(index.overlay.root);
  index.overlay.floorGroups.clear();

  index.assets.clear();
  index.surfaceNode.clear();
  index.surfaceMesh.clear();
  index.elementGroups.clear();
  index.floorNodes.clear();
  index.buildingNodes.clear();
  index.originalColor.clear();
  index.clipGroupOf.clear();
  index.pickables.length = 0;

  return { geometries, materials, assets };
}

/** Dispose a loaded root that arrived after an abort (a stale StrictMode double-mount load). */
export function disposeRoot(root: THREE.Object3D): void {
  root.removeFromParent();
  disposeTree(root);
}
