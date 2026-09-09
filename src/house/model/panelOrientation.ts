import type { Vec3 } from "./types";

/** Unit panel +Y is its outward face; yaw then tilt aligns it with a picked roof. */
export function panelOrientation(normal: Vec3): { rotationYDeg: number; tiltDeg: number } | null {
  if (!normal.every(Number.isFinite)) return null;
  const length = Math.hypot(...normal);
  if (length < 1e-8) return null;
  const side = normal[1] < 0 ? -1 : 1;
  const [x, y, z] = normal.map((n) => n * side / length) as Vec3;
  return {
    rotationYDeg: Math.hypot(x, z) < 1e-8 ? 0 : Math.atan2(x, z) * 180 / Math.PI,
    tiltDeg: Math.acos(Math.min(1, Math.max(-1, y))) * 180 / Math.PI,
  };
}
