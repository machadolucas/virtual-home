/**
 * `SceneIndex` — every `Object3D` lookup the viewer needs, built once per asset as it loads and
 * kept **outside React state** (a ref behind a non-reactive context).
 *
 * Everything is keyed by manifest ids. Node names are only used as `(assetId, nodeName)` pairs.
 * `floorNodes` and `elementGroups` are arrays because the same node name demonstrably appears in
 * several assets (`f-upper` in four of them in the shipped package).
 */
import * as THREE from "three";
import { clipGroupOf, explodeGroupOf } from "@/house/model/explodeGroups";
import { nodeKey, type ManifestIndex } from "@/house/model/manifestIndex";
import type {
  AssetId,
  BuildingId,
  ElementId,
  ExplodeGroup,
  FloorId,
  SurfaceId,
} from "@/house/model/types";
import type { AssetNodeInventory } from "@/house/model/visibilityPlan";
import { invalidWallCap, withoutCapEdges } from "./invalidWallCaps";

export interface AssetEntry {
  id: AssetId;
  root: THREE.Group;
  /** name → object, every level, including the edges node and mesh-less surface nodes. */
  nodes: Map<string, THREE.Object3D>;
  /** Surface meshes only (never the edges LineSegments). */
  meshes: THREE.Mesh[];
  edges: THREE.LineSegments | null;
  inventory: AssetNodeInventory;
  disposables: {
    geometries: Set<THREE.BufferGeometry>;
    materials: Set<THREE.Material>;
  };
}

export interface SceneIndex {
  manifest: ManifestIndex;
  assets: Map<AssetId, AssetEntry>;

  surfaceNode: Map<SurfaceId, THREE.Object3D>;
  /** Mesh-backed surfaces only. Two surfaces of the shipped package are absent by design. */
  surfaceMesh: Map<SurfaceId, THREE.Mesh>;
  elementGroups: Map<ElementId, THREE.Object3D[]>;
  floorNodes: Map<FloorId, THREE.Object3D[]>;
  /** Semantic floor visibility also applies to app-owned equipment, even without floor nodes. */
  hiddenGroups: Set<ExplodeGroup>;
  buildingNodes: Map<BuildingId, THREE.Object3D[]>;
  meshSurfaceId: WeakMap<THREE.Object3D, SurfaceId>;

  /** sRGB hex int captured from the material at load; diagnostic only — reset uses the manifest. */
  originalColor: Map<SurfaceId, number>;
  clipGroupOf: Map<SurfaceId, ExplodeGroup>;

  overlay: {
    root: THREE.Group;
    floorGroups: Map<ExplodeGroup, THREE.Group>;
  };

  /** Visible meshes with all ancestors visible. Rebuilt by `applyVisibility`, read by the picker. */
  pickables: THREE.Object3D[];
}

export function createSceneIndex(manifest: ManifestIndex): SceneIndex {
  const root = new THREE.Group();
  root.name = "vh-overlay";
  return {
    manifest,
    assets: new Map(),
    surfaceNode: new Map(),
    surfaceMesh: new Map(),
    elementGroups: new Map(),
    floorNodes: new Map(),
    hiddenGroups: new Set(),
    buildingNodes: new Map(),
    meshSurfaceId: new WeakMap(),
    originalColor: new Map(),
    clipGroupOf: new Map(),
    overlay: { root, floorGroups: new Map() },
    pickables: [],
  };
}

/** App-owned group per explode group; hosts markers, routes and anchors at physical coordinates. */
export function overlayGroup(index: SceneIndex, group: ExplodeGroup): THREE.Group {
  let g = index.overlay.floorGroups.get(group);
  if (!g) {
    g = new THREE.Group();
    g.name = `vh-overlay-${group}`;
    g.visible = !index.hiddenGroups.has(group);
    index.overlay.root.add(g);
    index.overlay.floorGroups.set(group, g);
  }
  return g;
}

const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;
const isLineSegments = (o: THREE.Object3D): o is THREE.LineSegments =>
  (o as THREE.LineSegments).isLineSegments === true;

/**
 * Index one loaded asset root. Called incrementally, once per asset, so the workspace can go
 * interactive as soon as the shell tier is in.
 */
