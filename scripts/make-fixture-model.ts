/**
 * Generate the synthetic house-model package used by the tests.
 *
 *   pnpm exec tsx scripts/make-fixture-model.ts [--out <dir>]
 *
 * The real package is private and must never enter this repo (CLAUDE.md hard rule 1). The fixture
 * below satisfies the *same* contract (v1.0) and reproduces every structural quirk the viewer has
 * to cope with, so the unit tests exercise the real code paths:
 *
 *   - hierarchy depth varies per asset (root→building→floor→element→surface, and root→building→
 *     element→surface, and root→site→element→surface)
 *   - a floor node (`f-upper`) exists in two assets (`fixture-upper` and `fixture-roof`)
 *   - one element sits outside any floor node, as a sibling of the floor node
 *   - one surface node has **no mesh** and no children (the degenerate-band case)
 *   - one shared wall produces two surfaces, `s-w-l-ab--r-l-a` / `s-w-l-ab--r-l-b`
 *   - one room's `floorElevation` differs from its floor datum (the living-room case)
 *   - one room footprint has a hole, one is concave with a diagonal wall
 *   - room kinds include `closet`; certainty includes `derived`
 *   - `edges-<assetId>` is a LINES primitive, a direct child of the asset root
 *   - every node carries `extras` per the package's picking convention
 *
 * The GLB writer is deliberately minimal and dependency-free: one scene, named nodes with extras,
 * one mesh + one material per surface, indexed triangles with POSITION + NORMAL.
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// minimal GLB writer
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

interface GltfNode {
  name: string;
  extras: Record<string, unknown>;
  mesh?: number;
  children?: number[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_USHORT = 5123;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

class GlbBuilder {
  private readonly nodes: GltfNode[] = [];
  private readonly meshes: unknown[] = [];
  private readonly materials: unknown[] = [];
  private readonly accessors: unknown[] = [];
  private readonly bufferViews: unknown[] = [];
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;

  addNode(node: GltfNode): number {
    this.nodes.push(node);
    return this.nodes.length - 1;
  }

  setChildren(index: number, children: number[]): void {
    const node = this.nodes[index];
    if (!node) throw new Error(`no node ${index}`);
    if (children.length) node.children = children;
  }

  private pushBuffer(data: Uint8Array, target: number): number {
    // 4-byte align every view so accessor offsets stay valid for both float and ushort.
    const pad = (4 - (this.byteLength % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.byteLength += pad;
    }
    const byteOffset = this.byteLength;
    this.chunks.push(data);
    this.byteLength += data.byteLength;
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength, target });
    return this.bufferViews.length - 1;
  }

  private addFloatAccessor(values: number[], type: "VEC3"): number {
    const count = values.length / 3;
    const array = new Float32Array(values);
    const view = this.pushBuffer(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      TARGET_ARRAY_BUFFER,
    );
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = values[i * 3 + k] as number;
        if (v < (min[k] as number)) min[k] = v;
        if (v > (max[k] as number)) max[k] = v;
      }
    }
    this.accessors.push({
      bufferView: view,
      componentType: COMPONENT_FLOAT,
      count,
      type,
      min,
      max,
    });
    return this.accessors.length - 1;
  }

  private addIndexAccessor(indices: number[]): number {
    const array = new Uint16Array(indices);
    const view = this.pushBuffer(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      TARGET_ELEMENT_ARRAY_BUFFER,
    );
    this.accessors.push({
      bufferView: view,
      componentType: COMPONENT_USHORT,
      count: indices.length,
      type: "SCALAR",
      min: [Math.min(...indices)],
      max: [Math.max(...indices)],
    });
    return this.accessors.length - 1;
  }

  addMaterial(name: string, hex: string, emissive = false): number {
    const [r, g, b] = hexToLinear(hex);
    this.materials.push({
      name,
      doubleSided: true,
      alphaMode: "OPAQUE",
      emissiveFactor: emissive ? [r, g, b] : [0, 0, 0],
      pbrMetallicRoughness: {
        baseColorFactor: [r, g, b, 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
    });
    return this.materials.length - 1;
  }

  addTriangleMesh(name: string, positions: number[], normals: number[], indices: number[], material: number): number {
    const pos = this.addFloatAccessor(positions, "VEC3");
    const nor = this.addFloatAccessor(normals, "VEC3");
    const idx = this.addIndexAccessor(indices);
    this.meshes.push({
      name,
      primitives: [{ attributes: { POSITION: pos, NORMAL: nor }, indices: idx, material, mode: 4 }],
    });
    return this.meshes.length - 1;
  }

  addLineMesh(name: string, positions: number[], indices: number[], material: number): number {
    const pos = this.addFloatAccessor(positions, "VEC3");
    const idx = this.addIndexAccessor(indices);
    this.meshes.push({
      name,
      primitives: [{ attributes: { POSITION: pos }, indices: idx, material, mode: 1 }],
    });
    return this.meshes.length - 1;
  }

  build(generator: string, rootNode: number): Uint8Array {
    const bin = concat(this.chunks);
    const gltf = {
      asset: { version: "2.0", generator },
      scene: 0,
      scenes: [{ nodes: [rootNode] }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: bin.byteLength }],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
    const jsonChunk = new Uint8Array(jsonBytes.byteLength + jsonPad);
    jsonChunk.set(jsonBytes);
    jsonChunk.fill(0x20, jsonBytes.byteLength); // JSON chunks pad with spaces

    const binPad = (4 - (bin.byteLength % 4)) % 4;
    const binChunk = new Uint8Array(bin.byteLength + binPad);
    binChunk.set(bin);

    const total = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    let o = 0;
    dv.setUint32(o, 0x46546c67, true); // 'glTF'
    dv.setUint32(o + 4, 2, true);
    dv.setUint32(o + 8, total, true);
    o += 12;
    dv.setUint32(o, jsonChunk.byteLength, true);
    dv.setUint32(o + 4, 0x4e4f534a, true); // 'JSON'
    out.set(jsonChunk, o + 8);
    o += 8 + jsonChunk.byteLength;
    dv.setUint32(o, binChunk.byteLength, true);
    dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
    out.set(binChunk, o + 8);
    return out;
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

function hexToLinear(hex: string): Vec3 {
  const chan = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [chan(0), chan(1), chan(2)];
}

// ---------------------------------------------------------------------------
// geometry helpers (planar quads, CCW when seen from the +normal side)
// ---------------------------------------------------------------------------

interface Quad {
  positions: number[];
  normals: number[];
  indices: number[];
}

function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): Quad {
  const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v: Vec3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
  let n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  n = [n[0] / len, n[1] / len, n[2] / len];
  return {
    positions: [...a, ...b, ...c, ...d],
    normals: [...n, ...n, ...n, ...n],
    indices: [0, 1, 2, 0, 2, 3],
  };
}

/** Vertical quad along the XZ segment (x0,z0)→(x1,z1), from y0 to y1. */
function wallQuad(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number): Quad {
  return quad([x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]);
}

