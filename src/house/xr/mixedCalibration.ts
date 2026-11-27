import { Matrix4, Vector3 } from "three";
import { ringBBox } from "@/house/model/geometry2d";
import type { Manifest, Vec3 } from "@/house/model/types";

export const MIN_CALIBRATION_BASELINE_M = 1.5;
export const MAX_CALIBRATION_ERROR_M = 0.05;
const MIN_CHECK_OFFSET_M = 0.3;

export interface CalibrationFeature {
  id: string;
  label: string;
  openingKind?: "door" | "window";
  roomId?: string;
  planLabel?: string;
  point: Vec3;
}

export interface CalibrationPair {
  feature: CalibrationFeature;
  observed: Vec3;
}

export function calibrationFeatures(
  manifest: Manifest,
  floorId: string,
  roomId?: string | null,
): CalibrationFeature[] {
  return manifest.rooms
    .filter((room) => room.floorId === floorId && room.kind !== "void" && (!roomId || room.id === roomId))
    .flatMap((room) => {
      const ring = room.footprint.outer;
      const { minX, minZ, maxX, maxZ } = ringBBox(ring);
      // Some survey rings repeat the starting point to close the polygon.
      return ring
        .map(([x, z], i) => ({ x, z, i }))
        .filter(({ x, z, i }) => ring.findIndex(([px, pz]) => px === x && pz === z) === i)
        .map(({ x, z, i }, index) => {
          // Match the displayed X-right, Z-down plan without assuming its geographic bearing.
          const relativeX = (x - minX) / (maxX - minX);
          const relativeZ = (z - minZ) / (maxZ - minZ);
          const vertical = relativeZ <= 0.3 ? "upper" : relativeZ >= 0.7 ? "lower" : "";
          const horizontal = relativeX <= 0.3 ? "left" : relativeX >= 0.7 ? "right" : "";
          const location = [vertical, horizontal].filter(Boolean).join(" ") || "interior turn";
          const planLabel = `Corner ${index + 1} · ${location} on plan`;
          return {
            id: `${room.id}:corner:${i}`,
            label: `${room.name} · ${planLabel}`,
            roomId: room.id,
            planLabel,
            point: [x, room.floorElevation, z] as Vec3,
          };
        });
    });
}

const horizontalDistance = (a: Vec3, b: Vec3): number => Math.hypot(b[0] - a[0], b[2] - a[2]);

function offsetFromBaseline(a: Vec3, b: Vec3, c: Vec3): number {
  return Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) /
    horizontalDistance(a, b);
}

export function suitableNextFeature(pairs: readonly CalibrationPair[], feature: CalibrationFeature): boolean {
  if (pairs.some(pair => pair.feature.id === feature.id)) return false;
  const [first, second] = pairs;
  if (!first) return true;
  if (!second) return horizontalDistance(first.feature.point, feature.point) >= MIN_CALIBRATION_BASELINE_M;
  return offsetFromBaseline(first.feature.point, second.feature.point, feature.point) >= MIN_CHECK_OFFSET_M;
}

export interface CalibrationFit {
  /** Translation of the model origin and yaw in local-floor space, with unit scale. */
  matrix: Matrix4;
  /** Use a real-world point near the work area as the tracked origin for the browser anchor. */
  anchorPosition: Vec3;
  modelOrigin: Vec3;
  yaw: number;
}

export function fitCalibration(
  first: CalibrationPair,
  second: CalibrationPair,
): { fit: CalibrationFit; message?: never } | { fit?: never; message: string } {
  const a = first.feature.point;
  const b = second.feature.point;
  const p = first.observed;
  const q = second.observed;
  const modelLength = horizontalDistance(a, b);
  const realLength = horizontalDistance(p, q);
  if (Math.min(modelLength, realLength) < MIN_CALIBRATION_BASELINE_M) {
    return { message: "Choose two fixed features at least 1.5 m apart in plan." };
  }
  const spanError = Math.hypot(realLength - modelLength, (q[1] - p[1]) - (b[1] - a[1]));
  if (spanError > MAX_CALIBRATION_ERROR_M) {
    return { message: `The first two touches disagree with the model by ${Math.round(spanError * 100)} cm. Check the selected feature and touch it again.` };
  }
  // In the X/Z plane a positive rotation about Y decreases atan2(z, x).
  const yaw = Math.atan2(b[2] - a[2], b[0] - a[0]) -
    Math.atan2(q[2] - p[2], q[0] - p[0]);
  const rotation = new Matrix4().makeRotationY(yaw);
  const projected = new Vector3(...b).sub(new Vector3(...a)).applyMatrix4(rotation);
  // Split the small measurement residual over the two training touches. The third remains held out.
  const position = new Vector3(...p).addScaledVector(new Vector3(...q).sub(new Vector3(...p)).sub(projected), 0.5);
  rotation.setPosition(position);
  return {
    fit: {
      matrix: rotation.multiply(new Matrix4().makeTranslation(-a[0], -a[1], -a[2])),
      anchorPosition: position.toArray(),
      modelOrigin: a,
      yaw,
    },
  };
}

export function independentCheck(
  first: CalibrationPair,
  second: CalibrationPair,
  third: CalibrationPair,
): boolean {
  return offsetFromBaseline(first.feature.point, second.feature.point, third.feature.point) >= MIN_CHECK_OFFSET_M &&
    offsetFromBaseline(first.observed, second.observed, third.observed) >= MIN_CHECK_OFFSET_M;
}

export function calibrationError(matrix: Matrix4, pair: CalibrationPair): number {
  return new Vector3(...pair.feature.point).applyMatrix4(matrix).distanceTo(new Vector3(...pair.observed));
}
