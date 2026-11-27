import { ringSignedArea } from "../model/geometry2d";
import type { Vec2 } from "../model/types";
import { MAX_CALIBRATION_ERROR_M } from "./mixedCalibration";

export type Edge = readonly [Vec2, Vec2];

export function floorEdges(points: readonly Vec2[]): Edge[] {
  return points.flatMap((a, i) => {
    const b = points[(i + 1) % points.length]!;
    return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.002 ? [] : [[a, b] as const];
  });
}

function edgeDistance([x, z]: Vec2, [a, b]: Edge): number {
  const dx = b[0] - a[0],
    dz = b[1] - a[1];
  const n = dx * dx + dz * dz;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / n));
  return Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz);
}

/** Both directions matter: a tiny room or a scan spanning multiple rooms can share several walls. */
export function outlinesAgree(a: readonly Vec2[], b: readonly Vec2[], toleranceM = MAX_CALIBRATION_ERROR_M + 1e-8): boolean {
  if (a.length < 3 || b.length < 3 || a.length > 128 || b.length > 128) return false;
  const areaA = Math.abs(ringSignedArea(a)),
    areaB = Math.abs(ringSignedArea(b));
  if (Math.min(areaA, areaB) < 0.65 || Math.abs(areaB - areaA) > Math.max(areaA, areaB) * 0.15)
    return false;
  const edgesA = floorEdges(a),
    edgesB = floorEdges(b);
  const supported = (edges: Edge[], supports: Edge[]) =>
    edges.every(([a, b]) => {
      const samples = Math.min(32, Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25)));
      for (let i = 0; i <= samples; i++) {
        const at: Vec2 = [a[0] + ((b[0] - a[0]) * i) / samples, a[1] + ((b[1] - a[1]) * i) / samples];
        if (!supports.some((edge) => edgeDistance(at, edge) <= toleranceM)) return false;
      }
      return true;
    });
  return supported(edgesA, edgesB) && supported(edgesB, edgesA);
}
