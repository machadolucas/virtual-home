/**
 * Build a real three.js scene from the fixture (or real) GLBs, in Node, without WebGL.
 *
 * The scene layer is imperative and three-only; none of it needs a GL context (it is all
 * geometry, matrices, materials, visibility flags and raycasting), so it can be unit-tested for
 * real rather than mocked. This helper is a tiny glTF → three converter for the shapes the
 * package actually uses: named nodes with `extras`, one indexed TRIANGLES mesh per surface with
 * POSITION + NORMAL, and one LINES mesh per asset.
 */
import * as THREE from "three";
import { buildManifestIndex, type ManifestIndex } from "@/house/model/manifestIndex";
import { groupsOf } from "@/house/model/explodeGroups";
import { ClipGroups } from "@/house/scene/clipGroups";
import { createSceneIndex, indexAsset, type SceneIndex } from "@/house/scene/SceneIndex";
import type { Manifest } from "@/house/model/types";
import { loadManifest, readGlb, type Glb, type GlbNode } from "./glb";
import fs from "node:fs";
import path from "node:path";

function materialOf(glb: Glb, materialIndex: number | undefined, line: boolean): THREE.Material {
  const spec = materialIndex === undefined ? undefined : glb.json.materials?.[materialIndex];
  const factor = spec?.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
  const color = new THREE.Color().setRGB(
    factor[0] ?? 1,
    factor[1] ?? 1,
    factor[2] ?? 1,
    THREE.LinearSRGBColorSpace,
  );
  if (line) return new THREE.LineBasicMaterial({ color });
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0,
    roughness: 0.9,
    side: spec?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
}

function geometryOf(glb: Glb, node: GlbNode): { geometry: THREE.BufferGeometry; line: boolean; material: number | undefined } | null {
  if (node.mesh === undefined) return null;
  const prim = glb.json.meshes?.[node.mesh]?.primitives[0];
  if (!prim) return null;
  const geometry = new THREE.BufferGeometry();
  const pos = prim.attributes.POSITION;
  if (pos === undefined) return null;
  geometry.setAttribute("position", bufferAttribute(glb, pos, 3));
  const nrm = prim.attributes.NORMAL;
  if (nrm !== undefined) geometry.setAttribute("normal", bufferAttribute(glb, nrm, 3));
  if (prim.indices !== undefined) geometry.setIndex(indexAttribute(glb, prim.indices));
  geometry.computeBoundingSphere();
  return { geometry, line: (prim.mode ?? 4) === 1, material: prim.material };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function rawAccessor(glb: Glb, index: number): Float32Array | Uint16Array | Uint32Array {
  const acc = glb.json.accessors?.[index];
  if (!acc) throw new Error(`no accessor ${index}`);
  const view = glb.json.bufferViews?.[acc.bufferView];
  if (!view) throw new Error(`no bufferView ${acc.bufferView}`);
  const start = glb.bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const count = acc.count * (COMPONENTS[acc.type] ?? 1);
  const buffer = glb.bin.buffer as ArrayBuffer;
  if (acc.componentType === 5126) return new Float32Array(buffer, start, count);
  if (acc.componentType === 5123) return new Uint16Array(buffer, start, count);
  if (acc.componentType === 5125) return new Uint32Array(buffer, start, count);
  throw new Error(`unsupported componentType ${acc.componentType}`);
}

const bufferAttribute = (glb: Glb, index: number, itemSize: number): THREE.BufferAttribute =>
  new THREE.BufferAttribute(new Float32Array(rawAccessor(glb, index) as Float32Array), itemSize);

const indexAttribute = (glb: Glb, index: number): THREE.BufferAttribute => {
  const raw = rawAccessor(glb, index);
  return new THREE.BufferAttribute(
    raw instanceof Uint32Array ? new Uint32Array(raw) : new Uint16Array(raw as Uint16Array),
    1,
  );
};

/** Convert one GLB into the `THREE.Group` the loader would hand to `indexAsset`. */
export function buildAssetRoot(glb: Glb): THREE.Group {
  const build = (i: number): THREE.Object3D => {
    const node = glb.json.nodes[i];
    if (!node) throw new Error(`no node ${i}`);
    const g = geometryOf(glb, node);
    let object: THREE.Object3D;
    if (g) {
      const material = materialOf(glb, g.material, g.line);
      object = g.line
        ? new THREE.LineSegments(g.geometry, material as THREE.LineBasicMaterial)
        : new THREE.Mesh(g.geometry, material);
    } else {
      object = new THREE.Group();
    }
    object.name = node.name ?? "";
    // GLTFLoader copies glTF `extras` onto `userData`, which the picker relies on.
    Object.assign(object.userData, node.extras ?? {});
    for (const c of node.children ?? []) object.add(build(c));
    return object;
  };
  const roots = glb.json.scenes[glb.json.scene ?? 0]?.nodes ?? [];
  const first = roots[0];
  if (first === undefined) throw new Error(`${glb.assetId} has no scene root`);
  const root = build(first) as THREE.Group;
  root.updateMatrixWorld(true);
  return root;
}

export interface BuiltScene {
  scene: THREE.Scene;
  manifest: Manifest;
  manifestIndex: ManifestIndex;
  index: SceneIndex;
  clip: ClipGroups;
  glbs: Map<string, Glb>;
}

export function buildScene(
  dir: string,
  opts: { assetIds?: readonly string[] } = {},
): BuiltScene {
  const manifest = loadManifest(dir);
  const manifestIndex = buildManifestIndex(manifest);
  const index = createSceneIndex(manifestIndex);
  const clip = new ClipGroups(groupsOf(manifestIndex));
  const scene = new THREE.Scene();
  scene.add(index.overlay.root);

  const ids =
    opts.assetIds ?? manifest.assets.filter((a) => a.loadByDefault).map((a) => a.id);
  const glbs = new Map<string, Glb>();
  for (const id of ids) {
    const file = path.join(dir, "assets", `${id}.glb`);
    if (!fs.existsSync(file)) continue;
    const glb = readGlb(file);
    glbs.set(id, glb);
    const root = buildAssetRoot(glb);
    scene.add(root);
    const entry = indexAsset(index, id, root);
    for (const mesh of entry.meshes) {
      const sid = index.meshSurfaceId.get(mesh);
      if (sid) clip.attach(mesh, index.clipGroupOf.get(sid) ?? "site");
    }
    if (entry.edges) clip.attach(entry.edges, "site");
  }
  return { scene, manifest, manifestIndex, index, clip, glbs };
}
