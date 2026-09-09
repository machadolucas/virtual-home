/** Physical dimensions and roof-relative tilt for a solar-panel placement. */
export interface SolarPanelConfig {
  widthM: number;
  lengthM: number;
  thicknessM: number;
  tiltDeg: number;
}

export const DEFAULT_SOLAR_PANEL_CONFIG: Readonly<SolarPanelConfig> = Object.freeze({
  widthM: 1.1,
  lengthM: 1.8,
  thicknessM: 0.04,
  tiltDeg: 0,
});

/** Defensive validation for values read from the database's JSON column. */
export function isSolarPanelConfig(value: unknown): value is SolarPanelConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    typeof config.widthM === "number" &&
    Number.isFinite(config.widthM) &&
    config.widthM >= 0.1 &&
    config.widthM <= 10 &&
    typeof config.lengthM === "number" &&
    Number.isFinite(config.lengthM) &&
    config.lengthM >= 0.1 &&
    config.lengthM <= 10 &&
    typeof config.thicknessM === "number" &&
    Number.isFinite(config.thicknessM) &&
    config.thicknessM >= 0.005 &&
    config.thicknessM <= 1 &&
    typeof config.tiltDeg === "number" &&
    Number.isFinite(config.tiltDeg) &&
    config.tiltDeg >= -90 &&
    config.tiltDeg <= 90
  );
}

export function solarPanelConfigFromJson(value: string | null): SolarPanelConfig | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isSolarPanelConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