export function indexAsset(index: SceneIndex, assetId: AssetId, root: THREE.Group): AssetEntry {
  const m = index.manifest;
  const nodes = new Map<string, THREE.Object3D>();
  const meshes: THREE.Mesh[] = [];
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let edges: THREE.LineSegments | null = null;

  const floorNodeNames: string[] = [];
  const floorlessElementNodes: string[] = [];

  root.name = assetId;
  root.userData.assetId = assetId;

  root.traverse((o) => {
    if (o.name && !nodes.has(o.name)) nodes.set(o.name, o);
    if (isMesh(o)) {
      if (o.geometry) geometries.add(o.geometry);
      collectMaterials(o.material, materials);
    } else if (isLineSegments(o)) {
      if (o.geometry) geometries.add(o.geometry);
      collectMaterials(o.material, materials);
    }
  });

  // Surfaces, from the manifest side so the index is exactly the contract's view of the asset.
  for (const sid of m.surfacesByAsset.get(assetId) ?? []) {
    const surface = m.surfaces.get(sid);
    if (!surface) continue;
    for (const nr of surface.nodeRefs) {
      if (nr.assetId !== assetId) continue;
      const node = nodes.get(nr.nodeName);
      if (!node) continue;
      index.surfaceNode.set(sid, node);
      index.meshSurfaceId.set(node, sid);
      node.userData.surfaceId = sid;
      index.clipGroupOf.set(sid, clipGroupOf(m, sid));
      if (isMesh(node)) {
        index.surfaceMesh.set(sid, node);
        meshes.push(node);
        const mat = node.material as THREE.MeshStandardMaterial | undefined;
        if (mat?.color) index.originalColor.set(sid, mat.color.getHex());
      }
    }
  }

  for (const [name, node] of nodes) {
    if (m.floors.has(name)) {
      pushTo(index.floorNodes, name, node);
      floorNodeNames.push(name);
    }
    if (m.buildings.has(name)) pushTo(index.buildingNodes, name, node);
    const eid = m.elementByNode.get(nodeKey(assetId, name));
    if (eid) pushTo(index.elementGroups, eid, node);
    if (name === `edges-${assetId}` && isLineSegments(node)) edges = node;
  }

  // Element group nodes that are *not* inside a floor node need an explicit policy.
  for (const [name, node] of nodes) {
    if (!m.elementByNode.has(nodeKey(assetId, name))) continue;
    if (hasFloorAncestor(node, m)) continue;
    floorlessElementNodes.push(name);
  }

  // Static matrices: ~410 fewer per-frame matrix compositions. Explode updates them explicitly.
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
  root.updateMatrixWorld(true);

  const invalidCaps = meshes.filter((mesh) => {
    const sid = index.meshSurfaceId.get(mesh);
    if (!sid || !invalidWallCap(mesh, sid, m)) return false;
    mesh.userData.vhInvalidWallCap = true;
    mesh.visible = false;
    return true;
  });
  if (edges && invalidCaps.length) {
    const cleaned = withoutCapEdges(edges, invalidCaps);
    if (cleaned) {
      edges.geometry = cleaned;
      geometries.add(cleaned);
    }
  }

  const entry: AssetEntry = {
    id: assetId,
    root,
    nodes,
    meshes,
    edges,
    inventory: {
      assetId,
      floorNodes: floorNodeNames,
      floorlessElementNodes,
      edgesNode: edges?.name ?? null,
    },
    disposables: { geometries, materials },
  };
  index.assets.set(assetId, entry);
  return entry;
}

/** Scan references are evidence-only: never picked, so they never enter a ray test. */
export function makeNonPickable(entry: AssetEntry): void {
  entry.root.traverse((o) => {
    o.raycast = () => {};
  });
}

export function inventoryOf(index: SceneIndex): AssetNodeInventory[] {
  return [...index.assets.values()].map((a) => a.inventory);
}

/** Explode group of any indexed node, for the overlay and the label layer. */
export function groupOfNode(index: SceneIndex, assetId: AssetId, nodeName: string): ExplodeGroup {
  return explodeGroupOf(index.manifest, assetId, nodeName) ?? "site";
}

function hasFloorAncestor(node: THREE.Object3D, m: ManifestIndex): boolean {
  let p = node.parent;
  while (p) {
    if (p.name && m.floors.has(p.name)) return true;
    p = p.parent;
  }
  return false;
}

function collectMaterials(
  material: THREE.Material | THREE.Material[] | undefined,
  into: Set<THREE.Material>,
): void {
  if (!material) return;
  if (Array.isArray(material)) for (const m of material) into.add(m);
  else into.add(material);
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}
