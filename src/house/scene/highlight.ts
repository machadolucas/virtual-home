/**
 * Selection and hover highlighting: an **emissive tint** plus one reused edge outline.
 *
 * Why emissive rather than an outline pass, drei `<Outlines>` or a swapped material:
 *  - it cannot fight colour overrides, because `emissive` is an additive channel and `color` keeps
 *    exactly one writer, so a highlight can never leak into a persisted colour;
 *  - every material is already `MeshStandardMaterial` with `emissiveFactor [0,0,0]`, so this is a
 *    uniform write: no program recompile, no extra draw call, no render target;
 *  - it composes with `DoubleSide`, clipping planes, ortho, `frameloop="demand"` and explode.
 *
 * The one reused `LineSegments` outline is the secondary, non-colour signal that makes a thin wall
 * face readable from an oblique angle (WCAG: selection is never conveyed by colour alone).
 */
import * as THREE from "three";
import type { ExplodeGroup, SurfaceId } from "@/house/model/types";
import type { ClipGroups } from "./clipGroups";
import { getViewerPalette } from "./palette";
import type { SceneIndex } from "./SceneIndex";

/**
 * The tint hues come from the live tokens (`scene/palette.ts`), not from a literal: an emissive
 * chosen against a pale ground washes out on a dark one. The *intensities* stay fixed — they are
 * how strongly a highlight reads, which is not a theme question.
 */
export const SELECT_INTENSITY = 0.55;
export const HOVER_INTENSITY = 0.22;
export const ROOM_INTENSITY = 0.3;

export class Highlighter {
  private selected: SurfaceId[] = [];
  private hovered: SurfaceId | null = null;
  private outline: THREE.LineSegments | null = null;
  private outlineGeometry: THREE.BufferGeometry | null = null;
  private readonly outlineMaterial: THREE.LineBasicMaterial;

  constructor(private readonly parent: THREE.Object3D) {
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: getViewerPalette().selectOutline,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
  }

  /**
   * `selection` is the full highlighted set (a room highlights its floor + walls); `primary` is
   * the one surface that also gets the outline.
   */
  set(
    index: SceneIndex,
    clip: ClipGroups,
    selection: readonly SurfaceId[],
    hover: SurfaceId | null,
    opts: { intensity?: number; primary?: SurfaceId | null } = {},
  ): void {
    for (const id of this.selected) this.tint(index, id, 0x000000, 0);
    if (this.hovered) this.tint(index, this.hovered, 0x000000, 0);

    const palette = getViewerPalette();
    const intensity = opts.intensity ?? SELECT_INTENSITY;
    for (const id of selection) this.tint(index, id, palette.selectEmissive, intensity);
    if (hover && !selection.includes(hover))
      this.tint(index, hover, palette.hoverEmissive, HOVER_INTENSITY);

    this.selected = [...selection];
    this.hovered = hover;
    this.updateOutline(index, clip, opts.primary ?? selection[0] ?? null);
  }

  clear(index: SceneIndex, clip: ClipGroups): void {
    this.set(index, clip, [], null);
  }

  private tint(index: SceneIndex, id: SurfaceId, hex: number, k: number): void {
    const mat = index.surfaceMesh.get(id)?.material as THREE.MeshStandardMaterial | undefined;
    if (!mat?.emissive) return; // the mesh-less surfaces and any line material land here
    mat.emissive.setHex(hex);
    mat.emissiveIntensity = k;
  }

  /** Rebuilt only when the selection changes — never per frame. */
  private updateOutline(index: SceneIndex, clip: ClipGroups, primary: SurfaceId | null): void {
    const mesh = primary ? index.surfaceMesh.get(primary) : undefined;
    if (!mesh?.geometry) {
      if (this.outline) this.outline.visible = false;
      return;
    }
    this.outlineGeometry?.dispose();
    this.outlineGeometry = new THREE.EdgesGeometry(mesh.geometry, 25);
    if (!this.outline) {
      this.outline = new THREE.LineSegments(this.outlineGeometry, this.outlineMaterial);
      this.outline.name = "vh-selection-outline";
      this.outline.renderOrder = 999;
      this.outline.frustumCulled = false;
      this.parent.add(this.outline);
    } else {
      this.outline.geometry = this.outlineGeometry;
    }
    this.outline.visible = true;
    // The outline must be clipped by the same planes as its surface, or it survives the cutaway.
    const group: ExplodeGroup = index.clipGroupOf.get(primary as SurfaceId) ?? "site";
    this.outlineMaterial.clippingPlanes = clip.ensure(group);
    this.outlineMaterial.clipIntersection = false;
    mesh.updateWorldMatrix(true, false);
    this.outline.matrixAutoUpdate = false;
    this.outline.matrix.copy(mesh.matrixWorld);
    this.outline.matrixWorldNeedsUpdate = true;
  }

  /**
   * Re-read the palette into the long-lived outline material. The emissive tints need no equivalent
   * — `set()` reads the palette on every call, and the caller re-runs it after a theme change.
   */
  refreshPalette(): void {
    this.outlineMaterial.color.setHex(getViewerPalette().selectOutline);
  }

  get outlineNode(): THREE.LineSegments | null {
    return this.outline;
  }

  dispose(): void {
    if (this.outline) {
      this.outline.removeFromParent();
      this.outline = null;
    }
    this.outlineGeometry?.dispose();
    this.outlineGeometry = null;
    this.outlineMaterial.dispose();
  }
}

/**
 * The surfaces a selection highlights. A room highlights its own floor + wall + ceiling faces; an
 * element highlights all of its surfaces.
 */
export function highlightTargets(
  index: SceneIndex,
  selection: { kind: string; id: string } | null,
): { ids: SurfaceId[]; primary: SurfaceId | null; intensity: number } {
  if (!selection) return { ids: [], primary: null, intensity: SELECT_INTENSITY };
  const m = index.manifest;
  switch (selection.kind) {
    case "surface":
      return { ids: [selection.id], primary: selection.id, intensity: SELECT_INTENSITY };
    case "room": {
      const ids = m.roomSurfaces.get(selection.id) ?? [];
      const floor = (m.roomSurfacesByKind.get(`${selection.id}|floor`) ?? [])[0] ?? ids[0] ?? null;
      return { ids: [...ids], primary: floor, intensity: ROOM_INTENSITY };
    }
    case "element": {
      const ids = m.surfacesByElement.get(selection.id) ?? [];
      return { ids: [...ids], primary: ids[0] ?? null, intensity: SELECT_INTENSITY };
    }
    default:
      return { ids: [], primary: null, intensity: SELECT_INTENSITY };
  }
}