/** Horizontal quad at height y over the rectangle [x0..x1] × [z0..z1]. `up` picks the normal. */
function slabQuad(x0: number, z0: number, x1: number, z1: number, y: number, up: boolean): Quad {
  return up
    ? quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0])
    : quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]);
}

/** Axis-aligned box outline as LINES, appended into a shared position/index buffer. */
function boxEdges(box: { min: Vec3; max: Vec3 }, positions: number[], indices: number[]): void {
  const base = positions.length / 3;
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const corners: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  for (const c of corners) positions.push(...c);
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  for (const [a, b] of pairs) indices.push(base + (a as number), base + (b as number));
}

// ---------------------------------------------------------------------------
// the fixture model
// ---------------------------------------------------------------------------

type SurfaceKind = "floor" | "wall" | "ceiling" | "other";

interface SurfaceSpec {
  id: string;
  kind: SurfaceKind;
  roomId?: string;
  role?: string;
  color: string;
  /** `undefined` = an intentionally mesh-less node (no mesh, no children). */
  geometry?: Quad;
}

interface ElementSpec {
  id: string;
  kind: string;
  floorId?: string;
  roomIds?: string[];
  wallId?: string;
  certainty: "measured" | "derived" | "inferred" | "unknown";
  properties?: Record<string, unknown>;
  note?: string;
  surfaces: SurfaceSpec[];
}

interface AssetSpec {
  id: string;
  kind: "shell" | "terrain" | "detail" | "scan-reference";
  loadByDefault: boolean;
  buildingId?: string;
  floorId?: string;
  hasEdges: boolean;
  /** Elements under `<building>/<floorId>/…`, keyed by floor node name. */
  byFloor: Record<string, ElementSpec[]>;
  /** Elements directly under the building (or `site`) node — outside any floor node. */
  floorless: ElementSpec[];
  /** `site` instead of a building node (the terrain case). */
  siteNode?: boolean;
}

const B = "b-fx";
const F_LOWER = "f-lower";
const F_UPPER = "f-upper";

const WALL_TOP_LOWER = 2.5;

