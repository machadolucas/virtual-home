/**
 * A minimal GLB reader for the unit tests.
 *
 * Deliberately not `GLTFLoader`: in Node that needs a `fetch`/`FileLoader` shim and it builds a
 * whole three.js scene. All the tests need is the node tree (names + extras), the material
 * `baseColorFactor` and, for the wall-frame test, raw POSITION/NORMAL/index arrays — which is
 * ~80 lines of buffer arithmetic.
 */
import fs from "node:fs";
import path from "node:path";
import { formatZodIssues, safeParseManifest } from "@/house/model/schema";
import type { Manifest } from "@/house/model/types";
import type { AssetNodeInventory } from "@/house/model/visibilityPlan";

export interface GlbNode {
  name?: string;
  extras?: Record<string, unknown>;
  mesh?: number;
  children?: number[];
}

export interface GlbJson {
  scene?: number;
  scenes: Array<{ nodes: number[] }>;
  nodes: GlbNode[];
  meshes?: Array<{
    primitives: Array<{
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
      mode?: number;
    }>;
  }>;
  materials?: Array<{
    pbrMetallicRoughness?: { baseColorFactor?: number[] };
    emissiveFactor?: number[];
    doubleSided?: boolean;
  }>;
  accessors?: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    byteOffset?: number;
  }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number }>;
}

export interface Glb {
  assetId: string;
  json: GlbJson;
  bin: Uint8Array;
}

export function readGlb(file: string): Glb {
  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  let offset = 12;
  let json: GlbJson | null = null;
  let bin = new Uint8Array(0);
  while (offset < buf.byteLength) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    const body = new Uint8Array(buf.buffer, buf.byteOffset + offset + 8, len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GlbJson;
    else if (type === 0x004e4942) bin = body;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(`${file} has no JSON chunk`);
  return { assetId: path.basename(file, ".glb"), json, bin };
}

export function readPackageGlbs(dir: string, assetIds: readonly string[]): Map<string, Glb> {
  const out = new Map<string, Glb>();
  for (const id of assetIds) {
    const file = path.join(dir, "assets", `${id}.glb`);
    if (fs.existsSync(file)) out.set(id, readGlb(file));
  }
  return out;
}

const rootNodes = (g: Glb): GlbNode[] =>
  (g.json.scenes[g.json.scene ?? 0]?.nodes ?? []).map((i) => nodeAt(g, i));

const nodeAt = (g: Glb, i: number): GlbNode => {
  const n = g.json.nodes[i];
  if (!n) throw new Error(`no node ${i} in ${g.assetId}`);
  return n;
};

export function findNode(g: Glb, name: string): GlbNode | null {
  for (const n of g.json.nodes) if (n.name === name) return n;
  return null;
}

export function allNodeNames(g: Glb): string[] {
  return g.json.nodes.map((n) => n.name ?? "");
}

/** Node names that appear anywhere in the tree and carry `extras.floorId`. */
export function floorNodeNames(g: Glb): string[] {
  return g.json.nodes
    .filter((n) => typeof n.extras?.floorId === "string" && n.name === n.extras.floorId)
    .map((n) => n.name as string);
}

/**
 * The nodes a visibility/explode policy has to classify: children of the building (or `site`)
 * node — floor nodes and floor-less element nodes — plus the asset's edges node.
 */
export function inventoryOf(g: Glb): AssetNodeInventory & { containerChildren: string[] } {
  const floorNodes: string[] = [];
  const floorlessElementNodes: string[] = [];
  let edgesNode: string | null = null;
  const containerChildren: string[] = [];

  for (const root of rootNodes(g)) {
    for (const ci of root.children ?? []) {
      const child = nodeAt(g, ci);
      if (child.extras?.kind === "edges") {
        edgesNode = child.name ?? null;
        continue;
      }
      // building or site container
      for (const gi of child.children ?? []) {
        const grand = nodeAt(g, gi);
        const name = grand.name ?? "";
        containerChildren.push(name);
        if (typeof grand.extras?.floorId === "string" && grand.extras.floorId === name)
          floorNodes.push(name);
        else floorlessElementNodes.push(name);
      }
    }
  }
  return { assetId: g.assetId, floorNodes, floorlessElementNodes, edgesNode, containerChildren };
}

/** `assetId/nodeName` keys of every node the explode policy must classify. */
export function policyNodeNames(g: Glb): string[] {
  const inv = inventoryOf(g);
  return [...inv.containerChildren, ...(inv.edgesNode ? [inv.edgesNode] : [])];
}

export function baseColorFactorOf(g: Glb, nodeName: string): number[] | null {
  const node = findNode(g, nodeName);
  if (!node || node.mesh === undefined) return null;
  const prim = g.json.meshes?.[node.mesh]?.primitives[0];
  if (!prim || prim.material === undefined) return null;
  return g.json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorFactor ?? null;
}

export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint16Array | Uint32Array | null;
  mode: number;
}

export function meshArraysOf(g: Glb, nodeName: string): MeshArrays | null {
  const node = findNode(g, nodeName);
  if (!node || node.mesh === undefined) return null;
  const prim = g.json.meshes?.[node.mesh]?.primitives[0];
  if (!prim) return null;
  const pos = prim.attributes.POSITION;
  if (pos === undefined) return null;
  const positions = readAccessor(g, pos) as Float32Array;
  const nrm = prim.attributes.NORMAL;
  return {
    positions,
    normals: nrm === undefined ? null : (readAccessor(g, nrm) as Float32Array),
    indices:
      prim.indices === undefined
        ? null
        : (readAccessor(g, prim.indices) as Uint16Array | Uint32Array),
    mode: prim.mode ?? 4,
  };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(g: Glb, index: number): Float32Array | Uint16Array | Uint32Array {
  const acc = g.json.accessors?.[index];
  if (!acc) throw new Error(`no accessor ${index}`);
  const view = g.json.bufferViews?.[acc.bufferView];
  if (!view) throw new Error(`no bufferView ${acc.bufferView}`);
  const comps = COMPONENTS[acc.type] ?? 1;
  const start = g.bin.byteOffset + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const buffer = g.bin.buffer as ArrayBuffer;
  const count = acc.count * comps;
  switch (acc.componentType) {
    case 5126:
      return new Float32Array(buffer, start, count);
    case 5123:
      return new Uint16Array(buffer, start, count);
    case 5125:
      return new Uint32Array(buffer, start, count);
    default:
      throw new Error(`unsupported componentType ${acc.componentType}`);
  }
}

/** The fixture package directory (generated by `scripts/make-fixture-model.ts`). */
export const FIXTURE_DIR = path.resolve(process.cwd(), "tests/fixtures/model/house-model");

/** The real package, only when the developer opts in. Never referenced by default. */
export const REAL_DIR = process.env.VH_REAL_MODEL_DIR ?? null;

/** Parse a package's `model.json` through the app's own zod mirror. Throws on a schema failure. */
export function loadManifest(dir: string): Manifest {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8")) as unknown;
  const parsed = safeParseManifest(raw);
  if (!parsed.success) throw new Error(formatZodIssues(parsed.error).join("\n"));
  return parsed.data;
}
