import type { Vec3 } from "./types";

export interface LightAim {
  /** Rotation around site +Y. Zero points along +Z; +90 points along +X. */
  yawDeg: number;
  /** Elevation from horizontal. -90 points down; +90 points up. */
  pitchDeg: number;
}

export interface LightStateInput {
  entityId: string | null | undefined;
  state: string | null | undefined;
  brightness?: number | null;
  rgbColor?: readonly [number, number, number] | null;
  hsColor?: readonly [number, number] | null;
  colorTempKelvin?: number | null;
  colorTempMireds?: number | null;
  /** False when the HA stream is disconnected or this reading is stale. */
  live?: boolean;
}

export interface LightAppearance {
  /** HA brightness mapped to the inclusive 0..1 interval. */
  intensity: number;
  /** Normalized sRGB channels in the inclusive 0..1 interval. */
  color: Vec3;
}

const DOWN: LightAim = { yawDeg: 0, pitchDeg: -90 };
const UP: LightAim = { yawDeg: 0, pitchDeg: 90 };
/** A warm household bulb when HA exposes no colour capability/value. */
export const DEFAULT_LIGHT_COLOR_KELVIN = 2_700;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (radiansValue: number): number => (radiansValue * 180) / Math.PI;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function isLightEntity(entityId: string | null | undefined): boolean {
  return typeof entityId === "string" && entityId.startsWith("light.") && entityId.length > 6;
}

/** Default beam direction for a symbol with no explicitly saved aim. */
export function defaultLightAim(symbol: string | null | undefined): LightAim {
  return symbol === "spike_spot" ? { ...UP } : { ...DOWN };
}

/** Convert the persisted yaw/pitch pair to a normalized site-space direction. */
export function directionFromAim(aim: LightAim): Vec3 {
  const yaw = radians(aim.yawDeg);
  const pitch = radians(clamp(aim.pitchDeg, -90, 90));
  const horizontal = Math.cos(pitch);
  return [Math.sin(yaw) * horizontal, Math.sin(pitch), Math.cos(yaw) * horizontal];
}

/** Resolve an explicit aim, or the honest symbol default when one has not been recorded. */
export function lightDirection(
  symbol: string | null | undefined,
  aim: LightAim | null | undefined,
): Vec3 {
  return directionFromAim(aim ?? defaultLightAim(symbol));
}

/** Aim from one physical site-space point to another. */
export function aimFromTarget(origin: Vec3, target: Vec3): LightAim | null {
  const dx = target[0] - origin[0];
  const dy = target[1] - origin[1];
  const dz = target[2] - origin[2];
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0 && dy === 0) return null;
  return {
    yawDeg: degrees(Math.atan2(dx, dz)),
    pitchDeg: degrees(Math.atan2(dy, horizontal)),
  };
}

/**
 * Convert a normalized HA light state to scene-ready appearance. Non-light
 * domains and untrustworthy readings intentionally produce no emission.
 */
export function lightAppearance(input: LightStateInput): LightAppearance | null {
  if (!isLightEntity(input.entityId) || input.live === false) return null;
  if (input.state?.toLocaleLowerCase() !== "on") return null;

  const brightness = finite(input.brightness);
  const intensity = brightness === null ? 1 : clamp(brightness, 0, 255) / 255;
  const color =
    rgb(input.rgbColor) ??
    hs(input.hsColor) ??
    kelvin(input.colorTempKelvin) ??
    mireds(input.colorTempMireds) ??
    kelvin(DEFAULT_LIGHT_COLOR_KELVIN)!;

  return { intensity, color };
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rgb(value: readonly [number, number, number] | null | undefined): Vec3 | null {
  if (!value || value.some((channel) => !Number.isFinite(channel))) return null;
  return value.map((channel) => clamp(channel, 0, 255) / 255) as Vec3;
}

/** HA hs_color is HSV hue/saturation with value supplied separately as brightness. */
function hs(value: readonly [number, number] | null | undefined): Vec3 | null {
  if (!value || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) return null;
  const hue = ((value[0] % 360) + 360) % 360;
  const saturation = clamp(value[1], 0, 100) / 100;
  const chroma = saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  let channels: Vec3;
  if (section < 1) channels = [chroma, secondary, 0];
  else if (section < 2) channels = [secondary, chroma, 0];
  else if (section < 3) channels = [0, chroma, secondary];
  else if (section < 4) channels = [0, secondary, chroma];
  else if (section < 5) channels = [secondary, 0, chroma];
  else channels = [chroma, 0, secondary];
  const offset = 1 - chroma;
  return channels.map((channel) => channel + offset) as Vec3;
}

function mireds(value: number | null | undefined): Vec3 | null {
  const valid = finite(value);
  if (valid === null || valid <= 0) return null;
  return kelvin(1_000_000 / valid);
}

/** Approximate a black-body colour in sRGB; HA commonly reports 2,000–6,500 K. */
function kelvin(value: number | null | undefined): Vec3 | null {
  const valid = finite(value);
  if (valid === null || valid <= 0) return null;
  const temperature = clamp(valid, 1_000, 40_000) / 100;
  const red =
    temperature <= 66 ? 255 : 329.698727446 * Math.pow(temperature - 60, -0.1332047592);
  const green =
    temperature <= 66
      ? 99.4708025861 * Math.log(temperature) - 161.1195681661
      : 288.1221695283 * Math.pow(temperature - 60, -0.0755148492);
  const blue =
    temperature >= 66
      ? 255
      : temperature <= 19
        ? 0
        : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  return [red, green, blue].map((channel) => clamp(channel, 0, 255) / 255) as Vec3;
}