const lowerElements: ElementSpec[] = [
  {
    id: "e-l-ext",
    kind: "exterior-wall",
    floorId: F_LOWER,
    certainty: "measured",
    properties: { thickness: 0.2, material: "brick leaf + timber frame" },
    surfaces: [
      {
        id: "s-e-l-ext--r-l-a",
        kind: "wall",
        roomId: "r-l-a",
        color: "#d9c3a5",
        geometry: wallQuad(0.2, 3.8, 0.2, 0.2, 0, WALL_TOP_LOWER),
      },
      {
        id: "s-e-l-ext--r-l-b",
        kind: "wall",
        roomId: "r-l-b",
        color: "#bfd8e6",
        geometry: wallQuad(3.1, 0.2, 4.6, 0.2, -0.2, WALL_TOP_LOWER),
      },
      {
        id: "s-e-l-ext--r-l-closet",
        kind: "wall",
        roomId: "r-l-closet",
        color: "#e8dcc4",
        geometry: wallQuad(5.8, 0.2, 5.8, 3.8, 0, 2.2),
      },
      {
        id: "s-e-l-ext-out",
        kind: "wall",
        role: "exterior",
        color: "#c8b48f",
        geometry: wallQuad(0, 0, 0, 4, 0, WALL_TOP_LOWER),
      },
      // Intentionally mesh-less: a degenerate timber band. `nodes.get(name)` returns an
      // Object3D with no `.material`, which every colour/highlight/visibility path must tolerate.
      { id: "s-e-l-ext-out-band", kind: "wall", role: "exterior", color: "#b39a72" },
    ],
  },
  {
    id: "e-w-l-ab",
    kind: "wall",
    floorId: F_LOWER,
    roomIds: ["r-l-a", "r-l-b"],
    certainty: "measured",
    properties: { thickness: 0.1 },
    note: "the shared wall: one physical wall, two independently colourable faces",
    surfaces: [
      {
        id: "s-w-l-ab--r-l-a",
        kind: "wall",
        roomId: "r-l-a",
        color: "#d9c3a5",
        geometry: wallQuad(3.0, 0.2, 3.0, 3.8, 0, WALL_TOP_LOWER),
      },
      {
        id: "s-w-l-ab--r-l-b",
        kind: "wall",
        roomId: "r-l-b",
        color: "#bfd8e6",
        geometry: wallQuad(3.1, 3.8, 3.1, 0.2, -0.2, WALL_TOP_LOWER),
      },
    ],
  },
  {
    id: "e-w-l-bc",
    kind: "wall",
    floorId: F_LOWER,
    roomIds: ["r-l-b", "r-l-closet"],
    certainty: "derived",
    surfaces: [
      {
        id: "s-w-l-bc--r-l-b",
        kind: "wall",
        roomId: "r-l-b",
        color: "#bfd8e6",
        geometry: wallQuad(4.6, 0.2, 4.6, 3.8, -0.2, WALL_TOP_LOWER),
      },
      {
        id: "s-w-l-bc--r-l-closet",
        kind: "wall",
        roomId: "r-l-closet",
        color: "#e8dcc4",
        geometry: wallQuad(4.7, 3.8, 4.7, 0.2, 0, 2.2),
      },
    ],
  },
  {
    id: "e-f-lower-slab",
    kind: "floor",
    floorId: F_LOWER,
    certainty: "measured",
    surfaces: [
      {
        id: "s-r-l-a-floor",
        kind: "floor",
        roomId: "r-l-a",
        color: "#8a7a63",
        geometry: slabQuad(0.2, 0.2, 3.0, 3.8, 0, true),
      },
      {
        id: "s-r-l-b-floor",
        kind: "floor",
        roomId: "r-l-b",
        color: "#7f8f9a",
        geometry: slabQuad(3.1, 0.2, 4.6, 3.8, -0.2, true),
      },
      {
        id: "s-r-l-closet-floor",
        kind: "floor",
        roomId: "r-l-closet",
        color: "#94856c",
        geometry: slabQuad(4.7, 0.2, 5.8, 3.8, 0, true),
      },
    ],
  },
  {
    id: "e-f-lower-ceiling",
    kind: "ceiling",
    floorId: F_LOWER,
    certainty: "inferred",
    surfaces: [
      {
        id: "s-r-l-a-ceiling",
        kind: "ceiling",
        roomId: "r-l-a",
        color: "#f2ece0",
        geometry: slabQuad(0.2, 0.2, 3.0, 3.8, 2.5, false),
      },
      {
        id: "s-r-l-b-ceiling",
        kind: "ceiling",
        roomId: "r-l-b",
        color: "#eef2f4",
        geometry: slabQuad(3.1, 0.2, 4.6, 3.8, 2.5, false),
      },
      {
        id: "s-r-l-closet-ceiling",
        kind: "ceiling",
        roomId: "r-l-closet",
        color: "#f4efe4",
        geometry: slabQuad(4.7, 0.2, 5.8, 3.8, 2.2, false),
      },
    ],
  },
  {
    id: "e-o-l-door",
    kind: "door",
    floorId: F_LOWER,
    wallId: "e-w-l-ab",
    certainty: "measured",
    properties: { width: 0.9, sill: 0, head: 2.04, wallId: "e-w-l-ab", glazed: false, leaves: 1 },
    surfaces: [
      {
        id: "s-o-l-door-reveal",
        kind: "other",
        role: "reveal",
        color: "#e6e2d8",
        geometry: wallQuad(3.0, 1.4, 3.1, 1.4, 0, 2.04),
      },
      {
        id: "s-o-l-door-leaf",
        kind: "other",
        role: "door-leaf",
        color: "#cfc4ae",
        geometry: wallQuad(3.04, 1.4, 3.04, 2.3, 0, 2.04),
      },
    ],
  },
];

