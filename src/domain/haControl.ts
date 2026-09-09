import { z } from "zod";

export const HA_CONTROL_TTL_MS = 30_000;

export const haRgbColorSchema = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

export const haControlCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn_off") }).strict(),
  z
    .object({
      type: z.literal("turn_on"),
      brightness: z.number().int().min(0).max(255).optional(),
      colorTempKelvin: z.number().int().min(1_000).max(12_000).optional(),
      rgbColor: haRgbColorSchema.optional(),
    })
    .strict()
    .refine((value) => !(value.colorTempKelvin !== undefined && value.rgbColor !== undefined), {
      message: "Color temperature and RGB color cannot be sent together.",
    }),
]);

export type HaControlCommand = z.infer<typeof haControlCommandSchema>;
export type HaRgbColor = z.infer<typeof haRgbColorSchema>;

export interface HaControlCapabilities {
  brightness: boolean;
  colorTemperature: boolean;
  color: boolean;
  minKelvin: number | null;
  maxKelvin: number | null;
}

export interface HaControlEntity {
  registryId: string;
  entityId: string;
  name: string;
  state: string;
  available: boolean;
  capabilities: HaControlCapabilities;
  brightness: number | null;
  colorTempKelvin: number | null;
  rgbColor: HaRgbColor | null;
}

export interface EquipmentHaControlsResponse {
  connected: boolean;
  entities: HaControlEntity[];
}

function numberAttribute(attributes: Record<string, unknown>, key: string): number | null {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function colorModes(attributes: Record<string, unknown>): Set<string> {
  const raw = attributes.supported_color_modes;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((value): value is string => typeof value === "string"));
}

export function capabilitiesForEntity(
  domain: string,
  attributes: Record<string, unknown>,
): HaControlCapabilities {
  if (domain === "switch") {
    return {
      brightness: false,
      colorTemperature: false,
      color: false,
      minKelvin: null,
      maxKelvin: null,
    };
  }

  const modes = colorModes(attributes);
  const colorTemperature = modes.has("color_temp");
  const color = ["hs", "xy", "rgb", "rgbw", "rgbww"].some((mode) => modes.has(mode));
  const brightness = ["brightness", "color_temp", "hs", "xy", "rgb", "rgbw", "rgbww", "white"].some(
    (mode) => modes.has(mode),
  );
  return {
    brightness,
    colorTemperature,
    color,
    minKelvin: colorTemperature ? numberAttribute(attributes, "min_color_temp_kelvin") : null,
    maxKelvin: colorTemperature ? numberAttribute(attributes, "max_color_temp_kelvin") : null,
  };
}

export function assertSupportedCommand(
  domain: string,
  capabilities: HaControlCapabilities,
  command: HaControlCommand,
): string | null {
  if (domain !== "light" && domain !== "switch") return "entity_domain";
  if (command.type === "turn_off") return null;
  if (domain === "switch" && Object.keys(command).length > 1) return "switch_options";
  if (command.brightness !== undefined && !capabilities.brightness) return "brightness";
  if (command.colorTempKelvin !== undefined) {
    if (!capabilities.colorTemperature) return "color_temperature";
    if (capabilities.minKelvin !== null && command.colorTempKelvin < capabilities.minKelvin)
      return "color_temperature_range";
    if (capabilities.maxKelvin !== null && command.colorTempKelvin > capabilities.maxKelvin)
      return "color_temperature_range";
  }
  if (command.rgbColor !== undefined && !capabilities.color) return "color";
  return null;
}

export function serviceCallForCommand(command: HaControlCommand): {
  service: "turn_on" | "turn_off";
  serviceData?: Record<string, unknown>;
} {
  if (command.type === "turn_off") return { service: "turn_off" };
  const serviceData: Record<string, unknown> = {};
  if (command.brightness !== undefined) serviceData.brightness = command.brightness;
  if (command.colorTempKelvin !== undefined)
    serviceData.color_temp_kelvin = command.colorTempKelvin;
  if (command.rgbColor !== undefined) serviceData.rgb_color = command.rgbColor;
  return Object.keys(serviceData).length > 0
    ? { service: "turn_on", serviceData }
    : { service: "turn_on" };
}
