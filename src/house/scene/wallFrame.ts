/**
 * Extract a 2D frame from a wall surface mesh: `(u along the wall, v up, d out of the face)`.
 *
 * The extents come from projecting the **vertices**, not the AABB corners: several wall surfaces
 * are not axis-aligned (a diagonal wall, a bay), where an AABB overstates the extents by up to a
 * metre. Vertex projection is exact and costs a few dozen dot products on a 4–20 triangle mesh.
 */
import * as THREE from "three";

export interface WallFrame {
  /**
   * The `u = 0` point of the surface plane at world **y = 0**, so `v` is world height and
   * `toWorld(u, room.floorElevation + h, d)` reads as "h metres above that room's own floor".
   */
  origin: THREE.Vector3;
  /** Unit, horizontal, along the wall. */
  u: THREE.Vector3;
  /** Unit, world up. */
  v: THREE.Vector3;
  /** Unit, out of the surface (towards the room). */
  n: THREE.Vector3;
  /** `[0, length]` along the wall. */
  uRange: [number, number];
  /** World-space Y range of the face (`v` is world height, not height above the face). */
  vRange: [number, number];
  toLocal(p: THREE.Vector3): { u: number; v: number; d: number };
  toWorld(u: number, v: number, d: number): THREE.Vector3;
}

/** Area-weighted mean triangle normal, flattened to horizontal (walls are vertical). */
export function dominantNormal(geometry: THREE.BufferGeometry): THREE.Vector3 {
  const pos = geometry.getAttribute("position");
  if (!pos) return new THREE.Vector3(0, 0, 1);
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const sum = new THREE.Vector3();

  const triangles = index ? index.count / 3 : pos.count / 3;
  for (let t = 0; t < triangles; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    cross.crossVectors(ab, ac); // length = 2 * area, so this is area-weighted
    sum.add(cross);
  }
  if (sum.lengthSq() < 1e-12) {
    // Fall back to the NORMAL attribute for a degenerate or perfectly cancelling set.
    const nrm = geometry.getAttribute("normal");
    if (nrm) sum.set(nrm.getX(0), nrm.getY(0), nrm.getZ(0));
    else sum.set(0, 0, 1);
  }
  return sum.normalize();
}

export interface WallFrameOptions {
  /** A point inside the room, used to orient `n` towards it. `DoubleSide` makes winding useless. */
  towards?: THREE.Vector3;
}

export function wallFrame(mesh: THREE.Mesh, opts: WallFrameOptions = {}): WallFrame {
  const geometry = mesh.geometry;
  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld;

  const n = dominantNormal(geometry).applyMatrix3(
    new THREE.Matrix3().getNormalMatrix(matrix),
  );
  n.y = 0;
  if (n.lengthSq() < 1e-12) n.set(0, 0, 1);
  n.normalize();

  const v = new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(v, n).normalize();

  const pos = geometry.getAttribute("position");
  const p = new THREE.Vector3();
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  let dSum = 0;
  const count = pos ? pos.count : 0;
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    const pu = p.dot(u);
    if (pu < u0) u0 = pu;
    if (pu > u1) u1 = pu;
    if (p.y < v0) v0 = p.y;
    if (p.y > v1) v1 = p.y;
    dSum += p.dot(n);
  }
  if (count === 0) {
    u0 = 0;
    u1 = 0;
    v0 = 0;
    v1 = 0;
  }
  const dPlane = count ? dSum / count : 0;

  // Orient the normal towards the room before the origin is derived from it.
  if (opts.towards) {
    const facePoint = new THREE.Vector3()
      .addScaledVector(u, u0)
      .addScaledVector(v, (v0 + v1) / 2)
      .addScaledVector(n, dPlane);
    if (opts.towards.clone().sub(facePoint).dot(n) < 0) {
      n.negate();
      u.crossVectors(v, n).normalize();
      // u flipped too, so the projections must be recomputed.
      u0 = Infinity;
      u1 = -Infinity;
      dSum = 0;
      for (let i = 0; i < count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
        const pu = p.dot(u);
        if (pu < u0) u0 = pu;
        if (pu > u1) u1 = pu;
        dSum += p.dot(n);
      }
      return makeFrame(u, v, n, u0, u1, v0, v1, count ? dSum / count : 0);
    }
  }

  return makeFrame(u, v, n, u0, u1, v0, v1, dPlane);
}

function makeFrame(
  u: THREE.Vector3,
  v: THREE.Vector3,
  n: THREE.Vector3,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  dPlane: number,
): WallFrame {
  const origin = new THREE.Vector3().addScaledVector(u, u0).addScaledVector(n, dPlane);

  const frame: WallFrame = {
    origin,
    u: u.clone(),
    v: v.clone(),
    n: n.clone(),
    uRange: [0, u1 - u0],
    vRange: [v0, v1],
    toLocal(p: THREE.Vector3) {
      const rel = p.clone().sub(origin);
      return { u: rel.dot(frame.u), v: rel.dot(frame.v), d: rel.dot(frame.n) };
    },
    toWorld(uu: number, vv: number, dd: number) {
      return origin
        .clone()
        .addScaledVector(frame.u, uu)
        .addScaledVector(frame.v, vv)
        .addScaledVector(frame.n, dd);
    },
  };
  return frame;
}