/** Outside any floor node: a sibling of `f-lower` under the building node. */
const lowerFloorless: ElementSpec[] = [
  {
    id: "e-l-step",
    kind: "step",
    certainty: "inferred",
    note: "outdoor entrance step; deliberately a sibling of the floor node",
    surfaces: [
      {
        id: "s-e-l-step",
        kind: "other",
        role: "step",
        color: "#9a9a95",
        geometry: slabQuad(6.0, 1.2, 6.6, 2.2, -0.1, true),
      },
    ],
  },
];

const upperElements: ElementSpec[] = [
  {
    id: "e-f-upper-ext",
    kind: "exterior-wall",
    floorId: F_UPPER,
    certainty: "measured",
    properties: { thickness: 0.2 },
    surfaces: [
      {
        id: "s-e-f-upper-ext--r-u-a",
        kind: "wall",
        roomId: "r-u-a",
        color: "#dfd7c6",
        geometry: wallQuad(0.2, 0.2, 5.8, 0.2, 2.7, 5.0),
      },
      {
        id: "s-e-f-upper-ext-out",
        kind: "wall",
        role: "exterior",
        color: "#c8b48f",
        geometry: wallQuad(6.0, 0, 0, 0, 2.7, 5.0),
      },
    ],
  },
  {
    id: "e-w-u-diag",
    kind: "wall",
    floorId: F_UPPER,
    roomIds: ["r-u-a"],
    certainty: "derived",
    note: "non-axis-aligned wall: an AABB would overstate its extents by ~1 m",
    surfaces: [
      {
        id: "s-w-u-diag--r-u-a",
        kind: "wall",
        roomId: "r-u-a",
        color: "#dfd7c6",
        geometry: wallQuad(5.8, 3.0, 4.0, 3.8, 2.7, 5.0),
      },
    ],
  },
  {
    id: "e-f-upper-slab",
    kind: "floor",
    floorId: F_UPPER,
    certainty: "measured",
    surfaces: [
      {
        id: "s-r-u-a-floor",
        kind: "floor",
        roomId: "r-u-a",
        color: "#8f8069",
        geometry: slabQuad(0.2, 0.2, 5.8, 3.8, 2.7, true),
      },
    ],
  },
  {
    id: "e-f-upper-ceiling",
    kind: "ceiling",
    floorId: F_UPPER,
    certainty: "inferred",
    surfaces: [
      {
        id: "s-r-u-a-ceiling",
        kind: "ceiling",
        roomId: "r-u-a",
        color: "#f2ece0",
        geometry: slabQuad(0.2, 0.2, 5.8, 3.8, 5.0, false),
      },
    ],
  },
  {
    id: "e-o-u-win",
    kind: "window",
    floorId: F_UPPER,
    wallId: "e-f-upper-ext",
    certainty: "measured",
    properties: { width: 1.2, sill: 1.0, head: 2.14, wallId: "e-f-upper-ext" },
    surfaces: [
      {
        id: "s-o-u-win-reveal",
        kind: "other",
        role: "reveal",
        color: "#e6e2d8",
        geometry: wallQuad(2.0, 0.2, 3.2, 0.2, 3.7, 4.84),
      },
    ],
  },
];

const roofFloorless: ElementSpec[] = [
  {
    id: "e-roof-fx",
    kind: "roof",
    certainty: "inferred",
    surfaces: [
      {
        id: "s-e-roof-fx-north",
        kind: "other",
        role: "roof",
        color: "#5b5b58",
        geometry: quad([-0.3, 5.0, -0.3], [6.3, 5.0, -0.3], [6.3, 6.2, 2.0], [-0.3, 6.2, 2.0]),
      },
      {
        id: "s-e-roof-fx-south",
        kind: "other",
        role: "roof",
        color: "#54544f",
        geometry: quad([-0.3, 6.2, 2.0], [6.3, 6.2, 2.0], [6.3, 5.0, 4.3], [-0.3, 5.0, 4.3]),
      },
    ],
  },
];

