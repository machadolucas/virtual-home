/**
 * Tiered, abortable, per-asset-isolated GLB loading.
 *
 * Deliberately **not** `useLoader` / `useGLTF`: both cache globally by URL, so after the workspace
 * unmounts drei's cache would still hold ~400 geometries alive until `useGLTF.clear()` is called
 * by hand, and Suspense-based loading makes per-asset error isolation and abort awkward.
 * Imperative `loadAsync` in an effect gives abort, per-asset failure, deterministic disposal and
 * tier ordering.
 *
 * No DRACO / meshopt / KTX2 decoder is installed: the GLBs are plain, uncompressed, indexed
 * POSITION + NORMAL, so a decoder would add a WASM download and a worker for no benefit.
 */
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type * as THREE from "three";
import type { ManifestIndex } from "@/house/model/manifestIndex";
import type { Asset, AssetId } from "@/house/model/types";
import { disposeRoot } from "./dispose";

export type TierName = "shell" | "site" | "structure" | "scan";

export interface Tier {
  name: TierName;
  assets: Asset[];
  /** Tier 0 blocks `interactive`; later tiers arrive during `enriching`. */
  blocksInteractive: boolean;
}

/** Structural element kinds; a `detail` asset made only of these belongs to the structure tier. */
const STRUCTURAL_KINDS = new Set([
  "truss",
  "beam",
  "footing",
  "slab",
  "slab-edge",
  "frame",
  "concrete",
]);

function isStructureAsset(index: ManifestIndex, asset: Asset): boolean {
  if (asset.kind !== "detail") return false;
  const kinds = new Set<string>();
  for (const e of index.manifest.elements)
    if (e.nodeRefs[0]?.assetId === asset.id) kinds.add(e.kind);
  return kinds.size > 0 && [...kinds].every((k) => STRUCTURAL_KINDS.has(k));
}

/**
 * Priority tiers.
 *
 * `loadByDefault` is honoured as the package's statement of *which* assets are part of the default
 * set; the split into tiers is a client-side **scheduling** decision so the shell can go
 * interactive before the heavy structure geometry arrives. Documented in `docs/model-contract.md`.
 */
export function planTiers(
  index: ManifestIndex,
  opts: { structureLayer?: boolean; phone?: boolean } = {},
): Tier[] {
  const shell: Asset[] = [];
  const site: Asset[] = [];
  const structure: Asset[] = [];
  const scan: Asset[] = [];

  for (const asset of index.manifest.assets) {
    if (asset.kind === "scan-reference") {
      scan.push(asset);
      continue;
    }
    if (asset.kind === "terrain") {
      site.push(asset);
      continue;
    }
    if (isStructureAsset(index, asset)) {
      structure.push(asset);
      continue;
    }
    shell.push(asset);
  }

  const tiers: Tier[] = [
    { name: "shell", assets: shell.filter((a) => a.loadByDefault), blocksInteractive: true },
    { name: "site", assets: site.filter((a) => a.loadByDefault), blocksInteractive: false },
  ];
  // Structure is 1.5 MB of trusses and footings behind a layer that is off by default; on a phone
  // it is not loaded at all.
  if (!opts.phone && opts.structureLayer)
    tiers.push({ name: "structure", assets: structure, blocksInteractive: false });
  // Scan references are `loadByDefault: false`: explicit opt-in only.
  void scan;
  return tiers;
}

export function scanTier(index: ManifestIndex): Tier {
  return {
    name: "scan",
    assets: index.manifest.assets.filter((a) => a.kind === "scan-reference"),
    blocksInteractive: false,
  };
}

export function structureTier(index: ManifestIndex): Tier {
  return {
    name: "structure",
    assets: index.manifest.assets.filter((a) => isStructureAsset(index, a)),
    blocksInteractive: false,
  };
}

export interface LoadCallbacks {
  onAsset: (assetId: AssetId, root: THREE.Group) => void;
  onFail: (assetId: AssetId, error: unknown) => void;
  onProgress?: (assetId: AssetId, loaded: number, total: number) => void;
}

export interface LoadContext {
  /** `/api/house-model/<modelId>` */
  base: string;
  fingerprint: string;
  signal: AbortSignal;
  /** Monotonic token: an `onAsset` for a stale token disposes instead of inserting. */
  token: number;
  currentToken: () => number;
}

export const assetUrl = (base: string, assetId: AssetId, fingerprint: string): string =>
  `${base}/assets/${encodeURIComponent(assetId)}?v=${encodeURIComponent(fingerprint)}`;

export const manifestUrl = (base: string, fingerprint: string): string =>
  `${base}/manifest?v=${encodeURIComponent(fingerprint)}`;

export const statusUrl = (base: string): string => `${base}/status`;

/**
 * Load one tier. `Promise.allSettled`, never `Promise.all`: one failed asset must degrade the
 * workspace, not fail it.
 */
export async function loadTier(
  tier: Tier,
  ctx: LoadContext,
  cb: LoadCallbacks,
): Promise<{ loaded: AssetId[]; failed: AssetId[] }> {
  const loader = new GLTFLoader();
  const loaded: AssetId[] = [];
  const failed: AssetId[] = [];

  const results = await Promise.allSettled(
    tier.assets.map(async (asset) => {
      const url = assetUrl(ctx.base, asset.id, ctx.fingerprint);
      const gltf = await loader.loadAsync(url, (event) => {
        if (event.lengthComputable) cb.onProgress?.(asset.id, event.loaded, event.total);
      });
      const root = gltf.scene as THREE.Group;
      // React 19 StrictMode double-mounts the load effect: anything that arrives for a stale
      // token, or after an abort, is disposed instead of inserted.
      if (ctx.signal.aborted || ctx.currentToken() !== ctx.token) {
        disposeRoot(root);
        return;
      }
      cb.onAsset(asset.id, root);
    }),
  );

  results.forEach((result, i) => {
    const asset = tier.assets[i];
    if (!asset) return;
    if (result.status === "rejected") {
      failed.push(asset.id);
      cb.onFail(asset.id, result.reason);
    } else {
      loaded.push(asset.id);
    }
  });

  return { loaded, failed };
}

export interface StatusResponse {
  installed: boolean;
  modelId: string | null;
  fingerprint: string | null;
  generated: string | null;
  schemaVersion: string | null;
  name: string | null;
  assets: Array<{
    id: string;
    path: string;
    kind: string;
    loadByDefault: boolean;
    present: boolean;
    bytes: number | null;
    sha256?: string;
  }>;
  diagnostics: Array<{ severity: string; code: string; message: string; ids?: string[] }>;
  issues: Array<{ id: string; severity: string; description: string; affects: string[] }>;
}

/** The discovery hop. `no-store`: this is what hands us the current fingerprint. */
export async function fetchStatus(base: string, signal?: AbortSignal): Promise<StatusResponse> {
  const res = await fetch(statusUrl(base), { cache: "no-store", credentials: "same-origin", signal });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as StatusResponse;
}

export async function fetchManifestJson(
  base: string,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(manifestUrl(base, fingerprint), { credentials: "same-origin", signal });
  if (res.status === 409) throw new Error("stale_fingerprint");
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  return (await res.json()) as unknown;
}
