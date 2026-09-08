/**
 * Pure 2D helpers over room footprints (`[x, z]` rings, metres). No three.js, no DOM.
 *
 * Plan convention (from the package): X = plan-east (screen right), Z = plan-south (screen down),
 * so an SVG viewBox reads directly with no axis flip.
 */
import type { Vec2 } from "./types";

export type Ring = ReadonlyArray<Vec2>;

export interface BBox2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function ringBBox(ring: Ring): BBox2 {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    const x = p[0];
    const z = p[1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function bboxUnion(a: BBox2, b: BBox2): BBox2 {
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

/** Signed shoelace area. Positive means counter-clockwise in an X-right / Z-down plan. */
export function ringSignedArea(ring: Ring): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i] as Vec2;
    const b = ring[(i + 1) % n] as Vec2;
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

export const ringArea = (ring: Ring): number => Math.abs(ringSignedArea(ring));

/** Area-weighted polygon centroid. May fall **outside** a concave ring — see poleOfInaccessibility. */
export function ringCentroid(ring: Ring): Vec2 {
  const a2 = ringSignedArea(ring) * 6;
  if (Math.abs(a2) < 1e-12) {
    // Degenerate ring: fall back to the vertex mean so callers always get a finite point.
    let sx = 0;
    let sz = 0;
    for (const p of ring) {
      sx += p[0];
      sz += p[1];
    }
    const n = Math.max(1, ring.length);
    return [sx / n, sz / n];
  }
  let cx = 0;
  let cz = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i] as Vec2;
    const q = ring[(i + 1) % n] as Vec2;
    const cross = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * cross;
    cz += (p[1] + q[1]) * cross;
  }
  return [cx / a2, cz / a2];
}

/** Even-odd (crossing-number) test against a single ring. Boundary counts as inside. */
export function pointInRing(x: number, z: number, ring: Ring): boolean {
  const n = ring.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = ring[i] as Vec2;
    const b = ring[j] as Vec2;
    if (pointOnSegment(x, z, a, b)) return true;
    const intersects = a[1] > z !== b[1] > z && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointOnSegment(x: number, z: number, a: Vec2, b: Vec2, eps = 1e-9): boolean {
  const cross = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
  if (Math.abs(cross) > eps) return false;
  const dot = (x - a[0]) * (x - b[0]) + (z - a[1]) * (z - b[1]);
  return dot <= eps;
}

/** Inside the outer ring and outside every hole. */
export function pointInFootprint(
  x: number,
  z: number,
  footprint: { outer: Ring; holes?: ReadonlyArray<Ring> },
): boolean {
  if (!pointInRing(x, z, footprint.outer)) return false;
  for (const h of footprint.holes ?? []) if (pointInRing(x, z, h)) return false;
  return true;
}

function pointToSegmentDistance(x: number, z: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(x - a[0], z - a[1]);
  let t = ((x - a[0]) * dx + (z - a[1]) * dz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
}

/** Distance to the nearest edge of any ring (outer or hole), unsigned. */
export function distanceToRings(x: number, z: number, rings: ReadonlyArray<Ring>): number {
  let best = Infinity;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i] as Vec2;
      const b = ring[(i + 1) % n] as Vec2;
      const d = pointToSegmentDistance(x, z, a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Signed clearance: positive inside the footprint, negative outside. */
export function signedClearance(
  x: number,
  z: number,
  footprint: { outer: Ring; holes?: ReadonlyArray<Ring> },
): number {
  const d = distanceToRings(x, z, [footprint.outer, ...(footprint.holes ?? [])]);
  return pointInFootprint(x, z, footprint) ? d : -d;
}

/**
 * Pole of inaccessibility — the centre of the largest circle that fits inside the footprint.
 * Grid refinement (coarse sample, then shrink the search window around the best cell), which is
 * deterministic, allocation-light and always lands inside a concave ring where a centroid does not
 * (the 11-point hall and 18-point living-room rings are the motivating cases).
 */
export function poleOfInaccessibility(
  footprint: { outer: Ring; holes?: ReadonlyArray<Ring> },
  opts: { precision?: number; samples?: number; passes?: number } = {},
): { point: Vec2; clearance: number } {
  const precision = opts.precision ?? 0.01;
  const samples = Math.max(4, opts.samples ?? 16);
  const maxPasses = opts.passes ?? 12;
  const bb = ringBBox(footprint.outer);

  let cx = (bb.minX + bb.maxX) / 2;
  let cz = (bb.minZ + bb.maxZ) / 2;
  let half = Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ) / 2;
  let best: Vec2 = [cx, cz];
  let bestScore = -Infinity;

  for (let pass = 0; pass < maxPasses; pass++) {
    const step = (half * 2) / samples;
    for (let i = 0; i <= samples; i++) {
      for (let j = 0; j <= samples; j++) {
        const x = cx - half + i * step;
        const z = cz - half + j * step;
        const s = signedClearance(x, z, footprint);
        if (s > bestScore) {
          bestScore = s;
          best = [x, z];
        }
      }
    }
    cx = best[0];
    cz = best[1];
    half = step;
    if (step <= precision) break;
  }
  return { point: [round(best[0]), round(best[1])], clearance: Math.max(0, round(bestScore)) };
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Total polyline length in metres. */
export function polylineLength(points: ReadonlyArray<readonly number[]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as readonly number[];
    const b = points[i] as readonly number[];
    let s = 0;
    for (let k = 0; k < Math.min(a.length, b.length); k++) {
      const d = (b[k] as number) - (a[k] as number);
      s += d * d;
    }
    total += Math.sqrt(s);
  }
  return total;
}

/** Snap to a grid, then round to millimetres so persisted values carry no float dust. */
export function snapValue(v: number, grid: number): number {
  const snapped = grid > 0 ? Math.round(v / grid) * grid : v;
  return Math.round(snapped * 1000) / 1000;
}