/** Under `f-upper` **in the roof asset** — the dormer follows the floor, not the roof toggle. */
const roofUpperElements: ElementSpec[] = [
  {
    id: "e-dormer-fx",
    kind: "dormer",
    floorId: F_UPPER,
    roomIds: ["r-u-a"],
    certainty: "inferred",
    surfaces: [
      {
        id: "s-e-dormer-fx-wall",
        kind: "wall",
        roomId: "r-u-a",
        role: "dormer-front-wall",
        color: "#dfd7c6",
        geometry: wallQuad(1.4, 4.4, 2.6, 4.4, 4.2, 5.6),
      },
      {
        id: "s-e-dormer-fx-ceiling",
        kind: "ceiling",
        roomId: "r-u-a",
        role: "dormer-ceiling",
        color: "#f2ece0",
        geometry: slabQuad(1.4, 3.8, 2.6, 4.4, 5.6, false),
      },
    ],
  },
];

const terrainFloorless: ElementSpec[] = [
  {
    id: "e-terrain-fx",
    kind: "terrain",
    certainty: "inferred",
    surfaces: [
      {
        id: "s-e-terrain-fx",
        kind: "other",
        role: "ground",
        color: "#7f8a6a",
        geometry: slabQuad(-4, -4, 10, 8, -0.4, true),
      },
    ],
  },
];

const scanElements: ElementSpec[] = [
  {
    id: "e-scan-fx",
    kind: "scan-reference",
    floorId: F_LOWER,
    certainty: "measured",
    surfaces: [
      {
        id: "s-e-scan-fx",
        kind: "other",
        role: "scan",
        color: "#9aa0a6",
        geometry: slabQuad(0.2, 0.2, 5.8, 3.8, 0.01, true),
      },
    ],
  },
];

const ASSETS: AssetSpec[] = [
  {
    id: "fixture-lower",
    kind: "shell",
    loadByDefault: true,
    buildingId: B,
    floorId: F_LOWER,
    hasEdges: true,
    byFloor: { [F_LOWER]: lowerElements },
    floorless: lowerFloorless,
  },
  {
    id: "fixture-upper",
    kind: "shell",
    loadByDefault: true,
    buildingId: B,
    floorId: F_UPPER,
    hasEdges: true,
    byFloor: { [F_UPPER]: upperElements },
    floorless: [],
  },
  {
    id: "fixture-roof",
    kind: "shell",
    loadByDefault: true,
    buildingId: B,
    hasEdges: true,
    byFloor: { [F_UPPER]: roofUpperElements },
    floorless: roofFloorless,
  },
  {
    id: "fixture-terrain",
    kind: "terrain",
    loadByDefault: true,
    hasEdges: true,
    siteNode: true,
    byFloor: {},
    floorless: terrainFloorless,
  },
  {
    id: "fixture-scan",
    kind: "scan-reference",
    loadByDefault: false,
    buildingId: B,
    floorId: F_LOWER,
    hasEdges: false,
    byFloor: { [F_LOWER]: scanElements },
    floorless: [],
  },
];

// ---------------------------------------------------------------------------
// asset writing
// ---------------------------------------------------------------------------

interface AssetBuildResult {
  bytes: Uint8Array;
  bounds: { min: Vec3; max: Vec3 };
  triangles: number;
  surfaces: number;
  materials: number;
  edgeSegments: number;
}

