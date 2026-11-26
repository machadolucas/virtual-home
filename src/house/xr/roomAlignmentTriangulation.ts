import { Ray, Vector3 } from "three";

const MIN_BASELINE_M = 0.22;
const MIN_LATERAL_BASELINE_M = 0.18;
const MIN_ANGLE_SINE = 0.07;
const MAX_RAY_GAP_M = 0.035;
const MIN_DEPTH_M = 0.25;
const MAX_DEPTH_M = 8;
const FLOOR_TOLERANCE_M = 0.22;

export function triangulateFloorCorner(first: Ray, second: Ray): { point?: never; message: string } | { point: Vector3 } {
  const from = first.direction.clone().normalize(), toward = second.direction.clone().normalize();
  const delta = first.origin.clone().sub(second.origin);
  const baseline = delta.length();
  const cosine = from.dot(toward), denominator = 1 - cosine * cosine;
  if (!Number.isFinite(baseline) || baseline < MIN_BASELINE_M ||
    delta.clone().cross(from).length() < MIN_LATERAL_BASELINE_M ||
    !Number.isFinite(denominator) || denominator < MIN_ANGLE_SINE ** 2 || cosine < 0) {
    return { message: "Keep your feet still. Move your aiming hand sideways by about 30 cm, then point at the same corner." };
  }
  const d = from.dot(delta), e = toward.dot(delta);
  const a = (cosine * e - d) / denominator;
  const b = (e - cosine * d) / denominator;
  if (a < MIN_DEPTH_M || b < MIN_DEPTH_M || a > MAX_DEPTH_M || b > MAX_DEPTH_M) {
    return { message: "Aim both rays forward at the same visible corner. Try again from two safe hand positions." };
  }
  const p = first.origin.clone().addScaledVector(from, a), q = second.origin.clone().addScaledVector(toward, b);
  if (!Number.isFinite(p.distanceToSquared(q)) || p.distanceTo(q) > MAX_RAY_GAP_M) {
    return { message: "The two aims missed each other. Aim at precisely the same floor corner." };
  }
  p.lerp(q, 0.5);
  if (Math.abs(p.y) > FLOOR_TOLERANCE_M) {
    return { message: "Aim where the two walls meet the physical floor." };
  }
  return { point: p };
}
