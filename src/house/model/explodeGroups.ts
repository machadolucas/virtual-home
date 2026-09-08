/**
 * Explode / clip / isolation grouping.
 *
 * One resolver answers three questions that are really the same question: which presentation group
 * does a node belong to (explode offset), which clipping-plane pair does its material use, and how
 * does it behave under floor isolation.
 *
 * The package's hierarchy is **not** uniform — `house-roof`, `house-details`, `house-structure`
 * and `garage-roof` put elements directly under the building node, `terrain` has a `site` node with
 * no building at all, and `house-ground` keeps three elements as siblings of `f-ground` — so nodes
 * outside any floor node need a policy. Resolution order:
 *
 *   1. floor node (its name is a floorId)            → that floor's group
 *   2. explicit entry in `EXPLODE_POLICY`            → the stated group
 *   3. the element's own `floorId` from the manifest → that floor's group
 *   4. fallback by element `kind` (`KIND_POLICY`)    → roof / site
 *   5. otherwise `null` → the completeness test fails, which is what protects us against a
 *      future package revision adding an unclassifiable floor-less element.
 *
 * Groups are per building: `roof:<buildingId>`, so the garage (5 m below the house) never rides
 * the house stack's offset.
 */
import type { AssetId, ElementKind, ExplodeGroup, FloorId, LayerId, SurfaceId } from "./types";
import { SITE_GROUP } from "./types";
import type { ManifestIndex } from "./manifestIndex";
import { nodeKey } from "./manifestIndex";

export const roofGroup = (buildingId: string): ExplodeGroup => `roof:${buildingId}`;
export const isRoofGroup = (group: ExplodeGroup): boolean => group.startsWith("roof:");
export const buildingOfRoofGroup = (group: ExplodeGroup): string | null =>
  isRoofGroup(group) ? group.slice("roof:".length) : null;

export const DEFAULT_EXPLODE_GAP = 2.5;
export const MAX_EXPLODE_GAP = 6;

/** What a policy entry says a node belongs to. */
export type PolicyTarget =
  | { kind: "floor"; floorId: FloorId }
  | { kind: "roof" }
  | { kind: "site"; layer?: LayerId };

/**
 * Explicit policy for floor-less nodes, keyed `assetId/nodeName`. Only the cases the kind-based
 * fallback would get wrong are listed; every entry was read out of the shipped GLBs.
 */
export const EXPLODE_POLICY: Readonly<Record<string, PolicyTarget>> = {
  // Siblings of `f-ground` under `b-house`: hiding `f-ground` alone would leave these standing.
  "house-ground/e-g-fire-door-landing": { kind: "floor", floorId: "f-ground" },
  "house-ground/e-g-bay-door-landing": { kind: "floor", floorId: "f-ground" },
  "house-ground/e-outdoor-fireplace": { kind: "floor", floorId: "f-ground" },
  // Concrete under the terrace: at grade, but it appears and disappears with the terrace.
  "house-structure/e-terrace-structure": { kind: "site", layer: "outdoor" },
};

/** Fallback by element kind for elements the manifest leaves without a `floorId`. */
export const KIND_POLICY: Readonly<Partial<Record<ElementKind, PolicyTarget>>> = {
  roof: { kind: "roof" },
  chimney: { kind: "roof" },
  "roof-access": { kind: "roof" },
  truss: { kind: "roof" },
  beam: { kind: "roof" },
  terrain: { kind: "site", layer: "yard" },
  paving: { kind: "site", layer: "yard" },
  terrace: { kind: "site", layer: "outdoor" },
  step: { kind: "site", layer: "outdoor" },
  stair: { kind: "site", layer: "outdoor" },
  railing: { kind: "site", layer: "outdoor" },
  footing: { kind: "site" },
  slab: { kind: "site" },
  concrete: { kind: "site" },
  frame: { kind: "site" },
};

/**
 * Stack order per group. Derived from the manifest: each building's floors are ordered by
 * elevation (0, 1, 2 …) and its roof sits one step above the top floor; `site` never moves.
 * `offset(group) = order * gap`.
 */
export function buildGroupOrder(index: ManifestIndex): Map<ExplodeGroup, number> {
  const order = new Map<ExplodeGroup, number>();
  order.set(SITE_GROUP, 0);
  for (const b of index.buildings.values()) {
    const floors = [...(index.floorsByBuilding.get(b.id) ?? [])].sort(
      (x, y) => x.elevation - y.elevation,
    );
    floors.forEach((f, i) => order.set(f.id, i));
    order.set(roofGroup(b.id), floors.length);
  }
  for (const f of index.floors.values()) if (!order.has(f.id)) order.set(f.id, 0);
  return order;
}

export function explodeOffset(
  order: ReadonlyMap<ExplodeGroup, number>,
  group: ExplodeGroup,
  gap: number,
): number {
  if (gap <= 0) return 0;
  return (order.get(group) ?? 0) * gap;
}

function targetToGroup(
  index: ManifestIndex,
  target: PolicyTarget,
  buildingHint: string | null,
): ExplodeGroup {
  if (target.kind === "floor") return target.floorId;
  if (target.kind === "site") return SITE_GROUP;
  const building = buildingHint ?? [...index.buildings.keys()][0] ?? "unknown";
  return roofGroup(building);
}

function buildingOfAsset(index: ManifestIndex, assetId: AssetId): string | null {
  return index.assets.get(assetId)?.buildingId ?? null;
}

