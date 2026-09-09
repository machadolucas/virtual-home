/**
 * Cutaway by clipping planes, one pair per explode group.
 *
 * Two decisions carry this module:
 *
 *  - **The array length never changes.** three keys the shader program on
 *    `clippingPlanes.length`, so growing or shrinking the array would recompile every affected
 *    material (a visible hitch on ~400 materials). Every group therefore always owns exactly two
 *    shared planes, and each surface material gets one fixed focus plane; "off" means pushing
 *    `constant` past the model bounds. Only `constant` and `normal` change at runtime — no
 *    recompile, no `needsUpdate`.
 *  - **Per group, not global.** Clipping is evaluated in *world* space. If a floor is translated
 *    for an exploded view, a single global plane would cut it at the wrong physical height. With
 *    per-group pairs, `constant = cutY + explodeOffset(group)`, so cutaway and explode compose.
 */
import * as THREE from "three";
import type { ExplodeGroup, VerticalCut } from "@/house/model/types";

/** Far enough outside any plausible site bounds to mean "no cut". */
export const OFF = 1e4;

export interface CutState {
  enabled: boolean;
  y: number;
  vertical: VerticalCut | null;
}

export class ClipGroups {
  /** group → [horizontal, vertical]. Assigned to materials once, at load. */
  readonly planes = new Map<ExplodeGroup, [THREE.Plane, THREE.Plane]>();
  /** One fixed third plane per surface material for the transient low-wall focus cut. */
  private readonly focusPlanes = new Map<string, THREE.Plane[]>();
  private readonly surfaceGroups = new Map<string, ExplodeGroup>();

  constructor(groups: Iterable<ExplodeGroup>) {
    for (const g of groups) this.ensure(g);
  }

  ensure(group: ExplodeGroup): [THREE.Plane, THREE.Plane] {
    let pair = this.planes.get(group);
    if (!pair) {
      pair = [
        // keep y <= constant
        new THREE.Plane(new THREE.Vector3(0, -1, 0), OFF),
        // keep x <= constant (the axis and sign are swapped on demand)
        new THREE.Plane(new THREE.Vector3(-1, 0, 0), OFF),
      ];
      this.planes.set(group, pair);
    }
    return pair;
  }

  /** Attach group planes plus a fixed surface focus plane. Tolerates a node with no material. */
  attach(object: THREE.Object3D, group: ExplodeGroup, surfaceId?: string): void {
    const mat = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const planes = this.ensure(group);
    const apply = (m: THREE.Material) => {
      if (surfaceId) {
        this.surfaceGroups.set(surfaceId, group);
        const focus = new THREE.Plane(new THREE.Vector3(0, -1, 0), OFF);
        m.clippingPlanes = [planes[0], planes[1], focus];
        const list = this.focusPlanes.get(surfaceId);
        if (list) list.push(focus);
        else this.focusPlanes.set(surfaceId, [focus]);
      } else {
        m.clippingPlanes = planes;
      }
      // A fragment is clipped if it fails ANY plane: the kept region is the intersection of the
      // half-spaces, which is exactly "a horizontal cut AND an optional vertical cut".
      m.clipIntersection = false;
      m.clipShadows = false;
    };
    if (Array.isArray(mat)) mat.forEach(apply);
    else apply(mat);
  }

  /** Cut only the supplied wall surfaces down to `worldY`; all others keep their plane off. */
  setFocusCuts(cuts: ReadonlyMap<string, number>): boolean {
    let changed = false;
    for (const [surfaceId, planes] of this.focusPlanes) {
      const next = cuts.get(surfaceId) ?? OFF;
      for (const plane of planes) {
        if (Math.abs(plane.constant - next) < 1e-6) continue;
        plane.normal.set(0, -1, 0);
        plane.constant = next;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Re-place one group's planes. `explodeOffsetY` is the group's current presentation offset, so
   * the cut lands at the same *physical* height whether the model is exploded or not.
   */
  setCut(group: ExplodeGroup, cut: CutState, explodeOffsetY: number): void {
    const pair = this.ensure(group);
    const [horizontal, vertical] = pair;
    if (!cut.enabled) {
      horizontal.normal.set(0, -1, 0);
      horizontal.constant = OFF;
      vertical.normal.set(-1, 0, 0);
      vertical.constant = OFF;
      return;
    }
    horizontal.normal.set(0, -1, 0);
    horizontal.constant = cut.y + explodeOffsetY;

    if (!cut.vertical) {
      vertical.normal.set(-1, 0, 0);
      vertical.constant = OFF;
      return;
    }
    const { axis, v, sign } = cut.vertical;
    // sign +1 keeps the low side (coordinate <= v), -1 keeps the high side.
    vertical.normal.set(axis === "x" ? -sign : 0, 0, axis === "z" ? -sign : 0);
    vertical.constant = sign > 0 ? v : -v;
  }

  setCutAll(
    cut: CutState,
    offsetOf: (group: ExplodeGroup) => number,
  ): void {
    for (const group of this.planes.keys()) this.setCut(group, cut, offsetOf(group));
  }

  /** True when `point` survives both of a group's planes. Used by the picker and the labels. */
  keeps(group: ExplodeGroup, point: THREE.Vector3): boolean {
    const pair = this.planes.get(group);
    if (!pair) return true;
    return pair[0].distanceToPoint(point) >= 0 && pair[1].distanceToPoint(point) >= 0;
  }

  /** Clip-aware picking for a surface, including its transient focus plane. */
  keepsSurface(group: ExplodeGroup, surfaceId: string | null, point: THREE.Vector3): boolean {
    if (!this.keeps(group, point)) return false;
    if (!surfaceId) return true;
    return (this.focusPlanes.get(surfaceId) ?? []).every((plane) => plane.distanceToPoint(point) >= 0);
  }

  /** Read-only browser-test/debug view of the planes attached to one surface. */
  planesFor(surfaceId: string): readonly THREE.Plane[] {
    const group = this.surfaceGroups.get(surfaceId);
    const pair = group ? this.planes.get(group) : undefined;
    const focus = this.focusPlanes.get(surfaceId)?.[0];
    return pair && focus ? [pair[0], pair[1], focus] : [];
  }
}
