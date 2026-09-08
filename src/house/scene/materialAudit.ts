/**
 * Load-time material audit.
 *
 * The package guarantees one material per surface mesh, which is what makes
 * `mesh.material.color.set(...)` a safe, leak-free way to colour a single room face. This audit is
 * the guard: if a future package revision ever shared a material between two meshes, the second
 * user gets a clone instead of silently repainting its neighbour.
 *
 * Measured today: `cloned === 0` for every asset of the shipped package.
 */
import * as THREE from "three";
import type { AssetEntry } from "./SceneIndex";

export interface MaterialAudit {
  assetId: string;
  materialCount: number;
  meshCount: number;
  cloned: number;
  /** Surfaces whose node carries no material at all (the degenerate-band case). */
  materialless: number;
}

export function auditMaterials(entry: AssetEntry): MaterialAudit {
  const users = new Map<THREE.Material, THREE.Object3D[]>();
  let meshCount = 0;
  let materialless = 0;

  entry.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const line = o as THREE.LineSegments;
    if (!mesh.isMesh && !line.isLineSegments) {
      if (o.userData.surfaceId) materialless++;
      return;
    }
    meshCount++;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat || Array.isArray(mat)) return;
    const list = users.get(mat);
    if (list) list.push(o);
    else users.set(mat, [o]);
  });

  let cloned = 0;
  for (const [mat, objects] of users) {
    if (objects.length === 1) continue;
    for (let i = 1; i < objects.length; i++) {
      const target = objects[i] as THREE.Mesh;
      const copy = mat.clone();
      target.material = copy;
      entry.disposables.materials.add(copy);
      cloned++;
    }
  }

  return { assetId: entry.id, materialCount: users.size, meshCount, cloned, materialless };
}
