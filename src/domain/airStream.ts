export const EXTERIOR_AIR_STREAMS = ["outdoor_intake", "outdoor_discharge"] as const;
export type ExteriorAirStream = (typeof EXTERIOR_AIR_STREAMS)[number];

export const AIR_STREAMS = ["outdoor_intake", "room_supply", "room_extract", "outdoor_discharge"] as const;
export type AirStream = (typeof AIR_STREAMS)[number];

export const AIR_STREAM_STYLE: Record<AirStream, { label: string; body: number; pulse: number }> = {
  outdoor_intake: { label: "Outdoor air intake", body: 0x00b9bb, pulse: 0xa2faf2 },
  room_supply: { label: "Room supply", body: 0x63a63c, pulse: 0xcafa83 },
  room_extract: { label: "Room extract", body: 0xc8861b, pulse: 0xffe08a },
  outdoor_discharge: { label: "Outdoor exhaust", body: 0x8759c7, pulse: 0xdcc4ff },
};

export function airStreamFitsMedium(stream: ExteriorAirStream, medium: string | undefined): boolean {
  return (stream === "outdoor_intake" && medium === "supply_air") ||
    (stream === "outdoor_discharge" && medium === "extract_air");
}

export function classifyAirStream(
  medium?: string,
  exterior?: ExteriorAirStream | null,
): AirStream | undefined {
  if (exterior && airStreamFitsMedium(exterior, medium)) return exterior;
  if (medium === "supply_air") return "room_supply";
  if (medium === "extract_air") return "room_extract";
  return undefined;
}
