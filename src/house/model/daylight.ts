import { daysBetweenLocal, formatLocalDate, instantOf, localDateOf, parseLocalDate } from "@/domain/time";
import type { Vec3 } from "./types";

export interface SolarPosition {
  /** Degrees above the astronomical horizon. Negative values put the sun below it. */
  elevationDeg: number;
  /** Degrees clockwise from true north: east is 90, south is 180. */
  azimuthDeg: number;
  /** Unit vector from the model origin towards the sun, in the model's Y-up frame. */
  direction: Vec3;
}

export interface DaylightAppearance {
  skyColor: string;
  groundColor: string;
  ambientIntensity: number;
  sunIntensity: number;
  sunColor: string;
  /** A low, illustrative blue fill after dark. This does not model the moon's position or phase. */
  nightFillIntensity: number;
}

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Approximate solar position for an instant and geographic coordinate.
 *
 * The declination and equation-of-time series are NOAA's low-accuracy equations:
 * https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 *
 * Longitude is positive east of Greenwich. `northBearingDeg` follows the model contract: true
 * north measured clockwise from model -Z towards +X. The returned vector points towards the sun,
 * which makes it suitable for positioning a directional-light source around the model.
 */
export function solarPosition(
  epochMs: number,
  latitude: number,
  longitude: number,
  northBearingDeg = 0,
): SolarPosition {
  assertFinite("epochMs", epochMs);
  assertFinite("latitude", latitude);
  assertFinite("longitude", longitude);
  assertFinite("northBearingDeg", northBearingDeg);
  if (latitude < -90 || latitude > 90) throw new RangeError("latitude must be between -90 and 90");

  const instant = new Date(epochMs);
  if (Number.isNaN(instant.getTime())) throw new RangeError("epochMs must be a valid instant");

  // Calendar boundaries belong to the shared time domain; the solar equations use UTC.
  const date = localDateOf(epochMs, "UTC");
  const { year } = parseLocalDate(date);
  const yearStart = formatLocalDate(year, 1, 1);
  const dayOfYear = daysBetweenLocal(yearStart, date) + 1;
  const minutesUtc = (epochMs - instantOf(date, "00:00", "UTC")) / 60_000;
  const fractionalHourUtc = minutesUtc / 60;
  const daysInYear = daysBetweenLocal(yearStart, formatLocalDate(year + 1, 1, 1));
  const gamma = (2 * Math.PI * (dayOfYear - 1 + (fractionalHourUtc - 12) / 24)) / daysInYear;

  const equationOfTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  // Working in UTC makes NOAA's timezone correction zero. Positive longitude advances solar time.
  const trueSolarMinutes = modulo(minutesUtc + equationOfTimeMinutes + 4 * longitude, 1_440);
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG_TO_RAD;
  const latitudeRad = latitude * DEG_TO_RAD;
  const cosZenith = clamp(
    Math.sin(latitudeRad) * Math.sin(declination) +
      Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle),
    -1,
    1,
  );
  const elevationRad = Math.asin(cosZenith);

  // atan2 avoids the east/west ambiguity of the arccos form in NOAA's reference sheet.
  const azimuthRad = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(latitudeRad) - Math.tan(declination) * Math.cos(latitudeRad),
  );
  const azimuthDeg = modulo(azimuthRad * RAD_TO_DEG + 180, 360);
  const elevationDeg = elevationRad * RAD_TO_DEG;

  const modelBearing = (azimuthDeg + northBearingDeg) * DEG_TO_RAD;
  const horizontal = Math.cos(elevationRad);
  return {
    elevationDeg,
    azimuthDeg,
    direction: [
      horizontal * Math.sin(modelBearing),
      Math.sin(elevationRad),
      -horizontal * Math.cos(modelBearing),
    ],
  };
}

/**
 * A restrained lighting palette across night, twilight, sunrise and daytime. Values are intended
 * as scene-light inputs rather than photometric measurements. They remain usable at night while
 * leaving household lights visually meaningful.
 */
export function daylightAppearance(elevationDeg: number): DaylightAppearance {
  assertFinite("elevationDeg", elevationDeg);
  const stops: ReadonlyArray<{ elevation: number; value: DaylightAppearance }> = [
    {
      elevation: -12,
      value: appearance("#7187ad", "#56647a", 0.28, 0, "#829bc4", 0.16),
    },
    {
      elevation: -6,
      value: appearance("#788eaf", "#646b7b", 0.30, 0, "#94aad0", 0.10),
    },
    {
      elevation: 0,
      value: appearance("#9890ac", "#7b7580", 0.34, 0.12, "#ff9b68", 0.035),
    },
    {
      elevation: 8,
      value: appearance("#b9cee0", "#8a887b", 0.5, 0.72, "#ffd09a", 0),
    },
    {
      elevation: 35,
      value: appearance("#dbe9f4", "#b8b8aa", 0.72, 1.05, "#fff0d5", 0),
    },
    {
      elevation: 70,
      value: appearance("#e7f1f8", "#c6c5b7", 0.78, 1.15, "#fff8e8", 0),
    },
  ];

  if (elevationDeg <= stops[0]!.elevation) return { ...stops[0]!.value };
  const last = stops[stops.length - 1]!;
  if (elevationDeg >= last.elevation) return { ...last.value };

  for (let index = 1; index < stops.length; index += 1) {
    const upper = stops[index]!;
    if (elevationDeg > upper.elevation) continue;
    const lower = stops[index - 1]!;
    const amount = (elevationDeg - lower.elevation) / (upper.elevation - lower.elevation);
    return interpolateAppearance(lower.value, upper.value, amount);
  }
  return { ...last.value };
}

function appearance(
  skyColor: string,
  groundColor: string,
  ambientIntensity: number,
  sunIntensity: number,
  sunColor: string,
  nightFillIntensity: number,
): DaylightAppearance {
  return { skyColor, groundColor, ambientIntensity, sunIntensity, sunColor, nightFillIntensity };
}

function interpolateAppearance(
  from: DaylightAppearance,
  to: DaylightAppearance,
  amount: number,
): DaylightAppearance {
  return {
    skyColor: interpolateHex(from.skyColor, to.skyColor, amount),
    groundColor: interpolateHex(from.groundColor, to.groundColor, amount),
    ambientIntensity: mix(from.ambientIntensity, to.ambientIntensity, amount),
    sunIntensity: mix(from.sunIntensity, to.sunIntensity, amount),
    sunColor: interpolateHex(from.sunColor, to.sunColor, amount),
    nightFillIntensity: mix(from.nightFillIntensity, to.nightFillIntensity, amount),
  };
}

function interpolateHex(from: string, to: string, amount: number): string {
  const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16);
  const result = [1, 3, 5].map((offset) =>
    Math.round(mix(channel(from, offset), channel(to, offset), amount))
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${result.join("")}`;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}
