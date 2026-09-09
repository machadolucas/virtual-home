import type { Placement, Vec3 } from "./types";
import { isSpotlightSymbol } from "./equipmentLight";

export const isLedBar = (symbol: string | null | undefined): boolean => symbol === "led_bar_vertical" || symbol === "led_bar_horizontal";
export const isDirectionalSymbol = (symbol: string | null | undefined): boolean => symbol === "security_camera" || symbol === "motion_sensor";
export const isAimableSymbol = (symbol: string | null | undefined): boolean => isSpotlightSymbol(symbol) || isDirectionalSymbol(symbol);
export const ledLength = (value: number | null | undefined): number => Number.isFinite(value) && value! >= 0.05 && value! <= 20 ? value! : 1;
export const detectionRange = (value: number | null | undefined): number => Number.isFinite(value) && value! >= 0.1 && value! <= 30 ? value! : 5;
export function showDetectionGuide(p: Pick<Placement, "symbol" | "lightAim" | "linkedEntities">): boolean {
  return p.symbol === "security_camera" || p.symbol === "motion_sensor";
}
export function ledSource(position: Vec3, symbol: string | null, lengthM: number, offsetY: number): Vec3 {
  return [position[0], position[1] + offsetY + (symbol === "led_bar_vertical" ? lengthM / 2 : 0), position[2]];
}
