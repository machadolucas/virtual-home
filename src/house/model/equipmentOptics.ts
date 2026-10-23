import type { Placement, Vec3 } from "./types";
import { isSpotlightSymbol } from "./equipmentLight";

export const isLedBar = (symbol: string | null | undefined): boolean => symbol === "led_bar_vertical" || symbol === "led_bar_horizontal";
export const isDirectionalSymbol = (symbol: string | null | undefined): boolean => symbol === "security_camera" || symbol === "motion_sensor";
export const isAimableSymbol = (symbol: string | null | undefined): boolean => isSpotlightSymbol(symbol) || isDirectionalSymbol(symbol);
export const ledLength = (value: number | null | undefined): number => Number.isFinite(value) && value! >= 0.05 && value! <= 20 ? value! : 1;
export const detectionRange = (value: number | null | undefined, fallback = 5): number => Number.isFinite(value) && value! >= 0.1 && value! <= 30 ? value! : fallback;

export interface DetectionProfile {
  label: string;
  horizontalDeg: number;
  verticalDeg: number;
  rangeM: number;
  inferred: boolean;
}

/** Hue model IDs take precedence over placement: an outdoor sensor can be used indoors. */
export function detectionProfile(p: { symbol?: string | null; modelName?: string | null; roomId: string | null }): DetectionProfile {
  if (p.symbol !== "motion_sensor") return { label: "Illustrative camera", horizontalDeg: 60, verticalDeg: 60, rangeM: 5, inferred: false };
  const model = p.modelName?.toUpperCase() ?? "";
  const outdoor = /\bSML00[24]\b|9290019758|9290030674|HUE.*OUTDOOR|OUTDOOR.*SENSOR/.test(model);
  const indoor = /\bSML00[13]\b|9290012607|9290030675|HUE.*MOTION SENSOR/.test(model);
  const inferred = !outdoor && !indoor;
  return outdoor || (inferred && !p.roomId)
    ? { label: "Hue outdoor", horizontalDeg: 160, verticalDeg: 80, rangeM: 12, inferred }
    : { label: "Hue indoor", horizontalDeg: 100, verticalDeg: 100, rangeM: 5, inferred };
}

/** Elliptical field-of-view boundary, in local +Z, bounded by radial detection reach. */
export function detectionBoundary(profile: DetectionProfile, range: number, segments = 64): Vec3[] {
  const horizontal = Math.tan(profile.horizontalDeg * Math.PI / 360);
  const vertical = Math.tan(profile.verticalDeg * Math.PI / 360);
  return Array.from({ length: segments }, (_, i) => {
    const angle = i * 2 * Math.PI / segments;
    const x = horizontal * Math.cos(angle), y = vertical * Math.sin(angle);
    const scale = range / Math.hypot(x, y, 1);
    return [x * scale, y * scale, scale];
  });
}
export function showDetectionGuide(p: Pick<Placement, "symbol" | "lightAim" | "linkedEntities">): boolean {
  return p.symbol === "security_camera" || p.symbol === "motion_sensor";
}
export function ledSource(position: Vec3, symbol: string | null, lengthM: number, offsetY: number): Vec3 {
  return [position[0], position[1] + offsetY + (symbol === "led_bar_vertical" ? lengthM / 2 : 0), position[2]];
}