function buildAsset(spec: AssetSpec): AssetBuildResult {
  const b = new GlbBuilder();
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let surfaces = 0;

  const expand = (positions: readonly number[]) => {
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k] as number;
        if (v < (min[k] as number)) min[k] = v;
        if (v > (max[k] as number)) max[k] = v;
      }
    }
  };

  const surfaceNode = (s: SurfaceSpec, el: ElementSpec): number => {
    surfaces++;
    const extras: Record<string, unknown> = { surfaceId: s.id, kind: s.kind, elementId: el.id };
    if (s.roomId) extras.roomId = s.roomId;
    if (el.floorId) extras.floorId = el.floorId;
    if (spec.buildingId) extras.buildingId = spec.buildingId;
    if (s.role) extras.role = s.role;
    if (s.geometry) {
      const mat = b.addMaterial(`m-${s.id}`, s.color);
      const mesh = b.addTriangleMesh(
        `mesh-${s.id}`,
        s.geometry.positions,
        s.geometry.normals,
        s.geometry.indices,
        mat,
      );
      triangles += s.geometry.indices.length / 3;
      expand(s.geometry.positions);
      return b.addNode({ name: s.id, extras, mesh });
    }
    return b.addNode({ name: s.id, extras });
  };

  const elementNode = (el: ElementSpec): number => {
    const children = el.surfaces.map((s) => surfaceNode(s, el));
    const extras: Record<string, unknown> = { elementId: el.id, kind: el.kind };
    const node = b.addNode({ name: el.id, extras });
    b.setChildren(node, children);
    return node;
  };

  const containerChildren: number[] = [];
  for (const [floorName, elements] of Object.entries(spec.byFloor)) {
    const kids = elements.map(elementNode);
    const floorNode = b.addNode({ name: floorName, extras: { floorId: floorName } });
    b.setChildren(floorNode, kids);
    containerChildren.push(floorNode);
  }
  for (const el of spec.floorless) containerChildren.push(elementNode(el));

  const container = b.addNode({
    name: spec.siteNode ? "site" : (spec.buildingId ?? "site"),
    extras: spec.siteNode ? {} : { buildingId: spec.buildingId },
  });
  b.setChildren(container, containerChildren);

  const rootChildren = [container];
  let edgeSegments = 0;
  if (spec.hasEdges) {
    const positions: number[] = [];
    const indices: number[] = [];
    boxEdges({ min: [...min] as Vec3, max: [...max] as Vec3 }, positions, indices);
    // A couple of interior lines so the overlay is not just the bounding box.
    boxEdges(
      {
        min: [(min[0] + max[0]) / 2 - 0.2, min[1] as number, (min[2] + max[2]) / 2 - 0.2] as Vec3,
        max: [(min[0] + max[0]) / 2 + 0.2, max[1] as number, (min[2] + max[2]) / 2 + 0.2] as Vec3,
      },
      positions,
      indices,
    );
    edgeSegments = indices.length / 2;
    const mat = b.addMaterial("m-edges", "#232323", true);
    const mesh = b.addLineMesh(`mesh-edges-${spec.id}`, positions, indices, mat);
    rootChildren.push(
      b.addNode({
        name: `edges-${spec.id}`,
        extras: { kind: "edges", role: "architectural-edges" },
        mesh,
      }),
    );
  }

  const root = b.addNode({ name: spec.id, extras: { assetId: spec.id } });
  b.setChildren(root, rootChildren);

  return {
    bytes: b.build("virtual-home make-fixture-model.ts", root),
    bounds: { min: [...min] as Vec3, max: [...max] as Vec3 },
    triangles,
    surfaces,
    materials: 0,
    edgeSegments,
  };
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function buildManifest(built: Map<string, AssetBuildResult>): Record<string, unknown> {
  const surfaces: Array<Record<string, unknown>> = [];
  const elements: Array<Record<string, unknown>> = [];

  for (const spec of ASSETS) {
    const all = [...Object.values(spec.byFloor).flat(), ...spec.floorless];
    for (const el of all) {
      elements.push({
        id: el.id,
        kind: el.kind,
        certainty: el.certainty,
        nodeRefs: [
          { assetId: spec.id, nodeName: el.id },
          ...el.surfaces.map((s) => ({ assetId: spec.id, nodeName: s.id })),
        ],
        surfaceIds: el.surfaces.map((s) => s.id),
        ...(spec.buildingId ? { buildingId: spec.buildingId } : {}),
        ...(el.floorId ? { floorId: el.floorId } : {}),
        ...(el.roomIds ? { roomIds: el.roomIds } : {}),
        ...(el.wallId ? { wallId: el.wallId } : {}),
        ...(el.properties ? { properties: el.properties } : {}),
        ...(el.note ? { note: el.note } : {}),
      });
      for (const s of el.surfaces) {
        surfaces.push({
          id: s.id,
          kind: s.kind,
          nodeRefs: [{ assetId: spec.id, nodeName: s.id }],
          defaultColor: s.color,
          ...(s.roomId ? { roomId: s.roomId } : {}),
          elementId: el.id,
          ...(s.role ? { role: s.role } : {}),
        });
      }
    }
  }

  const roomSurfaceIds = (roomId: string): string[] =>
    surfaces
      .filter(
        (s) =>
          s.roomId === roomId && (s.kind === "floor" || s.kind === "wall" || s.kind === "ceiling"),
      )
      .map((s) => s.id as string);

  const rooms = [
    {
      id: "r-l-a",
      floorId: F_LOWER,
      buildingId: B,
      name: "Room A",
      nameFi: "HUONE A",
      aliases: ["A"],
      kind: "room",
      note: "footprint has a hole (the flue) so point-in-ring with holes is exercised",
      floorElevation: 0,
      ceilingHeight: 2.5,
      certainty: "measured",
      area: 9.72,
      color: "#d9c3a5",
      footprint: {
        outer: [
          [0.2, 0.2],
          [3.0, 0.2],
          [3.0, 3.8],
          [0.2, 3.8],
        ],
        holes: [
          [
            [1.0, 1.0],
            [1.6, 1.0],
            [1.6, 1.6],
            [1.0, 1.6],
          ],
        ],
      },
      surfaceIds: roomSurfaceIds("r-l-a"),
    },
    {
      id: "r-l-b",
      floorId: F_LOWER,
      buildingId: B,
      name: "Room B",
      nameFi: "HUONE B",
      aliases: [],
      kind: "room",
      note: "floor sits 0.20 m below the floor datum, like the real package's living room",
      floorElevation: -0.2,
      ceilingHeight: 2.7,
      certainty: "measured",
      area: 5.4,
      color: "#bfd8e6",
      footprint: {
        outer: [
          [3.1, 0.2],
          [4.6, 0.2],
          [4.6, 3.8],
          [3.1, 3.8],
        ],
        holes: [],
      },
      surfaceIds: roomSurfaceIds("r-l-b"),
    },
    {
      id: "r-l-closet",
      floorId: F_LOWER,
      buildingId: B,
      name: "Entrance closet",
      nameFi: "VH",
      aliases: [],
      kind: "closet",
      floorElevation: 0,
      ceilingHeight: 2.2,
      certainty: "derived",
      area: 3.96,
      color: "#e8dcc4",
      footprint: {
        outer: [
          [4.7, 0.2],
          [5.8, 0.2],
          [5.8, 3.8],
          [4.7, 3.8],
        ],
        holes: [],
      },
      surfaceIds: roomSurfaceIds("r-l-closet"),
    },
    {
      id: "r-u-a",
      floorId: F_UPPER,
      buildingId: B,
      name: "Upper room",
      nameFi: "YLÄKERTA",
      aliases: [],
      kind: "room",
      note: "concave: the diagonal wall makes the area centroid a poor label anchor",
      floorElevation: 2.7,
      ceilingHeight: 2.3,
      certainty: "inferred",
      area: 18.4,
      color: "#dfd7c6",
      footprint: {
        outer: [
          [0.2, 0.2],
          [5.8, 0.2],
          [5.8, 3.0],
          [4.0, 3.8],
          [0.2, 3.8],
        ],
        holes: [],
      },
      surfaceIds: roomSurfaceIds("r-u-a"),
    },
  ];

  const assets = ASSETS.map((spec) => {
    const b = built.get(spec.id);
    if (!b) throw new Error(`asset ${spec.id} was not built`);
    return {
      id: spec.id,
      path: `assets/${spec.id}.glb`,
      kind: spec.kind,
      loadByDefault: spec.loadByDefault,
      edgesNode: spec.hasEdges ? `edges-${spec.id}` : null,
      stats: {
        triangles: b.triangles,
        surfaces: b.surfaces,
        bytes: b.bytes.byteLength,
        edgeSegments: b.edgeSegments,
      },
      ...(spec.buildingId ? { buildingId: spec.buildingId } : {}),
      ...(spec.floorId ? { floorId: spec.floorId } : {}),
      bounds: {
        min: b.bounds.min.map(round3) as Vec3,
        max: b.bounds.max.map(round3) as Vec3,
      },
    };
  });

  return {
    schemaVersion: "1.0",
    modelId: "fixture-house",
    name: "Fixture house",
    generated: "2026-01-01T00:00:00",
    generator: "virtual-home scripts/make-fixture-model.ts",
    coordinateSystem: {
      units: "m",
      upAxis: "Y",
      handedness: "right",
      originDescription:
        "Outer north-west corner of the fixture house at lower-floor level. X = plan-east, Z = plan-south, Y up.",
      siteElevationOffset: 100,
      north: {
        bearingDeg: 12.5,
        certainty: "inferred",
        description: "synthetic value; true north measured clockwise from -Z towards +X",
      },
      floorDatums: { [F_LOWER]: 0, "r-l-b": -0.2, [F_UPPER]: 2.7 },
    },
    bounds: { min: [-4, -1, -4], max: [10, 7, 8], note: "all fixture assets" },
    buildings: [
      {
        id: B,
        name: "Fixture house",
        placementStatus: "verified",
        floorIds: [F_LOWER, F_UPPER],
        assetIds: ["fixture-lower", "fixture-upper", "fixture-roof", "fixture-scan"],
      },
    ],
    floors: [
      {
        id: F_LOWER,
        buildingId: B,
        name: "Lower floor",
        nameFi: "1. kerros",
        elevation: 0,
        assetIds: ["fixture-lower"],
        scanAssetIds: ["fixture-scan"],
        roomIds: ["r-l-a", "r-l-b", "r-l-closet"],
      },
      {
        id: F_UPPER,
        buildingId: B,
        name: "Upper floor",
        nameFi: "2. kerros",
        elevation: 2.7,
        assetIds: ["fixture-upper"],
        scanAssetIds: [],
        roomIds: ["r-u-a"],
      },
    ],
    rooms,
    assets,
    elements,
    surfaces,
    sources: [
      {
        id: "src-fx-01",
        label: "fixture generator",
        description: "scripts/make-fixture-model.ts — synthetic, no household data",
        includedInPackage: true,
      },
    ],
    issues: [
      {
        id: "iss-fx-01",
        severity: "medium",
        description: "Fixture geometry is synthetic; dimensions are illustrative only.",
        affects: [B],
      },
      {
        id: "iss-fx-02",
        severity: "info",
        description: "Room B's floor level is set 0.20 m below the floor datum on purpose.",
        affects: ["r-l-b"],
      },
    ],
    conventions: {
      picking:
        "Pick a mesh node and read extras.surfaceId / extras.elementId / extras.roomId; parent nodes carry elementId, floorId, buildingId.",
      coloring:
        "Each surface node has its own material; set baseColorFactor of that node's material at runtime.",
      visibility:
        "Hide by asset, by floor node (name = floorId) or by element node (name = elementId). Edges are a separate node 'edges-<assetId>'.",
      certainty:
        "measured = printed dimension; derived = computed from measured values; inferred = typical value; unknown = no evidence",
    },
  };
}

