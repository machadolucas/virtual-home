/**
 * The single declarative visibility resolver.
 *
 * Visibility is a **pure function of view state**, re-resolved and re-applied in full on every
 * change. ~500 boolean writes is microseconds; the alternative (many independent handlers mutating
 * `.visible`) is the single largest source of "the model is in a weird state" bugs, and it is what
 * desynchronises the toolbar checkboxes from the scene.
 *
 * Decisions are keyed `assetId/nodeName`, never by bare node name: `f-upper` exists in four assets
 * and `f-ground` in three, and each copy is a different object.
 */
import { assetEdgesSpanGroups, explodeGroupOf, isRoofGroup, nodeLayer } from "./explodeGroups";
import { isAboveFocus, type FocusContext } from "./focusContext";
import { nodeKey, type ManifestIndex } from "./manifestIndex";
import type { Asset, AssetId, FloorId, LayerId, Projection, ViewMode, WallMode } from "./types";
import { SITE_GROUP } from "./types";

/** Structural element kinds; a `detail` asset made only of these is gated by the structure layer. */
const STRUCTURAL_KINDS = new Set([
  "truss",
  "beam",
  "footing",
  "slab",
  "slab-edge",
  "frame",
  "concrete",
]);

/** What the resolver knows about the loaded GLB hierarchy. Supplied by `SceneIndex`. */
export interface AssetNodeInventory {
  assetId: AssetId;
  /** Node names that are floor ids (`f-*`), at any depth under the asset root. */
  floorNodes: string[];
  /** Element group nodes that are **not** inside a floor node. */
  floorlessElementNodes: string[];
  edgesNode: string | null;
}

export interface VisibilityInput {
  viewMode: ViewMode;
  projection?: Projection;
  wallMode?: WallMode;
  activeFloorId: FloorId | null;
  roofVisible: boolean;
  ceilingsVisible: boolean;
  edgesVisible: boolean;
  layers: Record<LayerId, boolean>;
  loadedAssetIds: readonly AssetId[];
  explode?: { enabled: boolean; gap: number };
  inventory: readonly AssetNodeInventory[];
  /** Transient selection context. It never changes the stored view controls. */
  focus?: FocusContext | null;
}

export interface VisibilityPlan {
  /** Asset root objects. */
  assets: Map<AssetId, boolean>;
  /** `assetId/nodeName` → visible. Floor nodes, floor-less element nodes, edges, ceiling faces. */
  nodes: Map<string, boolean>;
}

const ISOLATING: ReadonlySet<ViewMode> = new Set<ViewMode>(["floor", "plan", "section"]);

/** Which layer checkbox gates a whole asset, if any. Derived from the manifest, not hard-coded ids. */
export function assetLayer(index: ManifestIndex, asset: Asset): LayerId | undefined {
  if (asset.kind === "scan-reference") return "scanReferences";
  if (asset.kind === "terrain") return "yard";
  if (asset.kind === "detail") {
    const kinds = new Set<string>();
    for (const e of index.manifest.elements) {
      if (e.nodeRefs[0]?.assetId === asset.id) kinds.add(e.kind);
    }
    if (kinds.size > 0 && [...kinds].every((k) => STRUCTURAL_KINDS.has(k))) return "structure";
    return "outdoor";
  }
  return undefined;
}