/** The layer checkbox that gates a node, if any. */
export function nodeLayer(
  index: ManifestIndex,
  assetId: AssetId,
  nodeName: string,
): LayerId | undefined {
  const target = policyFor(index, assetId, nodeName);
  return target && target.kind === "site" ? target.layer : undefined;
}

function policyFor(
  index: ManifestIndex,
  assetId: AssetId,
  nodeName: string,
): PolicyTarget | null {
  const explicit = EXPLODE_POLICY[nodeKey(assetId, nodeName)];
  if (explicit) return explicit;
  const eid = index.elementByNode.get(nodeKey(assetId, nodeName)) ?? nodeName;
  const el = index.elements.get(eid);
  if (!el) return null;
  if (el.floorId) return { kind: "floor", floorId: el.floorId };
  return KIND_POLICY[el.kind] ?? null;
}

/** Asset-level fallback group, used for edges nodes and assets with no floor node at all. */
export function assetGroup(index: ManifestIndex, assetId: AssetId): ExplodeGroup {
  const a = index.assets.get(assetId);
  if (!a) return SITE_GROUP;
  if (a.floorId) return a.floorId;
  if (a.kind === "terrain") return SITE_GROUP;
  // A building asset with no floor of its own is roof/detail geometry; pick its dominant group.
  const counts = new Map<ExplodeGroup, number>();
  for (const sid of index.surfacesByAsset.get(assetId) ?? []) {
    const g = clipGroupOf(index, sid);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  let best: ExplodeGroup = SITE_GROUP;
  let bestN = -1;
  for (const [g, n] of counts) {
    if (n <= bestN) continue;
    best = g;
    bestN = n;
  }
  return best;
}

/**
 * Group of a node inside an asset. `nodeName` may be a floor node, an element group node, a
 * surface node or the asset's edges node. `null` means "no policy" — a hard test failure.
 */
export function explodeGroupOf(
  index: ManifestIndex,
  assetId: AssetId,
  nodeName: string,
): ExplodeGroup | null {
  if (nodeName === `edges-${assetId}`) return assetGroup(index, assetId);
  if (index.floors.has(nodeName)) return nodeName;

  const sid = index.surfaceByNode.get(nodeKey(assetId, nodeName));
  if (sid) return clipGroupOf(index, sid);

  const target = policyFor(index, assetId, nodeName);
  if (!target) return null;
  return targetToGroup(index, target, buildingOfAsset(index, assetId));
}

/** Clip / explode group of a surface. Never null: an unowned surface follows its asset. */
export function clipGroupOf(index: ManifestIndex, surfaceId: SurfaceId): ExplodeGroup {
  const floorId = index.floorOfSurface.get(surfaceId);
  if (floorId) return floorId;
  const s = index.surfaces.get(surfaceId);
  const first = s?.nodeRefs[0];
  if (!first) return SITE_GROUP;
  const building = buildingOfAsset(index, first.assetId);
  if (s?.elementId) {
    const target = policyFor(index, first.assetId, s.elementId);
    if (target) return targetToGroup(index, target, building);
  }
  const own = EXPLODE_POLICY[nodeKey(first.assetId, first.nodeName)];
  if (own) return targetToGroup(index, own, building);
  const a = index.assets.get(first.assetId);
  if (a?.floorId) return a.floorId;
  if (a?.kind === "terrain") return SITE_GROUP;
  return SITE_GROUP;
}

/** Every group a manifest can produce, in stack order. */
export function groupsOf(index: ManifestIndex): ExplodeGroup[] {
  const order = buildGroupOrder(index);
  return [...order.keys()].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * `edges-<assetId>` is one object for a whole asset and cannot be split by floor. Where an asset's
 * nodes span more than one group (the two structure assets) the edges overlay is hidden while
 * exploded rather than rebuilt client-side.
 */
export function assetEdgesSpanGroups(
  index: ManifestIndex,
  assetId: AssetId,
  topLevelNodes: readonly string[],
): boolean {
  const groups = new Set<ExplodeGroup>();
  for (const n of topLevelNodes) {
    if (n === `edges-${assetId}`) continue;
    const g = explodeGroupOf(index, assetId, n);
    if (g) groups.add(g);
  }
  return groups.size > 1;
}

export interface PolicyCompletenessInput {
  assetId: AssetId;
  /** Names of the nodes directly under a building/site node, plus the asset's edges node. */
  nodeNames: readonly string[];
}

export interface PolicyCompletenessResult {
  classified: number;
  unclassified: string[];
  groups: Record<string, string>;
}

/**
 * Assert that every node that needs a group has one. The unit test feeds it the real GLB
 * hierarchy (the fixture always; the shipped package when `VH_REAL_MODEL_DIR` is set).
 */
export function checkExplodePolicy(
  index: ManifestIndex,
  assets: readonly PolicyCompletenessInput[],
): PolicyCompletenessResult {
  let classified = 0;
  const unclassified: string[] = [];
  const groups: Record<string, string> = {};
  for (const a of assets) {
    for (const n of a.nodeNames) {
      const g = explodeGroupOf(index, a.assetId, n);
      if (g === null) unclassified.push(nodeKey(a.assetId, n));
      else {
        classified++;
        groups[nodeKey(a.assetId, n)] = g;
      }
    }
  }
  return { classified, unclassified, groups };
}