/**
 * A reduced JSON Schema for the fixture. The app validates with `src/house/model/schema.ts`
 * (zod); this file exists so the fixture has the same file set — and therefore the same
 * fingerprint inputs — as a real package.
 */
const FIXTURE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://virtual-home.test/fixture-house/manifest.schema.json",
  title: "House model package manifest (shared model-package contract v1.0) — fixture subset",
  type: "object",
  additionalProperties: true,
  required: [
    "schemaVersion",
    "modelId",
    "coordinateSystem",
    "bounds",
    "buildings",
    "floors",
    "rooms",
    "assets",
    "elements",
    "surfaces",
    "sources",
    "issues",
  ],
  properties: {
    schemaVersion: { const: "1.0" },
    modelId: { $ref: "#/$defs/id" },
  },
  $defs: {
    id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
    color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
    certainty: { enum: ["measured", "derived", "inferred", "unknown"] },
    vec2: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } },
    vec3: { type: "array", minItems: 3, maxItems: 3, items: { type: "number" } },
    ring: { type: "array", minItems: 3, items: { $ref: "#/$defs/vec2" } },
    nodeRef: {
      type: "object",
      required: ["assetId", "nodeName"],
      properties: { assetId: { $ref: "#/$defs/id" }, nodeName: { type: "string", minLength: 1 } },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main(): void {
  const argOut = process.argv.indexOf("--out");
  const outDir =
    argOut >= 0 && process.argv[argOut + 1]
      ? path.resolve(process.argv[argOut + 1] as string)
      : path.resolve(process.cwd(), "tests/fixtures/model/house-model");

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });

  const built = new Map<string, AssetBuildResult>();
  for (const spec of ASSETS) {
    const result = buildAsset(spec);
    built.set(spec.id, result);
    fs.writeFileSync(path.join(outDir, "assets", `${spec.id}.glb`), result.bytes);
  }

  const manifest = buildManifest(built);
  fs.writeFileSync(path.join(outDir, "model.json"), JSON.stringify(manifest, null, 1) + "\n");
  fs.writeFileSync(
    path.join(outDir, "manifest.schema.json"),
    JSON.stringify(FIXTURE_SCHEMA, null, 2) + "\n",
  );

  let total = 0;
  for (const f of fs.readdirSync(path.join(outDir, "assets")))
    total += fs.statSync(path.join(outDir, "assets", f)).size;
  total += fs.statSync(path.join(outDir, "model.json")).size;
  total += fs.statSync(path.join(outDir, "manifest.schema.json")).size;

  const surfaces = (manifest.surfaces as unknown[]).length;
  console.log(
    `wrote ${outDir}: ${ASSETS.length} assets, ${surfaces} surfaces, ${(total / 1024).toFixed(1)} kB total`,
  );
  if (total > 200 * 1024) {
    console.error("fixture exceeds the 200 kB budget");
    process.exit(1);
  }
}

main();