export function computeVisibility(index: ManifestIndex, v: VisibilityInput): VisibilityPlan {
  const assets = new Map<AssetId, boolean>();
  const nodes = new Map<string, boolean>();
  const loaded = new Set(v.loadedAssetIds);
  const isolating = ISOLATING.has(v.viewMode) && v.activeFloorId !== null;
  const exploded = (v.explode?.enabled ?? false) && (v.explode?.gap ?? 0) > 0;
  const focus = v.focus ?? null;
  const focusOpensShell = v.wallMode !== "closed";
  // Focus temporarily supersedes manual isolation so a room on another floor can always reveal
  // itself. Clearing focus re-applies the unchanged manual mode.
  const manualIsolating = isolating && focus === null;

  // 1. asset roots. A floor shortcut focuses one building storey while retaining the rest of the
  //    property and the lower floors that visually support it.
  for (const asset of index.manifest.assets) {
    let visible = loaded.has(asset.id);
    const layer = assetLayer(index, asset);
    if (visible && layer && !v.layers[layer]) visible = false;
    if (visible && manualIsolating && asset.floorId && aboveActiveFloor(index, asset.floorId, v.activeFloorId))
      visible = false;
    if (visible && focus && asset.floorId && isAboveFocus(index, asset.floorId, focus)) visible = false;
    assets.set(asset.id, visible);
  }

  for (const inv of v.inventory) {
    const assetVisible = assets.get(inv.assetId) ?? false;

    // 2. Per-building floor focus, across all assets that carry a copy of the floor node.
    for (const fname of inv.floorNodes) {
      nodes.set(
        nodeKey(inv.assetId, fname),
        (!manualIsolating || !aboveActiveFloor(index, fname, v.activeFloorId)) &&
          (!focus || !isAboveFocus(index, fname, focus)),
      );
    }

    // 3. floor-less element nodes: the static policy table decides
    for (const ename of inv.floorlessElementNodes) {
      const group = explodeGroupOf(index, inv.assetId, ename) ?? SITE_GROUP;
      const layer = nodeLayer(index, inv.assetId, ename);
      let visible = true;
      if (layer && !v.layers[layer]) visible = false;
      else if (isRoofGroup(group))
        visible =
          v.roofVisible &&
          (!focusOpensShell ||
            !focus ||
            focus.floorId === null ||
            focus.keepRoof ||
            group !== `roof:${focus.buildingId}`);
      else if (group === SITE_GROUP) visible = true; // grade-level: isolation does not apply
      else
        visible =
          (!manualIsolating || !aboveActiveFloor(index, group, v.activeFloorId)) &&
          (!focus || !isAboveFocus(index, group, focus));
      nodes.set(nodeKey(inv.assetId, ename), visible);
    }

    // 5. edges overlay. One object per asset; it cannot be split, so an asset whose nodes span
    //    more than one explode group hides its edges while exploded.
    if (inv.edgesNode) {
      const spans = assetEdgesSpanGroups(index, inv.assetId, [
        ...inv.floorNodes,
        ...inv.floorlessElementNodes,
      ]);
      nodes.set(
        nodeKey(inv.assetId, inv.edgesNode),
        v.edgesVisible && assetVisible && !(exploded && spans),
      );
    }
  }

  // 4. ceilings, by surface node name (this also covers `dormer-ceiling`, which an element-level
  //    rule on `e-<floorId>-ceiling` would miss)
  for (const sid of index.ceilingSurfaceIds) {
    const s = index.surfaces.get(sid);
    if (!s) continue;
    const floorId = index.floorOfSurface.get(sid) ?? null;
    const hide =
      (!v.ceilingsVisible && (!manualIsolating || floorId === null || floorId === v.activeFloorId)) ||
      (focusOpensShell &&
        focus !== null &&
        focus.floorId !== null &&
        floorId === focus.floorId &&
        sid !== focus.preserveSurfaceId);
    for (const nr of s.nodeRefs) nodes.set(nodeKey(nr.assetId, nr.nodeName), !hide);
  }

  // 5. Roof-role faces can live below a floor-bound dormer group. Hiding only the outer roof
  // element therefore leaves those faces floating above the room. Resolve them by semantic
  // surface role while leaving the dormer's wall faces and openings with their floor.
  if (!v.roofVisible) {
    for (const surface of index.surfaces.values()) {
      const element = surface.elementId ? index.elements.get(surface.elementId) : undefined;
      const roofFace =
        element?.kind === "roof" ||
        /^roof(?:-|$)/i.test(surface.role ?? "") ||
        /^dormer-ceiling/i.test(surface.role ?? "");
      if (!roofFace) continue;
      for (const nr of surface.nodeRefs) nodes.set(nodeKey(nr.assetId, nr.nodeName), false);
    }
  }

  // Door leaves and frames disappear in inside-cut modes, even when their wall is behind the
  // camera. Their physical geometry remains indexed for placement collision checks.
  if (v.wallMode === "cut" || v.wallMode === "contextual") {
    for (const element of index.elements.values()) {
      if (element.kind !== "door") continue;
      for (const ref of element.nodeRefs) nodes.set(nodeKey(ref.assetId, ref.nodeName), false);
      for (const sid of index.surfacesByElement.get(element.id) ?? []) {
        for (const ref of index.surfaces.get(sid)?.nodeRefs ?? []) nodes.set(nodeKey(ref.assetId, ref.nodeName), false);
      }
    }
  }

  return { assets, nodes };
}

function aboveActiveFloor(
  index: ManifestIndex,
  floorId: FloorId,
  activeFloorId: FloorId | null,
): boolean {
  if (!activeFloorId) return false;
  const floor = index.floors.get(floorId);
  const active = index.floors.get(activeFloorId);
  return Boolean(
    floor && active && floor.buildingId === active.buildingId && floor.elevation > active.elevation,
  );
}

/** Whether an explode group is currently on screen — used by the label overlay. */
export function isGroupVisible(
  index: ManifestIndex,
  plan: VisibilityPlan,
  group: string,
  input: Pick<VisibilityInput, "viewMode" | "activeFloorId" | "roofVisible" | "focus">,
): boolean {
  if (isRoofGroup(group)) return input.roofVisible;
  if (group === SITE_GROUP) return true;
  if (input.focus) return !isAboveFocus(index, group, input.focus);
  if (!ISOLATING.has(input.viewMode) || input.activeFloorId === null) return true;
  return !aboveActiveFloor(index, group, input.activeFloorId);
}

/** The dollhouse preset: a *store write*, not a mode, so the checkboxes stay in sync. */
export const DOLLHOUSE_PRESET = {
  roofVisible: false,
  ceilingsVisible: false,
  viewMode: "overview" as ViewMode,
};

export const OVERVIEW_PRESET = {
  roofVisible: true,
  ceilingsVisible: true,
  edgesVisible: true,
  viewMode: "overview" as ViewMode,
  projection: "perspective" as Projection,
  activeFloorId: null,
};
